/**
 * Generates real WebAuthn ceremony payloads by driving Chromium's virtual
 * authenticator over CDP. The output is saved as fixtures so the verifier is
 * tested against bytes a browser actually produced, never bytes we invented.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });

const PAGE = `<!doctype html><meta charset="utf-8"><title>fixture</title><body>ready</body>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const origin = `http://localhost:${port}`;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await page.goto(origin);

await cdp.send("WebAuthn.enable", { enableUI: false });

async function run(options) {
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: options.transport ?? "internal",
      hasResidentKey: options.userVerified !== false,
      hasUserVerification: options.userVerified ?? true,
      isUserVerified: options.userVerified ?? true,
      automaticPresenceSimulation: true,
      ...(options.defaultBackupEligibility === undefined ? {} : {
        defaultBackupEligibility: options.defaultBackupEligibility,
        defaultBackupState: options.defaultBackupState ?? false,
      }),
    },
  });

  const result = await page.evaluate(async ({ alg, regChallenge, authChallenge, userId, uv }) => {
    const b64u = (buf) => {
      const bytes = new Uint8Array(buf);
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    };
    const fromB64u = (v) => {
      const padded = v.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - (v.length % 4)) % 4);
      return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    };

    const created = await navigator.credentials.create({
      publicKey: {
        challenge: fromB64u(regChallenge),
        rp: { id: location.hostname, name: "Job Radar" },
        user: { id: fromB64u(userId), name: "owner", displayName: "owner" },
        pubKeyCredParams: [{ type: "public-key", alg }],
        attestation: "none",
        authenticatorSelection: {
          residentKey: uv === "required" ? "required" : "discouraged",
          requireResidentKey: uv === "required",
          userVerification: uv,
        },
      },
    });

    const registration = {
      id: created.id,
      rawId: b64u(created.rawId),
      clientDataJSON: b64u(created.response.clientDataJSON),
      attestationObject: b64u(created.response.attestationObject),
      transports: created.response.getTransports ? created.response.getTransports() : [],
    };

    const got = await navigator.credentials.get({
      publicKey: {
        challenge: fromB64u(authChallenge),
        rpId: location.hostname,
        userVerification: uv,
        ...(uv === "required"
          ? {}
          : { allowCredentials: [{ type: "public-key", id: created.rawId }] }),
      },
    });

    const authentication = {
      id: got.id,
      rawId: b64u(got.rawId),
      clientDataJSON: b64u(got.response.clientDataJSON),
      authenticatorData: b64u(got.response.authenticatorData),
      signature: b64u(got.response.signature),
      userHandle: got.response.userHandle === null ? null : b64u(got.response.userHandle),
    };

    return { registration, authentication };
  }, {
    alg: options.alg,
    regChallenge: options.regChallenge,
    authChallenge: options.authChallenge,
    userId: options.userId,
    uv: options.userVerified === false ? "discouraged" : "required",
  });

  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });

  return {
    note: options.note,
    algorithm: options.alg,
    origin,
    rpId: "localhost",
    registrationChallenge: options.regChallenge,
    authenticationChallenge: options.authChallenge,
    userHandle: options.userId,
    ...result,
  };
}

// The user handle is base64url of the UTF-8 user id, matching userHandleFor().
const USER_ID = Buffer.from("018f2a44-3f6c-7c1e-9b3a-2f4c5d6e7a8b", "utf8").toString("base64url");

const es256 = await run({
  note: "ES256 (-7), the algorithm every platform authenticator supports",
  alg: -7,
  regChallenge: "Q2hhbGxlbmdlRm9yUmVnaXN0cmF0aW9uRVMyNTY",
  authChallenge: "Q2hhbGxlbmdlRm9yQXV0aGVudGljYXRpb25FUzI1Ng",
  userId: USER_ID,
  defaultBackupEligibility: true,
  defaultBackupState: true,
});
writeFileSync(`${OUT}/es256.json`, JSON.stringify(es256, null, 2) + "\n");

const rs256 = await run({
  note: "RS256 (-257), the TPM-backed case",
  alg: -257,
  regChallenge: "Q2hhbGxlbmdlRm9yUmVnaXN0cmF0aW9uUlMyNTY",
  authChallenge: "Q2hhbGxlbmdlRm9yQXV0aGVudGljYXRpb25SUzI1Ng",
  userId: USER_ID,
  transport: "usb",
});
writeFileSync(`${OUT}/rs256.json`, JSON.stringify(rs256, null, 2) + "\n");

// An authenticator that only proves presence, never identity. Must be refused.
const noUv = await run({
  note: "ES256 with user verification not performed — must be rejected",
  alg: -7,
  regChallenge: "Q2hhbGxlbmdlRm9yUmVnaXN0cmF0aW9uTm9VVg",
  authChallenge: "Q2hhbGxlbmdlRm9yQXV0aGVudGljYXRpb25Ob1VW",
  userId: USER_ID,
  userVerified: false,
});
writeFileSync(`${OUT}/no-user-verification.json`, JSON.stringify(noUv, null, 2) + "\n");

await browser.close();
server.close();
console.log("wrote fixtures to", OUT);
