# Cura Money

Self-hostable personal finance with accounts, categories, monthly budgets,
transactions, and a debt paydown calculator. Cura runs in one container and
keeps its data in a single SQLite file on a Docker volume.

## Quick start

Prerequisites: Docker and Docker Compose.

```bash
cp .env.example .env
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" >> .env
docker compose up -d
docker compose logs app | grep "SETUP BOOTSTRAP"
```

Open http://localhost:3000, paste the token, and follow the setup guide.

Compose pulls the pre-built image from GHCR. GitHub Actions publishes it on
every push to `main` and every `v*` tag.

## Updating

Back up the database before updating. [Backup and restore](#backup-and-restore)
has the steps. The app runs forward-only database migrations before it becomes
ready. After a migration runs, an older image may not work with the database.

```bash
docker compose exec app bun scripts/backup.ts
docker compose pull
docker compose up -d
docker compose ps
```

`docker compose up -d` pulls the image only when it is missing, so an update
happens only when you run `docker compose pull`. To control upgrades, replace
`latest` in `docker-compose.yml` with a `v*` release tag and change the tag
when you choose to upgrade.

The app healthcheck stays unhealthy until startup migrations, setup loading,
auth initialization, and a database readiness query succeed. Check the startup
logs after each update with `docker compose logs app`. Run one app container
per database file, because SQLite does not support several app replicas
sharing one file.

### Upgrading from Postgres

Earlier releases stored data in a separate Postgres container. Cura now keeps
everything in one SQLite file and copies an existing Postgres install into it.
The copy includes users, sessions, sign-in links, transactions, budgets, rules,
goals, settings, SimpleFIN connections, and MCP tokens, so nobody has to sign
in again or re-enter anything. Keep `DATA_ENCRYPTION_KEY` unchanged. If you
never set it, keep `BETTER_AUTH_SECRET` unchanged.

1. Replace your `docker-compose.yml` with the new one from this repository and
   download `docker-compose.postgres-import.yml` next to it. Keep your `.env`
   as it is. The import file reads `POSTGRES_PASSWORD` and the other
   `POSTGRES_*` values from it.
2. Start once with both files. The app copies Postgres into `/data/cura.db`,
   checks every table, and then starts normally:

   ```bash
   docker compose pull
   docker compose -f docker-compose.yml -f docker-compose.postgres-import.yml up -d
   docker compose logs app | grep import:
   ```

   Look for `import: copied and verified all data from Postgres`. If the copy
   does not match, the app stops without creating the file and leaves Postgres
   unchanged, so the previous image keeps working.
3. Check the app, then start without the import file. This removes the
   Postgres container:

   ```bash
   docker compose up -d --remove-orphans
   ```

4. The Postgres volume, `curamoney_db_data`, stays in place as a fallback.
   After you confirm the app works, delete it with
   `docker volume rm curamoney_db_data` and remove the `POSTGRES_*` lines from
   `.env`.

With your own Compose file, the steps are the same: mount a volume at `/data`,
set `DATABASE_PATH=/data/cura.db`, and keep the Postgres service and
`DATABASE_URL` for one start. If `/data/cura.db` later goes missing while
`DATABASE_URL` is still set, the app refuses to start instead of importing
stale data again. Mount the volume that holds the file. To copy Postgres again
and lose every change made since the first import, start once with
`SQLITE_REIMPORT=true`.

### Moving from the `cura-money` image

The repository was renamed from `dawsja/cura-money` to `dawsja/cura`, and the
image is now `ghcr.io/dawsja/cura`. If your `docker-compose.yml` still says
`image: ghcr.io/dawsja/cura-money:latest`, change it to
`image: ghcr.io/dawsja/cura:latest`, then update as above. The database,
`.env`, and volumes are reused as they are. The old image name no longer
receives updates.

## Configuration

All configuration goes in `.env`, and `.env.example` lists every option. The
only required value is `BETTER_AUTH_SECRET`, a random base64 string of at least
32 bytes.

The database is the SQLite file at `DATABASE_PATH`. Compose sets it to
`/data/cura.db` on the `cura_data` volume.

Optional at-rest encryption settings:

- `DATA_ENCRYPTION_KEY` is a stable random value of at least 32 characters.
  Cura uses it to encrypt OIDC client secrets and SimpleFIN access URLs. If it
  is unset, Cura uses `BETTER_AUTH_SECRET` for compatibility.
- `DATA_ENCRYPTION_KEY_PREVIOUS` is a comma-separated list of prior encryption
  keys. During rotation, Cura uses them only to decrypt stored credentials,
  and it reseals each credential with the current key when it next reads it.

The checked-in Compose service passes both variables from the project `.env`
file to the app container when they are set.

Behind a TLS reverse proxy, set `APP_URL`, `BETTER_AUTH_URL`, and
`OIDC_REDIRECT_BASE` to the public HTTPS origin. Cura uses that origin's scheme
to decide whether authentication cookies are secure. Leave them empty for
direct HTTP access on localhost or a LAN address.

Direct HTTP requires `AUTH_SECURE_COOKIES=false`, which the example environment
file includes. Use `auto` or `true` behind HTTPS. Existing installations
without this setting keep their previous production default.

Sign-in and setup rate limits are keyed on the client IP. Cura takes the IP
from the TCP connection and reads `X-Forwarded-For` only from a trusted proxy.
List trusted proxies in `TRUSTED_PROXIES` as comma-separated IPs or CIDR
ranges. If it is empty, Cura trusts loopback and private networks, which covers
a proxy on the same host or Compose network. List your proxy's address if it
connects from a public IP. Set `none` when untrusted clients can reach Cura
directly from a private address.

`RUN_CRON=true` turns on the scheduled jobs, which run on fixed UTC schedules.
Set it to `false` to turn them off. Cura never starts a second copy of a job
that is still running. `LOG_LEVEL` and `PORT` have defaults. The app, auth, and
OIDC URLs must be HTTP or HTTPS origins without paths.

Set `TZ` to the deployment's IANA timezone, such as `America/Chicago`. Cura uses
it to convert SimpleFIN timestamps into transaction calendar dates. When you
change `TZ`, Cura refreshes the available SimpleFIN history and keeps dates
that users changed by hand. Scheduled jobs still run in UTC.

By default, `RETENTION_DAYS=0` keeps all financial history. Set a positive
number of days to have Cura delete older transactions and budget history on
startup and in a daily job. The authenticated `GET /api/data/retention`
endpoint returns the active policy and cutoff.

Authenticated users can download a versioned full-data JSON export from
`GET /api/data/export.json` and a transaction CSV from
`GET /api/data/transactions.csv`. Exports include pending-review transactions
but exclude passwords, sessions, provider tokens, and integration credentials.

### Public demo mode

The same image can run as a disposable public demo:

```env
DEMO_MODE=true
```

Demo mode deletes data. On startup and at `:00`, `:15`, `:30`, and `:45` UTC,
the app deletes every application user, session, OIDC provider, setting, and
financial record, then recreates the example data. Visitors sign in with
`demo@curamoney.com` and the password `demo`, and each reset signs them out.
Demo mode disables setup changes, OIDC, administration, password changes,
registration, and SimpleFIN changes. Resets keep the database migration
history, so normal startup migrations still run correctly.

Leave `DEMO_MODE` unset or set it to `false` for normal installations.

### MCP server

Cura Money includes a remote [Model Context Protocol](https://modelcontextprotocol.io)
server, so self-hosted assistants and automations can read a user's accounts,
balances, transactions, budgets, goals, recurring charges, debt projections,
rules, and reports. Tokens created with write access can also make the same
changes as the web app:

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

Write tools run the same checks as the web app and follow the same behavior:

- Changing a transaction never creates or edits a rule.
- A new rule changes existing transactions only when it is run.
- A budget amount applies to one month unless it is applied to future months.

Delete tools are marked destructive so clients can ask before running them.
Bank-synced accounts can only be hidden, not deleted.

The endpoint is `POST /mcp` (Streamable HTTP, stateless, JSON responses). Clients
authenticate with a personal access token:

1. In Cura Money, open **Settings**, go to **MCP access**, and create a token.
   Name it after the app that will use it, choose **Read only** or
   **Read and write**, and choose when it expires: 30 days, 90 days, 1 year,
   or never. Cura shows the token once, so copy it then. Read-only tokens never
   see the write tools. Tokens created before write access existed stay
   read-only.
2. In your MCP client, add the server URL `https://cura.example.com/mcp` with
   the header `Authorization: Bearer <token>`. Store the token as a secret.

```bash
curl -s -X POST https://cura.example.com/mcp \
  -H "Authorization: Bearer cura_…" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Each token belongs to the user who created it and can reach only that user's
data. Cura logs every change made through a token with the tool name and token
id. Revoking a token in Settings blocks the app at once, and Settings shows
when each token was last used. Cura stores only a hash of each token. Tokens
never work on the regular `/api` routes, and `/mcp` does not accept browser
sessions.

Serve Cura Money over HTTPS behind your reverse proxy. `/mcp` rejects plain
HTTP unless the request host is loopback, a private address, a CGNAT address
such as the ones Tailscale assigns, a single-label name such as a Compose
service, or a name ending in `.local`, `.lan`, `.internal`, or `.home.arpa`.
Set `MCP_ENABLED=false` to turn the MCP server off. It is always off in demo
mode.

### Encryption key rotation

Back up the database and the current secrets before changing keys. A database
backup holds encrypted integration credentials, and Cura cannot restore them
without the key that encrypted them. Store the keys each database backup needs
in a separate, protected backup.

To stop an existing install from using `BETTER_AUTH_SECRET` as its data key,
set `DATA_ENCRYPTION_KEY` to the current `BETTER_AUTH_SECRET` value and
restart. After the app starts and an integration sync succeeds, you can rotate
`BETTER_AUTH_SECRET` without losing OIDC or SimpleFIN credentials. Keep
`DATA_ENCRYPTION_KEY` the same when you rotate the auth secret later.

To rotate the data key, move the old `DATA_ENCRYPTION_KEY` into
`DATA_ENCRYPTION_KEY_PREVIOUS`, set a new random `DATA_ENCRYPTION_KEY`, and
restart. Cura reseals active OIDC secrets when auth starts and reseals each
SimpleFIN URL on its next sync. Keep each prior key configured until Cura has
resealed every credential that key encrypted, including credentials of
inactive integrations, and until no backup you keep needs it. Before you retire
a key, restore a backup with its matching keys and test it. Never rotate the
data key and drop its old value in the same deployment.

## Operations

Cura has two public health endpoints:

- `GET /health` reports process liveness only and does not access the database.
- `GET /ready` runs a database check with a timeout and returns `503` while the
  app is starting, shutting down, or unable to use the database. Compose uses
  this endpoint for the app healthcheck.

Request bodies are limited to 1 MiB, and a larger body gets a `413` JSON
response. Every response has an `X-Request-Id`, and Cura writes the same id to
its structured request and error logs.

### Backup and restore

`scripts/backup.ts` copies the database while the app keeps running and
checks the copy before reporting success. The script writes backups to the
data volume, so copy them somewhere else as well:

```bash
docker compose exec app bun scripts/backup.ts
docker compose cp app:/data/backups/cura-20250101T000000Z.db ./
```

To restore, stop the app and run the restore in a one-off container. The
script keeps the current file beside the restored one as
`cura.db.before-restore`:

```bash
docker compose stop app
docker compose run --rm --no-deps --entrypoint bun app scripts/backup.ts --restore /data/backups/cura-20250101T000000Z.db
docker compose start app
```

Copy a backup from elsewhere onto the volume first, for example into
`/data/backups/`. Restore it with the same application release that created
it, then update as usual so forward migrations run in order. Test backups by
restoring them into a separate environment. A backup you have not restored is
not verified.

## Features

- Accounts: checking, savings, credit, investment, loan
- Categories with monthly planned budgets that carry forward to later months
- Transactions: manual entry, merchant rules for categorization, filters
- Debt paydown calculator: avalanche, snowball, planned
- Optional SimpleFIN bank sync every 2 hours
- OIDC sign-in with any OpenID Connect identity provider
- MCP server for AI assistants, with read-only or read-and-write personal access tokens

## License

MIT. See [`LICENSE`](./LICENSE).
