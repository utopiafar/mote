# iOS

Experimental SwiftUI client (Swift 6, iOS 18+); it is outside the first-release support matrix. Central, macOS and Android are formally supported.

- Focused core test (repo root): `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path apps/ios/MoteKit --filter MoteKitTests`. Select the affected test when possible.
- UI class commands and the full `apps/ios/scripts/test.sh` check are in the [iOS guide](../../docs/ios.md); choose coverage for the change under the shared [testing policy](../../docs/testing.md).
- Full Xcode, XcodeGen and a matching simulator are needed for UI work. `project.yml` owns the generated, untracked Xcode project.
- Use generated fixtures and isolated profiles. Simulator results do not establish physical-device, permission, extension or distribution behavior; the guide lists signing and device requirements.
