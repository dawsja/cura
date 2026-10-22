# Repository Guidelines

## Project Structure & Module Organization

Cura Money uses Bun 1.3+ with independently installed API and UI packages. The Hono API starts at `src/index.ts`; routes live in `src/routes/`, data access in `src/db/queries.ts`, schemas in `src/db/schema/`, shared logic in `src/lib/`, and scheduled work in `src/jobs/`. Drizzle migrations are under `drizzle/`.

The React/Vite SPA is in `src/ui/`; source assets are in `src/ui/public/`. Vite generates root `public/index.html` and `public/assets/`; do not edit them directly.

## Build, Test, and Development Commands

Install both packages before development:

```bash
bun install --frozen-lockfile
(cd src/ui && bun install --frozen-lockfile)
bun run dev                         # API with watch mode
bun run dev:web                     # Vite UI; proxies /api to :3000
bun run lint                        # server and scripts
bun run typecheck                   # root TypeScript
(cd src/ui && bun run build)        # UI typecheck and production build
```

Run lint, root typecheck, and UI build before submitting. There is no automated test framework; do not invent a test command. Smoke-test with `curl -s http://localhost:3000/health` and `/api/setup/status`. Source Compose development requires `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, single quotes, and semicolons, following nearby code.
React components/pages use PascalCase filenames; server modules use lowercase kebab-case. Validate requests, environment values, and external JSON with Zod. Log structured Pino objects and never credentials.

User-owned database operations must accept `userId` and filter by `user_id`; handlers obtain it through `userId(c)`. Add endpoints as validating routers, query helpers, and mounts in `src/index.ts`.

## Database, Security & UI Invariants

Generate then migrate with `bun run db:generate` and `bun run db:migrate` (`DATABASE_URL` required). Never hand-edit `src/db/schema/auth.ts` or existing migrations; migrations are forward-only. Better Auth owns `/api/auth/*`, and protected resources pass through `src/lib/guard.ts`.

Preserve server startup order: migrations → setup → auth → retention → optional cron → HTTP.

Transactions store amounts as integer cents; `transfer` is excluded from income/expense totals. Preserve categorization-rule precedence, hidden SimpleFIN accounts, and read-time account aliases during sync.

Before visual changes, read `THEME.md`. The UI is dark only: there is no light theme and no `dark:`
variant or light/dark class pair in app code. Palette tokens belong in `src/ui/src/styles.css`, and changes
must update `THEME.md`. Use semantic classes such as `bg-page`, `bg-card`, `bg-popover`, `bg-inset`, `fg-*`,
and `border-default`.

## Commit & Pull Request Guidelines

Use short, imperative subjects such as `fix: review uncategorized SimpleFIN accounts`; keep commits
focused and prefer `fix:`/`feat:` prefixes. PRs should explain behavior and migration/config impact, link issues, list verification, and include screenshots for UI changes. Never commit secrets or populated `.env` files.
