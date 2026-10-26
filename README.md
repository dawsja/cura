# Cura Money

Self-hostable personal finance. Accounts, categories, monthly budgets,
transactions, debt paydown calculator. One container; the data is a single
SQLite file on a Docker volume.

## Quick start

Prereqs: Docker and Docker Compose.

```bash
cp .env.example .env
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" >> .env
docker compose up -d
docker compose logs app | grep "SETUP BOOTSTRAP"
```

Open http://localhost:3000, paste the token, run through the setup guide. Done.

The pre-built image is pulled from GHCR.
Published by GitHub Actions on every push to `main` and every `v*` tag.

## Updating

Back up the database before updating (see [Backup and restore](#backup-and-restore)).
The app applies forward-only database migrations before it becomes ready, so
an older image may not be compatible after a migration has run.

```bash
docker compose exec app bun scripts/backup.ts
docker compose pull
docker compose up -d
docker compose ps
```

Routine `docker compose up -d` only pulls the image when it is absent, so
updates remain an explicit `docker compose pull`. For controlled upgrades,
replace `latest` in `docker-compose.yml` with a `v*` release tag and change
that tag deliberately.

The app healthcheck stays unhealthy until startup migrations, setup loading,
auth initialization, and a database readiness query succeed. Review startup
logs after each update with `docker compose logs app`. Run one app container
per database file; SQLite does not support several app replicas sharing it.

### Upgrading from Postgres

Earlier releases stored data in a separate Postgres container. Cura now keeps
everything in one SQLite file and moves an existing install over by itself:
users, sessions, sign-in links, transactions, budgets, rules, goals, settings,
SimpleFIN connections, and MCP tokens all come across, so nobody has to sign
in again or re-enter anything. Keep `DATA_ENCRYPTION_KEY` (or
`BETTER_AUTH_SECRET`, if you never set one) unchanged.

1. Replace your `docker-compose.yml` with the new one from this repository and
   download `docker-compose.postgres-import.yml` next to it. Keep your `.env`
   as it is; the import file reads `POSTGRES_PASSWORD` and friends from it.
2. Start once with both files. The app copies Postgres into `/data/cura.db`,
   checks every table, and then starts normally:

   ```bash
   docker compose pull
   docker compose -f docker-compose.yml -f docker-compose.postgres-import.yml up -d
   docker compose logs app | grep import:
   ```

   Look for `import: copied and verified all data from Postgres`. If the
   copy does not match, the app stops without creating the file and Postgres
   is untouched, so the previous image keeps working.
3. Check the app, then start without the import file. This removes the
   Postgres container:

   ```bash
   docker compose up -d --remove-orphans
   ```

4. The Postgres volume (`curamoney_db_data`) is kept as a fallback. Once you
   are happy, delete it with `docker volume rm curamoney_db_data` and remove
   the `POSTGRES_*` lines from `.env`.

With your own Compose file, the same steps are: mount a volume at `/data`, set
`DATABASE_PATH=/data/cura.db`, and keep the Postgres service and
`DATABASE_URL` for one start. If `/data/cura.db` later goes missing while
`DATABASE_URL` is still set, the app refuses to start instead of importing
stale data again; mount the volume that holds the file. To deliberately copy
Postgres again and lose every change made since, start once with
`SQLITE_REIMPORT=true`.

### Moving from the `cura-money` image

The repository was renamed from `dawsja/cura-money` to `dawsja/cura`, and the
image is now `ghcr.io/dawsja/cura`. If your `docker-compose.yml` still says
`image: ghcr.io/dawsja/cura-money:latest`, change it to
`image: ghcr.io/dawsja/cura:latest`, then update as above. Nothing else
changes: the database, `.env`, and volumes are reused as they are. The old
image name no longer receives updates.

## Configuration

### Public demo mode

The same image can run as a disposable public showcase by setting:

```env
DEMO_MODE=true
```

This single switch is intentionally destructive. On startup and at `:00`,
`:15`, `:30`, and `:45` UTC, the app deletes every application user, session,
OIDC provider, setting, and financial record, then recreates the example data.
Visitors sign in with `demo@curamoney.com` / `demo` and are signed out by each
reset. Setup changes, OIDC, administration, password changes, registration,
and SimpleFIN mutations are disabled while demo mode is active. Database
migration history is preserved so normal startup migrations remain safe.

Leave `DEMO_MODE` unset or set it to `false` for normal installations.

All via `.env`. Required:

- `BETTER_AUTH_SECRET` — random base64, at least 32 bytes

The database is the SQLite file at `DATABASE_PATH`, which Compose sets to
`/data/cura.db` on the `cura_data` volume.

Optional at-rest encryption configuration:

- `DATA_ENCRYPTION_KEY` - stable random value of at least 32 characters used to
  encrypt OIDC client secrets and SimpleFIN access URLs. If unset,
  `BETTER_AUTH_SECRET` is used for compatibility.
- `DATA_ENCRYPTION_KEY_PREVIOUS` - comma-separated prior encryption keys used
  only to decrypt and lazily reseal stored credentials during rotation.

The checked-in Compose service forwards both variables from the project
`.env` file into the app container when configured.

Set these to the public HTTPS origin when behind a TLS reverse proxy. Cura uses
the configured scheme for secure authentication cookies. Leave them empty for
direct HTTP access on localhost or a LAN address:

- `APP_URL` / `BETTER_AUTH_URL` / `OIDC_REDIRECT_BASE`

`AUTH_SECURE_COOKIES=false` is required for direct HTTP and is included in the
example environment file. Use `auto` (or `true`) behind HTTPS. Existing
installations without this setting retain their previous production default.

Sign-in and setup rate limits are keyed on the client IP. Cura takes it from the
TCP connection and reads `X-Forwarded-For` only from a trusted proxy, set with
`TRUSTED_PROXIES` (comma-separated IPs or CIDR ranges). Left empty, loopback and
private networks are trusted, which covers a proxy on the same host or Compose
network. List your proxy's address if it connects from a public IP, or set
`none` when untrusted clients can reach Cura directly from a private address.

See `.env.example` for the full list. `RUN_CRON=true` enables the hardcoded UTC
schedules; set it to `false` to disable scheduled work. A job that is still
running is never started a second time. Log level and port have
defaults. Configured app/auth/OIDC URLs must be HTTP(S) origins without paths.

Set `TZ` to the deployment's IANA timezone, such as `America/Chicago`. Cura uses
it to convert SimpleFIN timestamps into transaction calendar dates. Changing
`TZ` triggers a refresh of the available SimpleFIN history while preserving
dates that users manually changed. Scheduled job execution remains in UTC.

Financial-data retention is non-destructive by default: `RETENTION_DAYS=0`
keeps history indefinitely. Set a positive day count to opt in to automatic
transaction and old budget-history deletion. The authenticated
`GET /api/data/retention` endpoint discloses the active policy and cutoff.

Authenticated users can download a versioned full-data JSON export from
`GET /api/data/export.json` and a transaction CSV from
`GET /api/data/transactions.csv`. Exports include pending-review transactions
but exclude passwords, sessions, provider tokens, and integration credentials.

### MCP server

Cura Money includes a remote [Model Context Protocol](https://modelcontextprotocol.io)
server, so self-hosted assistants and automations can read a user's accounts,
balances, transactions, budgets, goals, recurring charges, debt projections,
rules, and reports. Tokens created with write access can also manage the user's
money the way the web app does:

| Web app | MCP tools |
| --- | --- |
| Transactions: change a category, then "Create scoped rule" | `categorize_transaction` (with `createRule`), `bulk_categorize_transactions` |
| Transactions: add, edit, split, delete | `add_transaction`, `update_transaction`, `split_transaction`, `delete_transaction` |
| Review dialog | `review_transaction`, `accept_all_reviews` |
| Rules page | `create_rule`, `create_rule_from_transaction`, `update_rule`, `delete_rule`, `run_rules` |
| Budget page, including "Apply to future months" and Pay down rows | `set_budget`, `set_debt_payment` |
| Pay down page: debt settings and "Save to Budget" | `update_paydown_settings`, `save_debt_plan_to_budget` |
| Accounts page, including "Sync now" | `add_account`, `update_account`, `set_account_hidden`, `delete_account`, `sync_bank_accounts` |
| Categories page | `create_category`, `create_subcategory`, `rename_category`, `rename_subcategory`, `delete_category`, `delete_subcategory`, `reorder_categories` |
| Goals page | `create_goal`, `update_goal`, `delete_goal` |
| Transactions page recurring picker; Recurring page | `set_recurring_charge` (weekly, monthly, or yearly), `remove_recurring_charge`, `add_manual_recurring_charge`, `update_manual_recurring_charge` |

Write tools run the same checks as the web app. As there, changing a
transaction never creates or edits a rule by itself, a new rule only changes
existing transactions when it is run, and a budget amount applies to one month
unless it is applied to future months. Deleting tools are marked destructive so
clients can ask before running them; bank-synced accounts can only be hidden.

The endpoint is `POST /mcp` (Streamable HTTP, stateless, JSON responses). Clients
authenticate with a personal access token:

1. In Cura Money, open **Settings → MCP access** and create a token. Give it a
   name for the app it's for, choose **Read only** or **Read and write**, and
   choose when it expires (30 days, 90 days, 1 year, or never). The token is
   shown once; copy it then. Read-only tokens never see the write tools, and
   tokens created before write access existed stay read-only.
2. In your MCP client, add the server URL `https://cura.example.com/mcp` with
   the header `Authorization: Bearer <token>`. Store the token as a secret.

```bash
curl -s -X POST https://cura.example.com/mcp \
  -H "Authorization: Bearer cura_…" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Each token belongs to the user who created it and only reaches that user's data.
Every change made through a token is logged with the tool name and token id.
Revoking a token in Settings cuts off the app immediately. Settings also shows
when each token was last used. Tokens are stored only as a hash, are never valid
for the regular `/api` routes, and browser sessions are not accepted at `/mcp`.

Serve Cura Money over HTTPS behind your reverse proxy. `/mcp` rejects plain HTTP
unless the request host is loopback, a private or CGNAT (Tailscale) address, a
single-label name such as a Compose service, or a
`.local`/`.lan`/`.internal`/`.home.arpa` name. Set `MCP_ENABLED=false` to turn
the feature off. It is always off in `DEMO_MODE`.

### Encryption key rotation

Back up both the database and the current secrets before changing keys. Database
backups contain encrypted integration credentials and cannot restore those
credentials without the key that encrypted them. Keep required historical keys
in a separate, protected backup alongside each database backup.

To decouple existing installations safely from `BETTER_AUTH_SECRET`, first set
`DATA_ENCRYPTION_KEY` to the current `BETTER_AUTH_SECRET` value and restart.
After confirming startup and an integration sync, `BETTER_AUTH_SECRET` may be
rotated without losing OIDC or SimpleFIN credentials. Keep
`DATA_ENCRYPTION_KEY` stable across later auth-secret rotations.

To rotate the data key, move the old `DATA_ENCRYPTION_KEY` into
`DATA_ENCRYPTION_KEY_PREVIOUS`, set a new random `DATA_ENCRYPTION_KEY`, and
restart. Active OIDC secrets are resealed during auth initialization; each
SimpleFIN URL is resealed on its next sync. Keep every prior key configured
until all associated credentials, including inactive integrations, have been
read and resealed and until no retained backup requires it. Test the restored
backup with its matching key ring before retiring any key. Never rotate the
data key and discard its old value in the same deployment.

## Operations

The public health endpoints have different purposes:

- `GET /health` is process liveness only and does not access the database.
- `GET /ready` performs a bounded database check and returns `503` while the
  app is starting, shutting down, or unable to use the database. Compose uses
  this endpoint for the app healthcheck.

Requests are limited to 1 MiB. Oversized bodies receive a stable `413` JSON
response. Every response has an `X-Request-Id`, which is also included in
structured request and error logs.

### Backup and restore

`scripts/backup.ts` copies the database while the app keeps running and
checks the copy before reporting success. Backups land on the data volume, so
copy them somewhere else as well:

```bash
docker compose exec app bun scripts/backup.ts
docker compose cp app:/data/backups/cura-20250101T000000Z.db ./
```

To restore, stop the app and run the restore in a one-off container. The
current file is kept beside it as `cura.db.before-restore`:

```bash
docker compose stop app
docker compose run --rm --no-deps --entrypoint bun app scripts/backup.ts --restore /data/backups/cura-20250101T000000Z.db
docker compose start app
```

A backup taken elsewhere has to be on the volume first, for example in
`/data/backups/`. Restore to the same application release that created the
backup first, then perform normal updates so forward migrations run in order.
Test backups by restoring them into a separate environment; a backup that has
not been restored successfully is not verified.

## Features

- Accounts: checking, savings, credit, investment, loan
- Categories with monthly planned budgets and forward carry-forward
- Transactions: manual entry, smart merchant categorisation, filters
- Debt paydown calculator: avalanche, snowball, planned
- Optional SimpleFIN bank sync (cron-driven, every 2 hours)
- OIDC sign-in with any OpenID Connect IdP
- MCP server for AI assistants, with read-only or read-and-write personal access tokens

## License

MIT. See [`LICENSE`](./LICENSE).
 
 
