# Test runbook

Procedures for checks that need extra setup. Which layer to run, and when, is decided by [testing](testing.md).

## Android intake contract

The light Android intake contract starts a private `buildApp` with generated SQLite data and feeds its real HTTP responses into Kotlin `CentralClient`, `CentralAttachments.upload`, and the production part/final receipt validators:

```sh
# Shared/Agent compiled inputs and the current Node SQLite ABI must be ready.
node --import tsx apps/android/test-fixtures/central-kotlin-contract.ts
# Include the ordinary Android JVM units in the same Gradle invocation:
node --import tsx apps/android/test-fixtures/central-kotlin-contract.ts --all-unit-tests
```

The runner selects `CentralProducerContractTest`, forces only the Gradle test task to execute, and rejects skipped contract cases. It verifies partial upload recovery, lost final ACK recovery, exact revision/ID and original bytes, current ingress requirements, permission failures, forgotten originals and late responses after session invalidation. A JDK HTTP adapter replaces the unavailable Android transport runtime; this establishes actual Kotlin use-case consumption, not `HttpJson`'s Android clock/meter, native permissions, background workers, physical-device behavior or model quality. Running other JVM unit selections without this runner skips the producer-dependent class.

<a id="background-testing"></a>

## Background UI

Local automated tests do not show windows, activate apps or take focus by default. Unit tests, typechecks, builds and Gradle JVM tests run directly in the terminal without starting a client or emulator. UI verification still runs the real renderer, preload/IPC and app lifecycle, with generated material and an isolated test profile.

Central web regressions for first load, same-scope background refresh, empty states, scrolling time ranges, pagination and revocation are in [Web background refresh stability](testing-web-background-refresh.md).

Electron UI and desktop fixture entrypoints must load `scripts/fixture-background.cjs` (desktop scripts use the matching relative path) before importing `electron` or product modules. This test-only entry forces hidden windows, stops native windows from taking focus and disables background render throttling, so animation frames, DOM focus, keyboard/wheel input and screenshots of generated pages remain verifiable. On macOS it uses the accessory activation policy to avoid a Dock icon, not the prohibited policy, which blocks window creation. New and rebuilt windows and later `show()` / `focus()` calls follow the same rule. Normal product startup is unchanged.

```sh
# Generated-fixture regression for hidden windows, real input, animation frames, screenshots and window rebuilds
npm run test:background-ui
# Build the client, then run the real desktop UI and profile restart flows
npm run test:ui -w @mote/desktop
npm run test:profiles -w @mote/desktop
```

Cross-client visual consistency is compared by a person, not by automated checks. The commands below build the clients, capture the Home, Library, Source, Ask and Settings pages of Web (wide and phone) and Mac with generated data, and write a comparison page to `.mote/cross-client/index.html`. Android screenshots exported from the dedicated emulator as `home.png`, `library.png` and so on can be passed with `--android`. `packages/shared/test/ui-presentation.test.mjs` checks navigation names and icons automatically.

```sh
npm run snapshots:cross-client
npm run snapshots:cross-client -- --android /absolute/android-screens
```

Hidden windows do not hide native file pickers, message boxes or the external browser. A background fixture therefore fails on an unexpected native dialog or `shell.openExternal`; uncaught exceptions, including startup failures before `ready`, print the error and exit non-zero instead of letting Electron show its own error window. Tests that need these operations provide an explicit generated response, or record the target URL, after loading the entry. The native Chrome sign-in fixture already intercepts `/usr/bin/open`; do not silently choose cancel or bypass authorization to make a test pass. The Library test profile `interactive-400` names a data and interaction scenario; it also hides windows by default.

When you need to see the UI, set `MOTE_TEST_SHOW_UI=1` explicitly, for example:

```sh
MOTE_TEST_SHOW_UI=1 npm run test:ui -w @mote/desktop
```

The switch applies only to the test process: it shows fixture windows and allows native prompts, while existing generated dialog/browser responses keep their per-test behavior. An automated agent that needs foreground UI, system authorization or manual steps first explains why and what it affects; when the user explicitly asks to see the UI, do it directly. Hidden mode cannot replace checks that must run in the foreground, such as native focus, menus and system authorization; report those separately as not run.

## Android emulator

Android instrumentation and ADB UI checks prefer the dedicated, windowless `mote_fixture_api35` emulator. Start it in another terminal (adjust the SDK path to your machine):

```sh
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
  "${ANDROID_HOME:-$HOME/Library/Android/sdk}/emulator/emulator" \
  -avd mote_fixture_api35 -port 5580 -no-window -no-audio -read-only -no-snapshot-save
adb -s emulator-5580 wait-for-device
adb -s emulator-5580 shell getprop sys.boot_completed
```

After `sys.boot_completed` returns `1`, run the install, instrumentation or page-capture commands from [Android setup](android.md) with an explicit serial. `-no-window` hides the emulator window on the host; Android activities still run in the foreground inside the virtual device, so do not push the activity to the background, or the real page cannot be verified. `-no-audio` disables sound; `-read-only` and `-no-snapshot-save` avoid writing back to the AVD or its snapshots. If the port is taken, pick another free even port and update the serial to match; do not stop emulators this run did not start.

The emulator reads `http_proxy` from the process that starts it and can redirect TCP at the virtual network layer, even when Android's global proxy shows as empty. The command above removes inherited proxy variables only for the generated-fixture emulator, so local Central requests are not sent to a proxy; it does not change the host's proxy settings.

Existing Android E2E scripts attach to an emulator that is already running; they do not start it or hide existing windows. Do not run page-switching tests on a physical device that is in use; schedule and report physical-device or system-permission checks separately. When the run ends, clean up only the test processes and temporary directories it created.
