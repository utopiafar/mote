FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY models/qwen-manifest.json ./models/qwen-manifest.json
COPY models/review-policy.txt ./models/review-policy.txt
COPY models/review-system.txt models/review-grammar.gbnf ./models/
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY apps/desktop/package.json ./apps/desktop/package.json
RUN npm ci --no-audit --no-fund
RUN npm run build:libs && npm run build -w @mote/server && npm run build -w @mote/web

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production MOTE_ENV_FILE=/app/deploy/empty.env MOTE_HOST=0.0.0.0 MOTE_PORT=47832 MOTE_DATA_DIR=/data ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/agent/package.json ./packages/agent/package.json
COPY apps/server/package.json ./apps/server/package.json
RUN npm ci --omit=dev --workspace=@mote/server --workspace=@mote/shared --workspace=@mote/agent --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/agent/dist ./packages/agent/dist
COPY --from=build /app/packages/agent/skills ./packages/agent/skills
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN test -x /bin/bash && node --input-type=module -e "import {accessSync} from 'node:fs'; import {createRequire} from 'node:module'; import {bundledSkills} from './packages/agent/dist/skills.js'; accessSync('./apps/server/dist/import-parser.mjs'); if(!['personal-insight','memory-extraction','memory-consolidation','working-memory','document-import'].every(id=>bundledSkills.some(s=>s.id===id)) || typeof createRequire(import.meta.url)('node-pty').spawn!=='function') throw Error('Import runtime is incomplete');"
COPY deploy/empty.env ./deploy/empty.env
COPY scripts/backup.ts ./scripts/backup.ts
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 47832
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:47832/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
