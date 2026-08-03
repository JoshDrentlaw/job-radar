/** @jsxImportSource hono/jsx */

/**
 * Bearer tokens for n8n (§11: "Rotatable from the UI").
 *
 * The plaintext is shown exactly once, on the response that creates it, and is
 * never recoverable — only its SHA-256 is stored. Rotation is therefore
 * create-then-revoke: mint the new one, paste it into n8n, revoke the old one,
 * with no window where the scheduler has no working credential.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { CsrfField, formatDateTime, Notice, relativeAge } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import type { ApiToken } from "@auth/api-token.ts";

const TokensPage: FC<{
  tokens: readonly ApiToken[];
  baseUrl: string;
  issued?: string;
  csrfToken: string;
  now: Date;
  notice?: string;
  error?: string;
}> = (props) => {
  const active = props.tokens.filter((token) => token.revokedAt === null);
  const revoked = props.tokens.filter((token) => token.revokedAt !== null);

  return (
    <Layout title="Automation" current="automation" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>Automation</h1>
          <p class="lede">
            n8n owns the schedule; this app owns the work (§12). These tokens authenticate the job
            endpoints and reach nothing else — they cannot sign in, read a posting, or touch the
            dossier.
          </p>
        </div>
      </div>

      {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
      {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}

      {props.issued !== undefined && (
        <section class="panel stack">
          <header>
            <h2>Your new token</h2>
          </header>
          <Notice kind="warn">
            This is the only time it is shown. Only a hash is stored, so it cannot be recovered —
            copy it into n8n now. If you lose it, revoke it and mint another.
          </Notice>
          <input type="text" readonly value={props.issued} class="copy-value token-reveal" />
        </section>
      )}

      <section class="panel">
        <header>
          <h2>Endpoints</h2>
        </header>
        <p class="panel-note">
          Each returns a JSON summary. <strong>200</strong> clean, <strong>207</strong>{" "}
          partial — the run finished but something in it failed or is unfinished —{" "}
          <strong>500</strong>{" "}
          the run itself failed. Branch on that rather than treating it as binary, so a single bad
          board degrades the run instead of ending it.
        </p>
        <div class="table-scroll gap-above">
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>POST</td>
                <td>
                  <code>/api/jobs/collect</code>
                </td>
                <td>Fetch all active boards, diff, store</td>
              </tr>
              <tr>
                <td>POST</td>
                <td>
                  <code>/api/jobs/embed</code>
                </td>
                <td>Drain the embedding queue (207 while a backlog remains)</td>
              </tr>
              <tr>
                <td>POST</td>
                <td>
                  <code>/api/jobs/match</code>
                </td>
                <td>Score new and changed postings</td>
              </tr>
              <tr>
                <td>GET</td>
                <td>
                  <code>/api/jobs/digest?since=…</code>
                </td>
                <td>New matches since a timestamp, plus what could not be read</td>
              </tr>
              <tr>
                <td>POST</td>
                <td>
                  <code>/api/jobs/sweep</code>
                </td>
                <td>Mark applications ghosted once silence passes the window</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="field-hint gap-above">
          Base URL <code>{props.baseUrl}</code>. Authenticate with{" "}
          <code>Authorization: Bearer &lt;token&gt;</code>.
        </p>
      </section>

      <section class="panel stack">
        <header>
          <h2>Mint a token</h2>
        </header>
        <p class="panel-note">
          To rotate: mint the new one, paste it into n8n, then revoke the old one — the scheduler is
          never left without a working credential.
        </p>
        <form method="post" action="/automation/tokens" class="row">
          <CsrfField token={props.csrfToken} />
          <input type="text" name="label" placeholder="n8n production" required maxlength={80} />
          <button type="submit" class="primary">Mint</button>
        </form>
      </section>

      <section class="panel">
        <header>
          <h2>Active tokens</h2>
          <span class="chip">{active.length}</span>
        </header>
        {active.length === 0
          ? <p class="empty">No active tokens — the job endpoints reject every caller.</p>
          : (
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Token</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((token) => (
                    <tr key={token.id}>
                      <td>{token.label}</td>
                      <td>
                        <code>{token.tokenPrefix}…</code>
                      </td>
                      <td title={formatDateTime(token.createdAt)}>
                        {relativeAge(token.createdAt, props.now)}
                      </td>
                      <td>
                        {token.lastUsedAt === null
                          ? <span class="chip muted">never</span>
                          : (
                            <span title={formatDateTime(token.lastUsedAt)}>
                              {relativeAge(token.lastUsedAt, props.now)}
                            </span>
                          )}
                      </td>
                      <td>
                        <form
                          method="post"
                          action={`/automation/tokens/${token.id}/revoke`}
                          class="inline-form"
                        >
                          <CsrfField token={props.csrfToken} />
                          <button type="submit" class="quiet danger-text">Revoke</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      {revoked.length > 0 && (
        <section class="panel">
          <details>
            <summary>
              <h2>Revoked ({revoked.length})</h2>
            </summary>
            <p class="panel-note">
              Kept so a token that was in use somewhere stays identifiable after the fact.
            </p>
            <div class="table-scroll gap-above">
              <table>
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Token</th>
                    <th>Last used</th>
                    <th>Revoked</th>
                  </tr>
                </thead>
                <tbody>
                  {revoked.map((token) => (
                    <tr key={token.id}>
                      <td>{token.label}</td>
                      <td>
                        <code>{token.tokenPrefix}…</code>
                      </td>
                      <td>
                        {token.lastUsedAt === null ? "never" : formatDateTime(token.lastUsedAt)}
                      </td>
                      <td>{formatDateTime(token.revokedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
    </Layout>
  );
};

export const tokenRoutes = new Hono<AppEnv>();

tokenRoutes.get("/automation", async (c) => {
  const services = c.get("services");
  const tokens = await services.apiTokens.list();
  const issued = c.req.query("issued");
  const notice = c.req.query("notice");
  const error = c.req.query("error");
  return c.html(
    <TokensPage
      tokens={tokens}
      baseUrl={c.get("config").baseUrl}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
      {...(issued !== undefined ? { issued } : {})}
      {...(notice !== undefined ? { notice } : {})}
      {...(error !== undefined ? { error } : {})}
    />,
  );
});

tokenRoutes.post("/automation/tokens", async (c) => {
  const body = await c.req.parseBody();
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (label === "") {
    return c.redirect("/automation?error=Give+the+token+a+label.", 303);
  }
  const { plaintext } = await c.get("services").apiTokens.issue(label);
  c.get("logger").info("api token issued", { label });
  // Once, in a redirect the user is already looking at. It is never stored, so
  // this is the only moment it exists outside n8n's credential store.
  return c.redirect(`/automation?issued=${encodeURIComponent(plaintext)}`, 303);
});

tokenRoutes.post("/automation/tokens/:id/revoke", async (c) => {
  await c.get("services").apiTokens.revoke(c.req.param("id") ?? "");
  return c.redirect("/automation?notice=Token+revoked.", 303);
});
