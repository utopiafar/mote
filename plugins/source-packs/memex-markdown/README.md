# Memex Markdown Source Pack

An installed, fixed Python parser for `YYYY-MM-DD.md` exports containing a `# YYYY-MM-DD` heading and `## HH:MM:SS` entries. It preserves exact body slices, associates included local Markdown image links, and records every input's disposition. It does not classify intent, decide what becomes Memory, run captured instructions, or infer event dates from prose.

Register it in the node's private `MOTE_IMPORT_PYTHON_PACKS` JSON array:

```json
[
  {
    "id": "memex.markdown",
    "version": "1",
    "description": "Timestamped Memex Markdown exports with original image attachments",
    "packRoot": "/absolute/mote/plugins/source-packs/memex-markdown",
    "script": "main.py",
    "scriptSha256": "REPLACE_WITH_SHA256_OF_MAIN_PY",
    "pythonExecutable": "/Library/Developer/CommandLineTools/usr/bin/python3",
    "maxInputFiles": 256,
    "maxOutputBytes": 2097152,
    "config": { "timeZoneOffset": "+08:00" }
  }
]
```

Select the offset that actually applies to the export. It is required because the format has no zone; `recordedAt` explicitly records this configuration basis. `observedAt` is the host's current import time, and no `occurredAt` is invented. For exports spanning offset changes, split into explicitly configured inputs or extend the parser; a fixed offset is not an IANA time zone.

The host pins script bytes, expands ZIPs, stages read-only inputs, validates the returned records, preserves originals, authorizes reads and commits through its existing import engine. The parser sees random staged `path` values and untrusted `relativePath` metadata, never original absolute host paths. Its output references numeric input indexes. The default executor limit stays 16 files; this pack opts into 256, within the host's hard 4,000-file and 32 MiB staged-input limits. ZIP originals count alongside expanded files.

The executor defaults to 1 MiB JSON output; this pack opts into 2 MiB, within the 4 MiB hard limit, to accommodate a multi-month export without truncating originals. Its reviewed record manifest has its own host limit.

OS metadata and the export's `README.md` remain archived with explicit excluded dispositions. Unmatched files, malformed dated documents and unresolved images remain visible for review. The parser never fetches remote images. Duplicate timestamps in one document remain distinct; timestamp-looking headings inside fenced code remain literal body text. Unsupported Markdown image syntax stays in the source; this parser supports the export's simple inline local image links, not every CommonMark extension.

Use `sourcePackId: "memex.markdown"` when submitting the usual `/api/imports` request. No freeform import instruction is accepted with fixed parser code. A preview needing confirmation must be reviewed before publication. The pack adds no parallel storage, scheduler or model agent.

Generated integration coverage:

```sh
node --import tsx --test apps/server/test/memex-source-pack.test.ts
MOTE_TEST_PYTHON_OS_SANDBOX=1 node --import tsx --test apps/server/test/python-source-pack-executor.test.ts
```

An opt-in API runner, `scripts/test-import-journey.ts`, additionally verifies archived bytes, exact source slices, image associations, restart of a completed import and idempotent upload replay. It retains private output in a new directory outside Git. `--resume` can continue verification of a completed import using the same original and pinned parser; preceding reports are retained. It does not claim OCR, Memory, insight, in-flight recovery or UI validation.
