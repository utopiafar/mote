# Android

- Kotlin owns capture permissions, lifecycle and durable transport. Use current-format single-owner state.
- Focused JVM test from the repository root: `apps/android/gradlew -p apps/android --no-daemon :app:testDebugUnitTest --tests 'actual.package.TestClass'`. Replace the placeholder with an existing affected class; no emulator is needed.
- Verify JDK/SDK and matching variant. Dev does not use Keystore; Prod does. Emulator work uses dedicated generated data with `-no-window -no-audio`; instrumentation requires an explicit device serial. JVM results do not establish native permissions, background capture or physical-device behavior.
- Translate new `moteText` keys and synchronize Android English strings.
- Test layers, triggers and evidence limits are defined in [testing](../../docs/testing.md); device commands are in [Android setup](../../docs/android.md).
