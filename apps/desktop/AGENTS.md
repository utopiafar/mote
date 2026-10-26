# Desktop

- Own local permissions/privacy, durable uploads and the full owner client. Local folders belong to this device.
- Focused test from the repository root: `npm run test -w @mote/desktop -- test/config.test.ts`. Select an existing affected file; Vitest accepts this file filter.
- Dev must not call safeStorage; Prod retains OS protection. UI fixtures load `scripts/fixture-background.cjs` before Electron/product imports and use isolated generated profiles. Build native helpers only when affected; native capture, OS permissions and packaging need macOS. Hidden fixture results do not establish native focus or system authorization behavior.
- Typecheck from the repository root: `npm run typecheck -w @mote/desktop`. Coordinate shared builds; do not rebuild shared output concurrently.
- Translate new `moteText` keys and synchronize Android English strings.
- Test layers, triggers and background UI commands are defined in [testing](../../docs/testing.md).
