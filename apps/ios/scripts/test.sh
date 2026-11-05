#!/bin/bash
set -euo pipefail

export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$IOS_DIR"

xcodegen generate
swift test --package-path MoteKit
DESTINATION="${MOTE_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17}"
XCODEBUILD_ARGS=(-destination "$DESTINATION")
if [[ -n "${MOTE_IOS_DERIVED_DATA_PATH:-}" ]]; then
  XCODEBUILD_ARGS+=(-derivedDataPath "$MOTE_IOS_DERIVED_DATA_PATH")
fi
xcodebuild test \
  -project Mote.xcodeproj \
  -scheme Mote \
  "${XCODEBUILD_ARGS[@]}" \
  CODE_SIGNING_ALLOWED=NO
