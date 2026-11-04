# Central server

Owns HTTP/MCP, evidence, processing, Memory, Ask and Actions for the instance owner. Never add an account host.

- Focused test (repo root): `npm run test:file -w @mote/server -- test/connections.test.ts`. Pick an existing affected file; the script keeps the required concurrency and 120 s timeout.
- Typecheck (repo root): `npm run typecheck -w @mote/server`
- `better-sqlite3` must match the active Node ABI; rebuild it after switching Node versions.
- Generated SQLite/HTTP fixtures don't cover external-model quality.
