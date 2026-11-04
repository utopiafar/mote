# Desktop

Owns local permissions and privacy, durable uploads and the full owner client. Local folder sources belong to the Mac that selected them.

- Focused test (repo root): `npm run test -w @mote/desktop -- test/config.test.ts`. Pick an existing affected file; Vitest accepts file filters.
- Typecheck (repo root): `npm run typecheck -w @mote/desktop`
- Dev must not call `safeStorage`; Prod keeps OS protection.
- UI fixtures load `scripts/fixture-background.cjs` before Electron/product imports and use isolated generated profiles: [background UI](../../docs/testing-runbook.md#background-testing).
- Build native helpers only when affected; native capture, OS permissions and packaging need macOS.
- Hidden fixture results don't cover native focus or system authorization.
