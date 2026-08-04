# Deploying Job Radar

A runbook for the first deploy onto a single Ubuntu droplet, and for every deploy after it. Written
for Ubuntu 24.04 LTS; other versions differ mainly in the Postgres package name.

The shape (§13): the app binds **localhost only** and nginx terminates TLS in front of it. Nothing
but nginx can reach the app, and nothing but the app can reach the database.

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
nine.

Check it came up:

```bash
curl -s localhost:8000/healthz     # {"status":"ok"} — use your PORT if you changed it
journalctl -u job-radar -n 50 --no-pager
```

Two warnings on a fresh boot are expected and correct: no embedding key, no Anthropic key, and
`no admin account exists`.

## 8. nginx and TLS

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
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

certbot --nginx -d $DOMAIN
```

`proxy_add_x_forwarded_for` is the important one and the default for a reason: it **appends** the
address nginx actually talked to, so the rightmost entry is the only one the proxy vouches for. The
app reads the rightmost entry precisely because everything left of it arrived in the client's own
header and is attacker-chosen — that is what stops a scanner rotating fake IPs past the login rate
limiter.

Do not add security headers in nginx. The app sets its own CSP, and a second conflicting policy is
how the passkey script stops loading.

Certbot installs a renewal timer. Confirm it: `systemctl list-timers | grep certbot`.

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

## When something is wrong

| Symptom                                       | Look at                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Service will not start                        | `journalctl -u job-radar -n 100` — config errors are explicit and name the variable |
| `APP_BASE_URL must be https:// in production` | Exactly what it says; TLS first, then flip `APP_ENV`                                |
| Signing in does nothing, no error             | `Secure` cookies over plain HTTP. Finish the certbot step                           |
| Passkey button never appears                  | The origin is not secure, or the CSP is being overridden by nginx                   |
| Migration fails on `0004`                     | `postgresql-16-pgvector` is not installed                                           |
| Boards failing                                | The **Coverage** page names each one and why. That is the ledger's job              |
| Matching does nothing                         | No `VOYAGE_API_KEY`. The match pages say so rather than erroring                    |
