FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
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
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN npm run build:libs && npm run build -w @mote/server && npm run build -w @mote/web

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production MOTE_CONFIG_FILE=/config/mote.yaml ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg && rm -rf /var/lib/apt/lists/*
# Carry worker sources, domain serializers, fixed requirements and model
# manifests together. MLX is Native-only; this image's inference path is CPU.
COPY scripts ./scripts/
RUN python3 -m venv /opt/mote-media/ocr && /opt/mote-media/ocr/bin/pip install --no-cache-dir -r scripts/requirements-ocr.txt
RUN python3 -m venv /opt/mote-media/dialogue && /opt/mote-media/dialogue/bin/pip install --no-cache-dir -r scripts/requirements-audio.txt
COPY package.json package-lock.json ./
COPY packages/plugin-api/package.json ./packages/plugin-api/package.json
COPY packages/plugin-host/package.json ./packages/plugin-host/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/agent/package.json ./packages/agent/package.json
COPY apps/server/package.json ./apps/server/package.json
RUN npm ci --omit=dev --workspace=@mote/server --workspace=@mote/shared --workspace=@mote/agent --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/packages/plugin-api/dist ./packages/plugin-api/dist
COPY --from=build /app/packages/plugin-host/dist ./packages/plugin-host/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/agent/dist ./packages/agent/dist
COPY --from=build /app/packages/agent/skills ./packages/agent/skills
COPY apps/server/src/connectors/cli-runtime.mjs ./apps/server/src/connectors/cli-runtime.mjs
COPY scripts/connector-runtime.mjs ./scripts/connector-runtime.mjs
RUN node scripts/connector-runtime.mjs && chmod a+rx .mote && chmod -R a+rX .mote/connectors
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN test -x /bin/bash && node --input-type=module -e "import {accessSync} from 'node:fs'; import {createRequire} from 'node:module'; import {bundledSkills} from './packages/agent/dist/skills.js'; const require=createRequire(import.meta.url); accessSync('./apps/server/dist/import-parser.mjs'); accessSync('./apps/server/dist/plugin-worker.mjs'); if(!['personal-insight','memory-extraction','memory-consolidation','working-memory','document-import','calendar-extraction','coding-memory'].every(id=>bundledSkills.some(s=>s.id===id && s.content.length>0)) || typeof require('node-pty').spawn!=='function') throw Error('Import runtime is incomplete');"
COPY deploy/empty.env ./deploy/empty.env
COPY packages/shared/src/config-file.ts ./packages/shared/src/config-file.ts
RUN mkdir -p /data /models && chown node:node /data /models
USER node
VOLUME ["/data"]
EXPOSE 47832
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node apps/server/dist/healthcheck.js
# Central's third-party CLIs keep their own credential management in the
# instance's writable, persistent volume, including non-node deployment UIDs.
# Media sidecars supply their own command and retain their existing environment.
CMD ["env", "HOME=/data", "node", "apps/server/dist/index.js"]
