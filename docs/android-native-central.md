# Android native central UI

Android previously embedded the central web app through `CentralWebSession` in
`CentralActivity` and `AskActivity`. The four entry points exposed the web app's
remaining management pages. Those Activities now use Kotlin and Android Views;
the WebView wrapper and its session/draft protocol have been removed.

The native navigation covers all 26 central pages:

| Area | Pages |
| --- | --- |
| Everyday | Overview, archive, ask, notes |
| Evidence | Materials, Coding uploads, timeline, files/recordings, memories, insights, Agent view, sources |
| Administration | Devices, connections, Lark, statistics, processing, extensions, models/services, usage, vault, diagnostics/updates, preferences, imports, help |

Views use the central JSON APIs. Evidence and model output are selectable literal
text; they never run HTML, scripts, or content-driven actions. Forms use native
inputs, switches, pickers, and dialogs; arbitrary policy arrays and parameter
maps use an explicit native JSON editor. External provider OAuth and GitHub
feedback use the system browser. Android document pickers handle uploads/exports,
and MediaPlayer handles audio. Mac's UI implementation is unchanged.

## One owner session

`CentralAccess` and `CentralSessionStore` serve every central page, central backup
export, foreground calendar actions, and foreground remote record browsing.
The session is bound to the explicitly selected central origin. A legacy
configured token is promoted only after successful access to the owner-only
configuration endpoint. A paired collector token never becomes an owner session;
background capture and synchronization keep their existing collector credential.

Login offers application lifetime or 1/7/30 days. Durable credentials use
Android Keystore encryption in the no-backup directory; application lifetime
credentials remain in memory. Logout leaves an encrypted marker preventing
automatic reuse of the configured token. Expiry, logout, re-login, and node
changes invalidate previously issued clients. Stale authentication responses
cannot sign out a newer session. Requests do not follow redirects or send owner
credentials to another origin. Picker results also bind to the initiating origin
and session generation. Connector-specific authentication errors do not log out
the central session.

Ask drafts, run admissions, notes/outbox, import staging, and ambiguous insight
admissions use encrypted files scoped by origin. Note receipts and upload/import
request IDs survive ambiguous responses; retries reuse the same request rather
than create another record. Query runs remain on the central node after leaving
the Activity, and resume through the native progress/history views.

## Generated fixture validation

Run `npm run build:libs` and `node --import tsx scripts/android-central-fixture.ts`.
The fixture starts a loopback central node on port 47883 with generated evidence
and a deterministic injected query agent. It performs no live model calls and
does not collect screenshots. Use a dedicated fresh Android emulator, install the
development and development Android-test APKs, then:

```sh
adb -s emulator-5566 reverse tcp:47883 tcp:47883
adb -s emulator-5566 shell am instrument -w -r \
  -e nativeCentralFixture true \
  -e class dev.mote.collector.NativeCentralInstrumentedTest \
  dev.mote.collector.dev.test/androidx.test.runner.AndroidJUnitRunner
```

The opt-in suite checks all 26 pages without WebViews or repeated login, actual
central API settings/invitation contracts, collector/owner isolation, node
changes, query/draft recovery, literal evidence, and native activity statistics.
Its visual fixture renders only the app's generated views. Shared contract tests
exercise encrypted persistence, expiry/logout, stale clients, note receipts,
and upload/import retry identities. These are fixture checks, not physical-device,
external-account OAuth, or live-model validation.
