# Central web

- Reuse owner navigation, settings, terminology and components.
- Focused test from `apps/web`: `node --import tsx --test test/api.test.ts`. Select an existing affected file.
- Use generated content and hidden browser fixtures. `npm test` uses the full glob; appended filenames do not narrow it. DOM fixtures do not establish native-client or external-model behavior.
- Typecheck from the repository root: `npm run typecheck -w @mote/web`. Coordinate shared builds; do not rebuild shared output concurrently.
- Translate new `moteText` keys and synchronize Android English strings.
- Test layers, triggers and background UI guidance are defined in [testing](../../docs/testing.md).
