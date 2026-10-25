# syntax=docker/dockerfile:1.7
# =============================================================================
# Cura Money — single-image build.
#
# Targets:
#   - runtime (default, CI): distroless + Bun, non-root, production deps only.
#   - builder (docker-compose.dev.yml): full toolchain, `bun run --watch`.
#
# Strategy:
#   - The server runs its TypeScript directly with `bun run`, so there is no
#     server bundle step. That sidesteps the class of "bun's bundler follows
#     an optional devDep chain and explodes" problems.
#   - Every RUN step happens in stages pinned to $BUILDPLATFORM. Their output
#     (the Vite bundle and pure-JS production dependencies) is the same on
#     every architecture, so a multi-arch build does that work once, natively,
#     and the per-architecture runtime stage only copies files plus that
#     architecture's Bun binary. Nothing is run under emulation.
#   - The runtime gets production dependencies without optional peers (the
#     drizzle-kit/esbuild/bun-types tooling that better-auth and drizzle-orm
#     list as optional peers) and the server source without src/ui.
# =============================================================================

ARG APP_REVISION=""
ARG BUN_IMAGE=oven/bun:1.4.4

# ---- Builder (dev target: full deps, UI built, whole source tree) ---------
FROM ${BUN_IMAGE} AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src/ui/package.json src/ui/bun.lock src/ui/
COPY src/ui/tsconfig.json src/ui/tsconfig.node.json src/ui/vite.config.ts src/ui/
RUN cd src/ui && bun install --frozen-lockfile
COPY src/ui/ src/ui/
RUN cd src/ui && bun run build

COPY . .
RUN mkdir -p /data

# ---- UI bundle (built once, natively) -------------------------------------
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS ui
WORKDIR /app
COPY src/ui/package.json src/ui/bun.lock src/ui/
RUN cd src/ui && bun install --frozen-lockfile
COPY src/ui/ src/ui/
# Vite writes the bundle to /app/public.
RUN cd src/ui && bun run build

# ---- Server files (production deps + source, built once, natively) --------
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS server
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --omit=peer
COPY tsconfig.json ./
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY src ./src
RUN rm -rf src/ui \
  # Database volume mount point. The runtime has no shell to create it, so
  # it is made here and copied over owned by the runtime user; a new named
  # volume mounted at /data starts with this ownership.
  && mkdir -p /data

# ---- Bun binary for the target architecture (copied, never run here) -----
FROM ${BUN_IMAGE} AS bun

# ---- Runtime (prod; distroless, no shell) ---------------------------------
FROM gcr.io/distroless/base-debian12 AS runtime
WORKDIR /app

ARG APP_REVISION

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=server /app ./
COPY --from=ui /app/public ./public
COPY --from=server --chown=65534:65534 /data /data

# Non-root user (distroless has nobody:65534)
USER 65534:65534

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/cura.db
ENV APP_REVISION=${APP_REVISION}

EXPOSE 3000
VOLUME /data

# Run TypeScript directly. Bun transpiles on the fly; no bundle step.
# Healthcheck is in compose, not here (distroless has no shell for CMD).
ENTRYPOINT ["bun", "run", "src/index.ts"]
