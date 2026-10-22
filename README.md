# Cura Money

Self-hostable personal finance. Accounts, categories, monthly budgets,
transactions, debt paydown calculator.

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

Back up the database before updating. The app applies forward-only database
migrations before it becomes ready, so an older image may not be compatible
after a migration has run.

```bash
docker compose pull
docker compose up -d
docker compose ps
```

The app healthcheck stays unhealthy until startup migrations, setup loading,
auth initialization, and a database readiness query succeed. Review startup
logs after each update with `docker compose logs app`. When running multiple
app replicas, deploy in a way that allows startup migrations to finish before
depending on the new replicas; scheduled jobs are protected by PostgreSQL
advisory locks and may remain enabled on every replica.

### Moving from the `cura-money` image

The repository was renamed from `dawsja/cura-money` to `dawsja/cura`, and the
image is now `ghcr.io/dawsja/cura`. If your `docker-compose.yml` still says
`image: ghcr.io/dawsja/cura-money:latest`, change it to
`image: ghcr.io/dawsja/cura:latest`, then update as above. Nothing else
changes: the database, `.env`, and volumes are reused as they are.

Builds are still published under the old name for a while, so an install that
hasn't switched keeps receiving updates until you change it.

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
- `POSTGRES_PASSWORD` — Postgres password

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

See `.env.example` for the full list. `RUN_CRON=true` enables the hardcoded UTC
schedules; set it to `false` to disable scheduled work. The jobs use local and
PostgreSQL advisory locks to avoid overlapping copies. Log level and port have
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
and reports. All tools are read-only.

The endpoint is `POST /mcp` (Streamable HTTP, stateless, JSON responses). Clients
authenticate with a personal access token:

1. In Cura Money, open **Settings → MCP access** and create a token. Give it a
   name for the app it's for and choose when it expires (30 days, 90 days,
   1 year, or never). The token is shown once; copy it then.
2. In your MCP client, add the server URL `https://cura.example.com/mcp` with
   the header `Authorization: Bearer <token>`. Store the token as a secret.

```bash
curl -s -X POST https://cura.example.com/mcp \
  -H "Authorization: Bearer cura_…" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Each token belongs to the user who created it and only reads that user's data.
Revoking a token in Settings cuts off the app immediately. Settings also shows
when each token was last used. Tokens are stored only as a hash, are never valid
for the regular `/api` routes, and browser sessions are not accepted at `/mcp`.

Serve Cura Money over HTTPS behind your reverse proxy. `/mcp` rejects plain HTTP
unless the request host is loopback, a private or CGNAT (Tailscale) address, a
single-label name such as a Compose service, or a
`.local`/`.lan`/`.internal`/`.home.arpa` name. Set `MCP_ENABLED=false` to turn
the feature off. It is always off in `DEMO_MODE`.

### Encryption key rotation

Back up both PostgreSQL and the current secrets before changing keys. Database
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

- `GET /health` is process liveness only and does not access PostgreSQL.
- `GET /ready` performs a bounded PostgreSQL check and returns `503` while the
  app is starting, shutting down, or unable to reach the database. Compose uses
  this endpoint for the app healthcheck.

Requests are limited to 1 MiB. Oversized bodies receive a stable `413` JSON
response. Every response has an `X-Request-Id`, which is also included in
structured request and error logs.

### Backup and restore

Create a PostgreSQL custom-format backup and keep it outside the Compose volume:

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > cura.dump
```

To restore, stop the app so it cannot write or migrate during the restore,
recreate an empty database, and then restore. Recreating the database is
required because `pg_restore --clean` cannot reliably order drops when the
currently installed schema has newer foreign-key dependencies.

```bash
docker compose stop app
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --maintenance-db=postgres --if-exists --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error' < cura.dump
docker compose up -d app
```

Restore to the same application release that created the backup first, then
perform normal updates so forward migrations run in order. Test backups by
restoring them into a separate environment; a backup that has not been restored
successfully is not verified.

## Features

- Accounts: checking, savings, credit, investment, loan
- Categories with monthly planned budgets and forward carry-forward
- Transactions: manual entry, smart merchant categorisation, filters
- Debt paydown calculator: avalanche, snowball, planned
- Optional SimpleFIN bank sync (cron-driven, every 2 hours)
- OIDC sign-in with any OpenID Connect IdP
- Read-only MCP server for AI assistants, with OAuth device-code sign-in

## License

MIT. See [`LICENSE`](./LICENSE).
 
 
