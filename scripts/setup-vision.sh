#!/bin/sh
set -eu
MOTE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MOTE_LLAMA_REVISION=1744c6bde8d687ce9774b3b54e688eee0bfdf5b7
MOTE_LLAMA_DIR="$MOTE_ROOT/vendor/llama.cpp"
MOTE_LLAMA_CREATED=0
if [ ! -d "$MOTE_LLAMA_DIR/.git" ]; then
  mkdir -p "$MOTE_ROOT/vendor"
  git clone --filter=blob:none --no-checkout https://github.com/ggml-org/llama.cpp.git "$MOTE_LLAMA_DIR"
  MOTE_LLAMA_CREATED=1
fi
# A fresh --no-checkout clone has no index/worktree yet: status reports every
# tracked path as deleted. Only this invocation's newly created clone may skip
# the dirty check; an existing checkout must retain the local-edit protection.
if [ "$MOTE_LLAMA_CREATED" -eq 0 ] && [ -n "$(git -C "$MOTE_LLAMA_DIR" status --porcelain)" ]; then
  echo 'llama.cpp has local edits; preserve them before updating this dependency.' >&2
  exit 1
fi
if ! git -C "$MOTE_LLAMA_DIR" cat-file -e "$MOTE_LLAMA_REVISION^{commit}" 2>/dev/null; then
  git -C "$MOTE_LLAMA_DIR" fetch --depth 1 https://github.com/ggml-org/llama.cpp.git "$MOTE_LLAMA_REVISION"
fi
git -C "$MOTE_LLAMA_DIR" checkout --detach "$MOTE_LLAMA_REVISION"
echo 'Pinned local vision source ready. Desktop requires CMake and Ninja; Android uses the SDK NDK/CMake.'
