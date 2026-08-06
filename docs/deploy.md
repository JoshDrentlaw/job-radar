# Deploying Job Radar

A runbook for the first deploy onto a single Ubuntu droplet, and for every deploy after it. Written
for Ubuntu 24.04 LTS; other versions differ mainly in the Postgres package name.

The shape (§13): the app binds **localhost only** and a reverse proxy terminates TLS in front of it.
Nothing but the proxy can reach the app, and nothing but the app can reach the database. nginx and
Caddy are both covered in step 8; the app does not care which.

## Decide the hostname first

Everything below is parameterised on one value, and one of them is **effectively permanent**:

```bash
DOMAIN=jobs.example.com          # yours
```

A passkey is cryptographically bound to the hostname it was registered at — that is the whole reason
it cannot be phished. The relying-party id comes from `APP_BASE_URL`, so **moving the app to a
different hostname later invalidates every registered passkey.** The password still works, so this
is recoverable, not fatal; but pick the hostname you intend to keep.

Point an `A` record at the droplet's IP before starting, so the certificate step has something to
verify.

## 1. A user that is not root

```bash
ssh root@$DOMAIN

adduser --system --group --home /opt/job-radar --shell /usr/sbin/nologin jobradar
```

A system account with no shell: nothing signs in as it, systemd just runs as it.

## 2. Firewall and updates

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

apt-get update
apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

Port numbers rather than ufw's named application profiles, deliberately. A profile like
`'Nginx Full'` is a file dropped into `/etc/ufw/applications.d/` **by the nginx package**, so it
does not exist until step 8 and `ufw allow 'Nginx Full'` fails here with a profile-not-found error.
Ports have no such ordering dependency, and the firewall should be closed before anything is
listening rather than after.

(Once nginx is installed you can use the profiles if you prefer — `ufw app list` shows what is
available. They resolve to the same two ports.)

Port 8000 is deliberately **not** opened. The app is not meant to be reachable except through nginx.

## 3. Postgres 16 with pgvector

```bash
apt-get install -y postgresql-16 postgresql-16-pgvector

sudo -u postgres psql <<'SQL'
CREATE USER jobradar WITH PASSWORD 'CHANGE-ME-TO-SOMETHING-LONG';
CREATE DATABASE jobradar OWNER jobradar;
SQL
```

`postgresql-16-pgvector` is not optional — migration `0004` creates the `vector` extension and the
deploy stops there without it.

The extension is created by the migration, which needs the privilege to do so. Either let the
migration run once as a superuser, or create the extension by hand now and let the migration find it
already there:

```bash
sudo -u postgres psql -d jobradar -c 'CREATE EXTENSION IF NOT EXISTS vector'
```

The second is tidier: the application role never needs superuser.

Postgres listens on `127.0.0.1:5432` by default on Ubuntu, which is what the app's permission
allowlist expects. Leave it there.

## 4. Deno

```bash
curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s v2.9.4
deno --version
```

Pinned, like every other dependency. Upgrading Deno is a deliberate act.

## 5. The code

```bash
install -d -o jobradar -g jobradar /opt/job-radar
cd /opt/job-radar
sudo -u jobradar git clone https://github.com/JoshDrentlaw/job-radar.git .
```

A public repo clones over HTTPS with no key. For a private one, add a **deploy key** (read-only,
repo-scoped) rather than reusing your personal key.

Warm the dependency cache now, so the first boot is a start rather than a download, and so a network
problem surfaces here instead of looking like an application failure:

```bash
sudo -u jobradar env DENO_DIR=/opt/job-radar/.deno /usr/local/bin/deno install --frozen
```

`--frozen` is the same gate CI uses: it fails if `deno.lock` does not match what the code actually
imports.

## 6. Configuration

Secrets come from the environment, never the database and never the repo (§11).

```bash
cat > /etc/job-radar.env <<EOF
DATABASE_URL=postgres://jobradar:CHANGE-ME-TO-SOMETHING-LONG@127.0.0.1:5432/jobradar
APP_ENV=production
APP_BASE_URL=https://$DOMAIN
HOST=127.0.0.1
PORT=8000
CONTACT_URL=https://github.com/JoshDrentlaw/job-radar
LOG_LEVEL=info

# Optional. Without them the app runs and the relevant pages say what is
# unavailable, rather than failing.
VOYAGE_API_KEY=
ANTHROPIC_API_KEY=
EOF

chown root:jobradar /etc/job-radar.env
chmod 640 /etc/job-radar.env
```

Three things that will bite if changed casually:

- **`APP_ENV=production` requires an `https://` `APP_BASE_URL`.** The app refuses to start
  otherwise. Production also sets `Secure` on the session cookie, so **the app is unusable over
  plain HTTP** — that is deliberate, and it means TLS has to work before you can sign in.
- **`PORT` must be free.** A droplet often has something else on 8000 already; if it does, the
  service crash-loops with `AddrInUse` and nothing else in the log is wrong. Check before you write
  the file, and pick anything unused — nginx is what the world talks to, so the number is private:

  ```bash
  ss -tlnp | grep -E ':(8000|8010)\b' || echo "both free"
  ```

  Whatever you choose, use the same number in the nginx `proxy_pass` at step 8.
- **`HOST` must stay `127.0.0.1`.** The permission allowlist grants network access to that address
  and no other, so binding `0.0.0.0` fails outright rather than quietly exposing the app. That is
  the allowlist enforcing the architecture.
- **`EMBEDDING_MODEL` is not a casual setting.** It is recorded on every stored vector and every
  consumer filters by it, so changing it re-embeds the whole corpus and rescores everything — at
  your expense.

## 7. The service

```bash
cat > /etc/systemd/system/job-radar.service <<'EOF'
[Unit]
Description=Job Radar
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=jobradar
Group=jobradar
WorkingDirectory=/opt/job-radar
EnvironmentFile=/etc/job-radar.env
# The app's --allow-read paths are relative to WorkingDirectory, and Deno needs
# somewhere of its own to cache dependencies.
Environment=DENO_DIR=/opt/job-radar/.deno
ExecStart=/usr/local/bin/deno task start
Restart=on-failure
RestartSec=5s

# The app needs to read its own directory and talk to localhost. Nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/job-radar/.deno
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now job-radar
systemctl status job-radar --no-pager
```

**Migrations run at boot.** A single-user app on one droplet has no rolling deploy to coordinate
with, and a schema that silently lags the code is the worse failure. The first start applies all
ten.

Check it came up:

```bash
curl -s localhost:8000/healthz     # {"status":"ok"} — use your PORT if you changed it
journalctl -u job-radar -n 50 --no-pager
```

Two warnings on a fresh boot are expected and correct: no embedding key, no Anthropic key, and
`no admin account exists`.

## 8. The reverse proxy and TLS

**First, find out what already serves HTTP on this box.** A droplet that hosts anything else already
has a reverse proxy on port 80, and two of them cannot both bind it — you get
`bind() to 0.0.0.0:80 failed (98: Address already in use)`, and under certbot that arrives wrapped
in a failed rollback which reads like a certificate problem rather than a port one:

```bash
ss -tlnp | grep -E ':(80|443)\s' || echo "nothing on 80 or 443 — a clean box"
```

Whatever the answer, Job Radar goes behind **one** proxy, and the requirements are the same three:
forward to the app's port, pass the client address along, and **add no security headers** — the app
sets its own CSP, and a second conflicting policy is how the passkey script stops loading.

### If Caddy is already there

The easiest case. Caddy issues and renews certificates itself, so there is no certbot and no nginx.
Add a block to `/etc/caddy/Caddyfile` alongside whatever is already in it:

```caddyfile
jobs.example.com {
    reverse_proxy 127.0.0.1:8010
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

That is the whole configuration. Caddy's `reverse_proxy` already **appends** the peer address to
`X-Forwarded-For` rather than replacing it, and sets `X-Forwarded-Proto` — which is exactly what the
app's client-IP handling expects (see the note at the end of this step). It also redirects HTTP to
HTTPS on its own.

If you installed nginx before discovering Caddy was there, stop it so it does not fight for the port
on the next reboot — and remove any certificate certbot managed to issue, or its renewal timer will
fail forever against a port it cannot have:

```bash
systemctl disable --now nginx
certbot certificates                          # anything listed?
certbot delete --cert-name jobs.example.com   # only if it is
```

### If nothing is there

```bash
apt-get install -y nginx certbot python3-certbot-nginx

cat > /etc/nginx/sites-available/job-radar <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:8000;   # must match PORT in /etc/job-radar.env
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/job-radar /etc/nginx/sites-enabled/
# Only if this box serves nothing else — on a shared droplet the default site
# may be another application's.
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

certbot --nginx -d $DOMAIN
```

Certbot installs a renewal timer. Confirm it: `systemctl list-timers | grep certbot`.

### If Apache is already there

`certbot --nginx` is the wrong plugin; use `--apache`. The vhost needs
`ProxyPass / http://127.0.0.1:8010/`, `ProxyPassReverse` to match, and `mod_remoteip` configured so
the client address survives.

### Why the forwarded address matters

Whichever proxy you use, it must **append** to `X-Forwarded-For` rather than overwrite it. nginx's
`proxy_add_x_forwarded_for` and Caddy's `reverse_proxy` both do. The app reads the **rightmost**
entry, because that is the only one the proxy itself vouches for — everything left of it arrived in
the client's own header and is attacker-chosen. Taking the leftmost would let a scanner rotate fake
IPs past the login rate limiter.

## 9. The one account

```bash
cd /opt/job-radar
set -a; . /etc/job-radar.env; set +a

sudo -u jobradar env \
  DATABASE_URL="$DATABASE_URL" APP_ENV="$APP_ENV" LOG_LEVEL="$LOG_LEVEL" \
  DENO_DIR=/opt/job-radar/.deno \
  ADMIN_USERNAME=you ADMIN_PASSWORD='at least twelve characters' \
  /usr/local/bin/deno task seed-admin
```

(Passing each variable explicitly rather than piping the env file through `xargs`, which mangles any
value containing a space — and a good database password may well contain one. Only three are needed:
the task's `--allow-env` list grants nothing else, deliberately, so a tool that creates an account
cannot read your API keys.)

There is no registration route — not disabled, absent. This task is the only way an account comes
into existence, and passing the password inline keeps it out of `/etc/job-radar.env` where it has no
business being. Clear it from your shell history afterwards.

Then, in a browser at `https://$DOMAIN`:

1. Sign in with that username and password.
2. Go to **Account** and register a passkey. It needs the HTTPS you just set up; the page says so if
   the origin is not secure.
3. Change the password to something you did not type into a terminal. This revokes every other
   session.

## 10. Automation

Visit **Automation**, mint a bearer token, and copy it — it is shown once and never again, because
only its SHA-256 is stored. Point n8n at:

| Route               | Method |                                                        |
| ------------------- | ------ | ------------------------------------------------------ |
| `/api/jobs/collect` | POST   | Fetch every active board, diff, store                  |
| `/api/jobs/embed`   | POST   | Drain the embedding queue                              |
| `/api/jobs/match`   | POST   | Score new and changed postings                         |
| `/api/jobs/digest`  | GET    | New matches since `?since=` — the notification payload |
| `/api/jobs/sweep`   | POST   | Ghost stale applications; purge expired sessions       |

All take `Authorization: Bearer <token>`. Branch on the status code: **200** clean, **207** partial
(the run finished but something in it failed, or there is a backlog — call again), **500** the run
itself failed. A 207 from `collect` names the boards that failed.

Be a good citizen about the schedule. The fetcher already rate-limits itself to one request per
second and honours `Retry-After`; collecting hourly is plenty.

## 11. Backups

The dossier is hand-written and not reproducible from anywhere else. Postings can be re-collected;
your facts cannot.

```bash
cat > /etc/cron.daily/job-radar-backup <<'EOF'
#!/bin/sh
set -eu
DEST=/var/backups/job-radar
mkdir -p "$DEST"
sudo -u postgres pg_dump -Fc jobradar > "$DEST/jobradar-$(date +%F).dump"
find "$DEST" -name 'jobradar-*.dump' -mtime +30 -delete
EOF
chmod +x /etc/cron.daily/job-radar-backup
/etc/cron.daily/job-radar-backup      # run it once now
```

A backup on the same droplet survives your mistakes but not the droplet's. Copy it off —
DigitalOcean Spaces, `rsync` to your laptop, anything.

## Changing configuration

`/etc/job-radar.env` is read by systemd when the service starts, and the app validates every setting
once at boot — a missing or malformed value is a startup failure, never a surprise at request time.
So a change to it needs exactly one command:

```bash
sudo systemctl restart job-radar
```

`daemon-reload` is **not** needed; that is only for edits to the `.service` unit itself.

Four values have a consequence beyond the restart:

| Change                                 | Also do this                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `PORT`                                 | Update the proxy — Caddyfile `reverse_proxy` or nginx `proxy_pass` — and reload it                   |
| `APP_BASE_URL` hostname                | **Every registered passkey stops working.** The password still does. Re-register on the new hostname |
| `EMBEDDING_MODEL`                      | Re-embeds the whole corpus and rescores everything, at your expense                                  |
| `VOYAGE_API_KEY` / `ANTHROPIC_API_KEY` | Nothing else — the boot warnings disappear and the features light up                                 |

## Deploying a change

```bash
cd /opt/job-radar
sudo -u jobradar git pull
systemctl restart job-radar
journalctl -u job-radar -n 30 --no-pager
```

Restarting applies any new migrations. **Migrations are forward-only in production** — the runner
refuses `down` when `APP_ENV=production`, and an already-applied migration must never be edited,
because its checksum is verified on every boot. A change to applied SQL is a new migration, always.

Take a dump before a restart that carries migrations.

### Doing it automatically

A timer on the droplet watches `main` and deploys when it moves. **Pull, not push**: nothing needs
an inbound port, and no credential with access to this box is stored anywhere off it. The
alternative — a GitHub Actions job that SSHes in — needs a private key in repository secrets, and
the blast radius of that key is the whole droplet, including anything else it hosts.

```bash
apt-get install -y jq

# Each destination written out in full, deliberately. A brace expansion here
# once put the *service* file at the *timer*'s path; the result had no [Timer]
# section, so the timer loaded as `bad-setting`, scheduled nothing, and stopped
# firing without a single line in the journal.
install -m 755 /opt/job-radar/deploy/job-radar-deploy /usr/local/bin/job-radar-deploy
install -m 644 /opt/job-radar/deploy/job-radar-deploy.service /etc/systemd/system/job-radar-deploy.service
install -m 644 /opt/job-radar/deploy/job-radar-deploy.timer /etc/systemd/system/job-radar-deploy.timer

# Check before trusting. Both are silent when the units are sound.
systemd-analyze verify /etc/systemd/system/job-radar-deploy.timer
systemd-analyze verify /etc/systemd/system/job-radar-deploy.service

systemctl daemon-reload
systemctl enable --now job-radar-deploy.timer
systemctl list-timers job-radar-deploy.timer --no-pager   # NEXT must show a real time

# Watch one cycle before trusting it. Run the script directly with -v rather
# than `systemctl start`: the timer's job is to be silent when there is nothing
# to do, so a manual run through systemd tells you nothing at all.
/usr/local/bin/job-radar-deploy -v
```

`-v` prints the deployed commit, the available one, and what it decided:

```
watching origin/main
  deployed: db830bbd
  available: ef11bafd
  checks: 2/2 conclusive, none failing
deploying ef11bafd (2 checks, none failing)
```

…or, when there is nothing to do, `up to date — nothing to deploy`. Without `-v` — which is how the
timer runs it — a no-op prints nothing and a real deploy prints everything.

It does three things a bare `git pull && systemctl restart` does not:

- **Deploys only what CI has gone green on.** It asks the GitHub checks API about the target commit
  and holds if anything is still running, if any check failed, or if none has reported yet. A timer
  that takes whatever is on `main` will eventually take a broken commit at three in the morning.
- **Dumps the database first**, into `/var/backups/job-radar/pre-deploy-*.dump`, because the restart
  applies migrations and migrations do not come back.
- **Checks the app answers afterwards** and logs loudly if it does not.

Three details of the check gate that only matter once they bite:

- **`skipped` and `neutral` count as passing.** Only `failure`, `cancelled` and `timed_out` hold a
  deploy. Counting strictly-`success` against the total meant one conditional job whose `if:`
  evaluated false would stop deploys permanently, with the reason in a journal line nobody reads.
- **It refuses to judge a partial list.** The checks API pages at 30; the script asks for 100 and
  dies loudly rather than deciding if there are somehow more than that.
- **It parses `/etc/job-radar.env` rather than sourcing it**, reading only `PORT` and
  `DATABASE_URL`. Sourcing let anything in that file redefine the deploy's own settings, and it
  truncated any value containing a space — which the database password may well. The database to
  dump is derived from `DATABASE_URL`; set `PGDATABASE` to override if your password contains a
  literal `/`.

It deliberately does **not** roll back. Once a migration is applied, checking out the previous
commit does not undo it, and a script that pretended otherwise would turn one broken deploy into two
problems. It also refuses to fast-forward a checkout that has been edited by hand, rather than
merging over your changes, and it refuses outright if the checkout is parked on some other branch —
fast-forwarding `add-safe-dir` to `main` would leave production running main's code on a branch
nobody expects.

`journalctl -u job-radar-deploy` is the whole audit trail. Quiet ticks log nothing.

### The deploy updates itself

**The `install` commands above are the bootstrap, not the update path.** After a successful merge
the script copies `deploy/job-radar-deploy` over `/usr/local/bin/job-radar-deploy` when the two
differ, and does the same for the two unit files, running `systemctl daemon-reload` if either
changed. The new script takes effect on the next tick; the one in flight finishes as itself.

This exists because it went wrong exactly once, and expensively. The installed copy was four commits
stale — from before every git call dropped privilege to `jobradar` — so `git rev-parse` ran as root,
git refused the checkout as **dubious ownership**, and the timer failed on every tick for weeks with
the fix already merged and sitting one directory away. Nothing was alerting on it and the box looked
fine. A deploy tool that cannot deploy itself is the one component with no safety net.

**Nothing is installed that the system would refuse to run.** A unit file is checked with
`systemd-analyze verify` and the script with `bash -n` before it is swapped in; a file that fails is
skipped, with the reason logged, and the rest of the deploy carries on. A stale unit that works
beats a fresh one that does not. This exists because a unit file was once installed by hand that
turned out to be the _service_ written to the _timer_'s path — no `[Timer]` section, so no next
elapse, so the timer stopped dead with `bad-setting` in `systemctl status` and nothing in the
journal. Now that the deploy writes unit files unattended, it must not be able to do that faster.

The copy is done by writing a temp file beside the target and renaming it, never by writing the
target in place. `install` and `cp` both mutate the destination inode, and bash reads a running
script incrementally by byte offset; rewriting this file mid-run leaves the interpreter's position
pointing into text that is no longer what it parsed. Whether that actually breaks depends on
buffering and how the sizes line up — a coin toss to rely on, and impossible to reproduce
afterwards. `rename()` sidesteps the question: the running process keeps the old inode, untouched.

## When something is wrong

| Symptom                                       | Look at                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Service will not start                        | `journalctl -u job-radar -n 100` — config errors are explicit and name the variable              |
| `APP_BASE_URL must be https:// in production` | Exactly what it says; TLS first, then flip `APP_ENV`                                             |
| Signing in does nothing, no error             | `Secure` cookies over plain HTTP. Finish the certbot step                                        |
| Passkey button never appears                  | The origin is not secure, or the CSP is being overridden by nginx                                |
| Migration fails on `0004`                     | `postgresql-16-pgvector` is not installed                                                        |
| Boards failing                                | The **Coverage** page names each one and why. That is the ledger's job                           |
| Matching does nothing                         | No `VOYAGE_API_KEY`. The match pages say so rather than erroring                                 |
| `detected dubious ownership in repository`    | See below — almost always a stale `/usr/local/bin/job-radar-deploy`                              |
| Deploy says the repo is on the wrong branch   | `sudo -u jobradar git -C /opt/job-radar checkout main`. Never write to that repo as yourself     |
| Timer stopped firing, nothing in the journal  | `systemctl status job-radar-deploy.timer`. `Trigger: n/a` means it scheduled nothing — see below |

### The timer stops firing and the journal says nothing

A timer that scheduled nothing produces no log line at all — the absence _is_ the symptom, and
`journalctl -n 20` will happily keep showing you hours-old history as if it were current. Check the
gap between the last entry and now before reading the entries themselves.

```bash
systemctl status job-radar-deploy.timer --no-pager | head -6
systemctl list-timers job-radar-deploy.timer --all --no-pager
```

`Trigger: n/a` with `Active: active (elapsed)` means systemd has no next elapse. Almost always the
unit file:

```bash
sudo systemd-analyze verify /etc/systemd/system/job-radar-deploy.timer
head -4 /etc/systemd/system/job-radar-deploy.timer      # must be [Unit] then [Timer]
```

`Timer unit lacks value setting. Refusing.` means there is no usable `[Timer]` section — usually
because the file is a copy of something else. Reinstall it from the repository with an explicit
destination, and note that **`daemon-reload` alone will not reschedule it**; the timer needs a
restart:

```bash
sudo install -m 644 /opt/job-radar/deploy/job-radar-deploy.timer /etc/systemd/system/job-radar-deploy.timer
sudo systemd-analyze verify /etc/systemd/system/job-radar-deploy.timer
sudo systemctl daemon-reload
sudo systemctl restart job-radar-deploy.timer
systemctl list-timers job-radar-deploy.timer --no-pager
```

### `detected dubious ownership in repository at '/opt/job-radar'`

Git refuses to operate on a repository owned by a different user than the one running it. In the
deploy that should never happen, because every git call drops to `jobradar` — so seeing this means
something is running git as the wrong user. In order of likelihood:

1. **The installed script is stale.** Older copies ran `git rev-parse` as root. The giveaway is in
   the journal: the `sudo` line for `git fetch` opens and closes cleanly, and then the _next_ git
   call has no `sudo` line at all before it dies.

   ```bash
   diff /usr/local/bin/job-radar-deploy /opt/job-radar/deploy/job-radar-deploy
   sudo install -m 755 /opt/job-radar/deploy/job-radar-deploy /usr/local/bin/
   ```

2. **The checkout is genuinely owned by someone else** — usually because a git command was run in it
   as root or as your own account, which rewrites `.git` as that user.

   ```bash
   stat -c '%U:%G %n' /opt/job-radar /opt/job-radar/.git
   sudo chown -R jobradar:jobradar /opt/job-radar
   ```

**Do not fix this with `git config --global --add safe.directory /opt/job-radar`.** As your own user
it changes nothing about the deploy, which runs git as `jobradar`; as root it silences the warning
that was correctly telling you the wrong user is writing to production's checkout. Adding it so you
can _read_ the repo from your own shell is fine — just never write to it that way.
