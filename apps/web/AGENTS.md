# Central web

- Focused test (repo root): `npm run test:file -w @mote/web -- test/api.test.ts`. Pick an existing affected file.
- Typecheck (repo root): `npm run typecheck -w @mote/web`
- Use generated content and hidden browser fixtures: [background UI](../../docs/testing-runbook.md#background-testing).
- DOM fixtures don't cover native-client or external-model behavior.
