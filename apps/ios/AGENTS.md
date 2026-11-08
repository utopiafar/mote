# iOS

Experimental SwiftUI client (Swift 6, iOS 18+); it is outside the first-release support matrix. Central, macOS and Android are formally supported.

- Full check (repo root): `apps/ios/scripts/test.sh`. The script sets `DEVELOPER_DIR`, generates the Xcode project, runs MoteKit `swift test`, then simulator `xcodebuild test` with code signing disabled. It needs full Xcode at `/Applications/Xcode.app`, `xcodegen` and an available iPhone 17 simulator.
- Focused core tests (repo root):

  ```sh
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  swift test --package-path apps/ios/MoteKit
  swift test --package-path apps/ios/MoteKit --filter MoteKitTests
  ```

- One UI test class (repo root):

  ```sh
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  cd apps/ios
  xcodegen generate
  xcodebuild test \
    -project Mote.xcodeproj \
    -scheme Mote \
    -destination 'platform=iOS Simulator,name=iPhone 17' \
    -only-testing:MoteUITests/MoteUITests \
    CODE_SIGNING_ALLOWED=NO
  ```

- `apps/ios/project.yml` is the source of truth; `apps/ios/Mote.xcodeproj` is generated and untracked. Regenerate after project or build-setting changes.
- `apps/ios/**` changes are selected by root `npm run check:affected`; run the full iOS check when selected.
- Simulator covers build, MoteKit unit tests, UI tests, widget previews and Live Activity display. It does not cover device install, App Group shared containers, the share extension, Control Center/lock-screen controls or the action button, Siri/Shortcuts, background recording, TestFlight or distribution; those need an Apple developer account, valid signing and matching capabilities.
- Use generated fixtures and private temporary profiles only. Never read a real profile, screenshots or device data.
- Details: [iOS guide](../../docs/ios.md).
