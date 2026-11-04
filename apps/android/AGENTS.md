# Android

Kotlin owns capture permissions, lifecycle and durable transport.

- Focused JVM test (repo root, no emulator needed): `apps/android/gradlew -p apps/android --no-daemon :app:testDebugUnitTest --tests 'actual.package.TestClass'`. Replace the placeholder with an existing affected class.
- Light contract against real Central responses (repo root): `node --import tsx apps/android/test-fixtures/central-kotlin-contract.ts`; add `--all-unit-tests` to run the ordinary JVM units in the same Gradle invocation. Needs built shared/Agent libraries and a matching Node SQLite ABI. Details: [runbook](../../docs/testing-runbook.md#android-intake-contract).
- Check the JDK/SDK and the matching build variant. Dev does not use Keystore; Prod does.
- Emulator work uses dedicated generated data with `-no-window -no-audio`; instrumentation needs an explicit device serial. Emulator setup: [runbook](../../docs/testing-runbook.md#android-emulator); device commands: [Android](../../docs/android.md).
- JVM results don't cover native permissions, background capture or physical-device behavior.
