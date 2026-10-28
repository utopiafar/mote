# Interface languages

Web, macOS and Android support `zh-CN`, `en`, `ja`, `fr`, `de`, `es` and `ru`. Settings offer system default plus 中文, English, 日本語, Français, Deutsch, Español and Русский. Unsupported system languages use English. All layouts remain LTR.

The central API negotiates `Accept-Language` per request and returns `Content-Language` and `Vary: Accept-Language`. Requests without a supported language keep the existing Chinese API default. Async request context prevents concurrent clients from changing each other's language. Protocol identifiers, error codes, logs, captured evidence, user-entered names and model output are not translated by the interface catalog.

Authored Chinese strings are stable source keys in `packages/shared/src/i18n-en.ts`; each locale keeps a parallel catalog in `packages/shared/src/i18n-<locale>.ts` and a synced Android asset `apps/android/app/src/main/assets/i18n-<locale>.json`. A missing target-locale entry falls back to English, then to the authored source. Call `moteText(source, ...arguments)` or Android `MoteI18n.text` only for authored presentation strings. Arguments remain verbatim. Do not feed arbitrary evidence into a translation lookup. The small `statusMessage` helper is only for app-authored cached status fields across desktop language changes.

After editing translations, run `node scripts/sync-i18n.mjs` to update the Android asset, then `node scripts/check-i18n.mjs` to check call-site coverage, placeholder parity and asset consistency. Keep sentence interpolation in a single message where possible. Do not translate SQL, parser literals, identifiers or model protocol fields.

Web persists the choice in local storage and reloads after the user confirms. Desktop stores it in the active profile's `language.json`; the trusted main process saves in-progress notes and reloads the fixed client page. Android stores it in private preferences and recreates activities. Existing evidence and historical messages retain their original content.

Fixture checks: shared i18n tests; server concurrent-request tests; desktop `i18n-smoke.cjs`; Web `test-web-i18n.cjs`. These use generated content only. Android unit tests and lint do not substitute for a physical device check; synthetic Codex transport tests do not substitute for a live-model check.
