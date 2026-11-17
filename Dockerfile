# The deployment host needs only its Docker CLI and POSIX shell. These fixed
# Docker/Compose clients run inside deploy-cli, without mounting host credentials.
FROM docker:29.9.1-cli@sha256:6fae2214c3121a28d5aa639d09032f61310b7c9c75ffbad1025f261a1b621800 AS docker-client

FROM node:24-bookworm-slim AS dependency-base
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# Native npm modules may compile here; these build tools never enter core.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/plugin-api/package.json ./packages/plugin-api/package.json
COPY packages/plugin-host/package.json ./packages/plugin-host/package.json
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/agent/package.json ./packages/agent/package.json
COPY packages/diagnostics/package.json ./packages/diagnostics/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json

FROM dependency-base AS build
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY scripts/deployment-contract.mjs ./scripts/deployment-contract.mjs
RUN npm run build:libs && npm run build -w @mote/server && npm run build -w @mote/web

FROM dependency-base AS production-deps
RUN npm ci --omit=dev --workspace=@mote/server --workspace=@mote/shared --workspace=@mote/agent --no-audit --no-fund && npm cache clean --force
# npm keeps conflicting production versions under the owning workspace.
RUN mkdir -p apps/server/node_modules

FROM node:24-bookworm-slim AS core
WORKDIR /app
ENV NODE_ENV=production MOTE_CONFIG_FILE=/config/mote.yaml ELECTRON_SKIP_BINARY_DOWNLOAD=1
# Deployment/import code and public contracts stay available without installing
# optional inference environments or third-party connector CLI binaries.
COPY scripts ./scripts/
COPY package.json package-lock.json ./
COPY packages/plugin-api/package.json ./packages/plugin-api/package.json
COPY packages/plugin-host/package.json ./packages/plugin-host/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/agent/package.json ./packages/agent/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=production-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/packages/plugin-api/dist ./packages/plugin-api/dist
COPY --from=build /app/packages/plugin-host/dist ./packages/plugin-host/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/agent/dist ./packages/agent/dist
COPY --from=build /app/packages/agent/skills ./packages/agent/skills
COPY apps/server/src/connectors/cli-runtime.mjs ./apps/server/src/connectors/cli-runtime.mjs
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN test -x /bin/bash && node --input-type=module -e "import {accessSync} from 'node:fs'; import {createRequire} from 'node:module'; import {bundledSkills} from './packages/agent/dist/skills.js'; const require=createRequire(import.meta.url); accessSync('./apps/server/dist/import-parser.mjs'); accessSync('./apps/server/dist/plugin-worker.mjs'); if(!['personal-insight','memory-extraction','memory-consolidation','working-memory','document-import','calendar-extraction','coding-memory'].every(id=>bundledSkills.some(s=>s.id===id && s.content.length>0)) || typeof require('node-pty').spawn!=='function') throw Error('Import runtime is incomplete');"
COPY deploy/empty.env ./deploy/empty.env
COPY packages/shared/src/config-file.ts ./packages/shared/src/config-file.ts
COPY apps/server/src/log-retention-config.mjs ./apps/server/src/log-retention-config.mjs
RUN mkdir -p /data /models && chown node:node /data /models
USER node
VOLUME ["/data"]
EXPOSE 47832
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node apps/server/dist/healthcheck.js
# Central's third-party CLIs keep their own credential management in the
# instance's writable, persistent volume, including non-node deployment UIDs.
# Media sidecars supply their own command and retain their existing environment.
CMD ["env", "HOME=/data", "node", "apps/server/dist/index.js"]

# Full adds the current Linux CPU media and optional Lark/DingTalk environments.
# No model weights, account login or inference runs during image construction.
FROM core AS full
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg libgomp1 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/mote-media/ocr && /opt/mote-media/ocr/bin/pip install --no-cache-dir -r scripts/requirements-ocr.txt
RUN python3 -m venv /opt/mote-media/dialogue && /opt/mote-media/dialogue/bin/pip install --no-cache-dir -r scripts/requirements-audio.txt
RUN node scripts/connector-runtime.mjs && chmod a+rx .mote && chmod -R a+rX .mote/connectors
USER node

# A separate tooling artifact contains no server, Web or inference environment.
FROM node:24-bookworm-slim AS deploy-cli
WORKDIR /app
COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-client /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=production-deps /app/node_modules/yaml ./node_modules/yaml
COPY scripts ./scripts
COPY compose*.yaml ./
COPY deploy/empty.env ./deploy/empty.env
COPY packages/shared/src/config-file.ts ./packages/shared/src/config-file.ts
COPY apps/server/package.json ./apps/server/package.json
COPY apps/server/src/log-retention-config.mjs ./apps/server/src/log-retention-config.mjs
RUN node scripts/deployment-contract.mjs write deploy/deployment-contract.json && docker --version && docker compose version
ENTRYPOINT ["node", "scripts/docker-cli-entry.mjs"]

# An unqualified local build is core too. Compose always names core/full.
FROM core AS runtime
