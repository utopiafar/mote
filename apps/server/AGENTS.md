# Central server

- Own HTTP/MCP, evidence, processing, Memory, Ask and Actions for one instance owner. Do not introduce an account host.
- Focused test from `apps/server`: `node --import tsx --test --test-concurrency=4 --test-timeout=120000 test/connections.test.ts`. Select an existing affected file; keep its required timeout.
- Build shared/Agent inputs when changed or absent. SQLite must match the active Node ABI. `npm test` uses the full test glob; appended filenames do not narrow it. Generated SQLite/HTTP fixtures do not establish external-model quality.
- Typecheck from the repository root: `npm run typecheck -w @mote/server`. Coordinate shared builds; do not rebuild shared output concurrently.
- Translate new `moteText` keys and synchronize Android English strings.
- Test layers, triggers and coverage requirements are defined in [testing](../../docs/testing.md).
