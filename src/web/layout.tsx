/** @jsxImportSource hono/jsx */

/**
 * Page shell. Server-rendered, no client JS (§3) — the CSP forbids inline
 * scripts and M0/M1 need none.
 */

import type { FC, PropsWithChildren } from "hono/jsx";

export interface LayoutProps {
  readonly title: string;
  /** Highlights the matching nav item. */
  readonly current?:
    | "dashboard"
    | "boards"
    | "postings"
    | "matches"
    | "profile"
    | "dossier"
    | "applications"
    | "automation"
    | "account"
    | "tuning"
    | "coverage";
  readonly csrfToken?: string;
}

const NAV = [
  { key: "dashboard", href: "/", label: "Dashboard" },
  { key: "boards", href: "/boards", label: "Boards" },
  { key: "postings", href: "/postings", label: "Postings" },
  { key: "matches", href: "/matches", label: "Matches" },
  { key: "profile", href: "/profile", label: "Profile" },
  { key: "dossier", href: "/dossier", label: "Dossier" },
  { key: "tuning", href: "/tuning", label: "Tuning" },
  { key: "applications", href: "/applications", label: "Applications" },
  { key: "coverage", href: "/coverage", label: "Coverage" },
  { key: "automation", href: "/automation", label: "Automation" },
  { key: "account", href: "/account", label: "Account" },
] as const;

export const Layout: FC<PropsWithChildren<LayoutProps>> = (props) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <title>{props.title} · Job Radar</title>
      <link rel="stylesheet" href="/static/app.css" />
      <link
        rel="icon"
        href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='none' stroke='%232f6fd0' stroke-width='1.5'/%3E%3Ccircle cx='8' cy='8' r='2' fill='%232f6fd0'/%3E%3C/svg%3E"
      />
    </head>
    <body>
      <header class="masthead">
        <div class="masthead-inner">
          <a class="wordmark" href="/">Job Radar</a>
          <nav aria-label="Primary">
            {NAV.map((item) => (
              <a
                href={item.href}
                {...(props.current === item.key ? { "aria-current": "page" } : {})}
              >
                {item.label}
              </a>
            ))}
          </nav>
          {props.csrfToken !== undefined && (
            <form method="post" action="/logout" class="inline-form">
              <input type="hidden" name="_csrf" value={props.csrfToken} />
              <button type="submit" class="quiet">Sign out</button>
            </form>
          )}
        </div>
      </header>
      <main>{props.children}</main>
    </body>
  </html>
);

/** The login page has no navigation and no session to sign out of. */
export const BareLayout: FC<PropsWithChildren<{ title: string }>> = (props) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <title>{props.title} · Job Radar</title>
      <link rel="stylesheet" href="/static/app.css" />
    </head>
    <body>
      <div class="login-shell">{props.children}</div>
    </body>
  </html>
);
