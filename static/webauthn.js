/**
 * The only client-side script in this application (§3).
 *
 * It exists because WebAuthn cannot be done any other way: `navigator.credentials`
 * is a browser API, and no amount of server rendering reaches it. Everything
 * else here — every form, every page — works with scripting turned off, and so
 * does this page: the passkey controls ship hidden and this file is what
 * reveals them. No script, no passkey button, and the password form is right
 * there.
 *
 * It talks JSON to endpoints that do all the deciding. Nothing is trusted to
 * this side; it only moves bytes between the server and the authenticator.
 *
 * (Deno's linter is not run over this file — it lints for a server runtime
 * where `window` does not exist, which is the opposite of the target here.)
 */
"use strict";

(() => {
  const toBytes = (value) => {
    let padded = value.replace(/-/g, "+").replace(/_/g, "/");
    while (padded.length % 4 !== 0) padded += "=";
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const toBase64Url = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  const post = async (url, csrf, body) => {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body || {}),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = { error: "The server sent something unreadable." };
    }
    if (!response.ok) throw new Error(payload.error || "Something went wrong.");
    return payload;
  };

  const say = (node, message, kind) => {
    if (!node) return;
    node.textContent = message;
    node.className = "notice " + (kind || "warn");
    node.hidden = message === "";
  };

  /** How a cancelled prompt is told apart from a genuine failure. */
  const explain = (error, fallback) => {
    if (error && error.name === "NotAllowedError") return null;
    return error && error.message ? error.message : fallback;
  };

  // The browser decides whether any of this is possible at all.
  const supported = typeof window.PublicKeyCredential === "function" &&
    typeof navigator.credentials === "object";

  /* -------------------------------------------------- signing in ---------- */

  const signIn = document.querySelector("[data-passkey-signin]");
  if (signIn && supported) {
    const status = document.querySelector("[data-passkey-status]");
    signIn.hidden = false;

    signIn.addEventListener("click", async () => {
      const csrf = signIn.getAttribute("data-csrf") || "";
      signIn.disabled = true;
      say(status, "", "warn");

      try {
        const options = await post("/login/passkey/options", csrf);
        options.challenge = toBytes(options.challenge);
        if (options.allowCredentials) {
          options.allowCredentials = options.allowCredentials.map((credential) => ({
            ...credential,
            id: toBytes(credential.id),
          }));
        }

        const assertion = await navigator.credentials.get({ publicKey: options });
        const result = await post("/login/passkey", csrf, {
          credentialId: assertion.id,
          clientDataJSON: toBase64Url(assertion.response.clientDataJSON),
          authenticatorData: toBase64Url(assertion.response.authenticatorData),
          signature: toBase64Url(assertion.response.signature),
          userHandle: assertion.response.userHandle
            ? toBase64Url(assertion.response.userHandle)
            : null,
          next: signIn.getAttribute("data-next") || "/",
        });
        window.location.assign(result.redirect || "/");
      } catch (error) {
        signIn.disabled = false;
        const message = explain(error, "Passkey sign-in failed.");
        if (message === null) say(status, "Passkey sign-in was cancelled.", "warn");
        else say(status, message, "error");
      }
    });
  }

  /* -------------------------------------------------- registering --------- */

  const register = document.querySelector("[data-passkey-register]");
  if (register) {
    const status = document.querySelector("[data-passkey-register-status]");
    const unsupported = document.querySelector("[data-passkey-unsupported]");

    if (!supported) {
      if (unsupported) unsupported.hidden = false;
    } else {
      register.hidden = false;
      register.addEventListener("click", async () => {
        const csrf = register.getAttribute("data-csrf") || "";
        const labelField = document.querySelector("[data-passkey-label]");
        register.disabled = true;
        say(status, "", "warn");

        try {
          const options = await post("/account/passkeys/options", csrf);
          options.challenge = toBytes(options.challenge);
          options.user.id = toBytes(options.user.id);
          options.excludeCredentials = (options.excludeCredentials || []).map((credential) => ({
            ...credential,
            id: toBytes(credential.id),
          }));

          const credential = await navigator.credentials.create({ publicKey: options });
          await post("/account/passkeys", csrf, {
            label: labelField ? labelField.value : "",
            credentialId: credential.id,
            clientDataJSON: toBase64Url(credential.response.clientDataJSON),
            attestationObject: toBase64Url(credential.response.attestationObject),
            transports: credential.response.getTransports
              ? credential.response.getTransports()
              : [],
          });
          window.location.assign("/account?notice=passkey-added");
        } catch (error) {
          register.disabled = false;
          if (error && error.name === "InvalidStateError") {
            say(status, "This device already has a passkey for Job Radar.", "warn");
            return;
          }
          const message = explain(error, "Could not register that device.");
          if (message === null) say(status, "Registration was cancelled.", "warn");
          else say(status, message, "error");
        }
      });
    }
  }
})();
