# One image, three roles (see compose.yaml): migrate, web, worker.
# Workspace packages ship TypeScript sources, so the runtime keeps them and runs via tsx/next.
FROM docker.io/library/node:22.20.0-alpine3.22 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@10.18.3 && mkdir -p /app && chown node:node /app
WORKDIR /app

# Dependencies first, so source edits do not invalidate the install layer.
FROM base AS deps
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node apps/worker/package.json apps/worker/
COPY --chown=node:node packages/core/package.json packages/core/
COPY --chown=node:node packages/chains/package.json packages/chains/
COPY --chown=node:node packages/config/package.json packages/config/
COPY --chown=node:node packages/db/package.json packages/db/
COPY --chown=node:node packages/evidence/package.json packages/evidence/
COPY --chown=node:node packages/contracts/package.json packages/contracts/
USER node
# Keep the content-addressed store outside /app so the runtime stage copies only node_modules.
RUN pnpm install --frozen-lockfile --store-dir /home/node/.pnpm-store

FROM deps AS build
COPY --chown=node:node . .
RUN pnpm --filter @sentinel/web build

FROM base AS runtime
ENV NODE_ENV=production
USER node
COPY --from=build --chown=node:node /app /app
EXPOSE 3000
# Default role: web. compose.yaml overrides the command for migrate and worker.
CMD ["pnpm", "--filter", "@sentinel/web", "start"]
