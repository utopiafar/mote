#!/bin/bash
set -euo pipefail

# Usage:
#   scripts/test.sh            Run the Swift package tests and the full Xcode test scheme.
#   scripts/test.sh --screens  Run the UI-wave screen set (light/dark captures,
#                              accessibility sweep, destination walkthrough) and
#                              export the screenshots to .artifacts/ios-screens.

export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$IOS_DIR"

SCREENS=0
for argument in "$@"; do
  case "$argument" in
    --screens) SCREENS=1 ;;
    *)
      echo "unknown argument: $argument" >&2
      echo "usage: scripts/test.sh [--screens]" >&2
      exit 2
      ;;
  esac
done

xcodegen generate
swift test --package-path MoteKit

DESTINATION="${MOTE_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17}"
XCODEBUILD_ARGS=(-destination "$DESTINATION")
if [[ -n "${MOTE_IOS_DERIVED_DATA_PATH:-}" ]]; then
  XCODEBUILD_ARGS+=(-derivedDataPath "$MOTE_IOS_DERIVED_DATA_PATH")
fi
if [[ "$SCREENS" == "1" ]]; then
  RESULT_BUNDLE="$IOS_DIR/.artifacts/ios-screens.xcresult"
  rm -rf "$RESULT_BUNDLE"
  XCODEBUILD_ARGS+=(-resultBundlePath "$RESULT_BUNDLE")
  XCODEBUILD_ARGS+=(
    -only-testing:MoteUnitTests
    -only-testing:MoteUITests/MoteScreensUITests
    -only-testing:MoteUITests/MoteAccessibilityUITests
    -only-testing:MoteUITests/MoteDestinationUITests
  )
fi
xcodebuild test \
  -project Mote.xcodeproj \
  -scheme Mote \
  "${XCODEBUILD_ARGS[@]}" \
  CODE_SIGNING_ALLOWED=NO

if [[ "$SCREENS" == "1" ]]; then
  SCREEN_DIR="$IOS_DIR/.artifacts/ios-screens"
  rm -rf "$SCREEN_DIR"
  mkdir -p "$SCREEN_DIR/raw"
  xcrun xcresulttool export attachments --path "$RESULT_BUNDLE" --output-path "$SCREEN_DIR/raw"
  node "$SCRIPT_DIR/export-screens.mjs" "$SCREEN_DIR/raw" "$SCREEN_DIR"
  echo "Screens: $SCREEN_DIR"
fi
