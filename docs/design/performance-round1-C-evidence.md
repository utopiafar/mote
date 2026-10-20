# Round 1 C: generated evidence and limitations

Source base/head: `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`. Branch:
`codex/perf-r1-c-storage-lifecycle`. These are baseline diagnostics and design
inputs, not an implemented optimization or a merge-ready module. Product sources,
existing tests, shared scripts, lockfile and real profiles remain unchanged.
See the [export plan](performance-round1-C-export-plan.md) and the independent
[WAL investigation boundary](performance-round1-C-wal-plan.md).

## Executed export evidence

NEW execution on macOS arm64, Node `v26.11.1`. The existing `keepFixture`
starts the real scoped builder and loopback HTTP server on port 0, creates generated
accounts and disables automatic processing. Generated binary files go through real
HTTP begin/part/commit and split Files export, then consumer gunzip/TAR parsing,
exact sizes and final SHA comparison. Unique MIME values are supplied by actual
upload metadata; no database row is rewritten to select these final cases.
The fixture uses ephemeral client credentials, not a browser cookie/UI session.

Data generation fills each 32-byte slice from SHA-256 of the UTF-8 string
`C_GENERATED_ONLY_` plus the decimal byte offset. No personal screenshot, document,
account, credential or model is used. Measurements instrument the existing Node
builtin imports before loading the unchanged product modules:

- Count `readFileSync` return bytes only for tracked Originals object FDs.
- Count SHA-256 `bytesHash` input bytes only in `Originals.readPart`, excluding
  directory `identityHash` and content-key fingerprints. This is part-verification
  hash work, not a count of every hash used anywhere in the process.
- Verify each decompressed exported member's final SHA against generated input.
  For every case, metadata export asserts zero object reads and zero part hashes.

| Case | Output bytes | Part reads / hashes | Logical file-read bytes | Part SHA input bytes | Instrumented HTTP wall ms |
| --- | --- | --- | --- | --- | --- |
| empty | 0 | 0 | 0 | 0 | 12.81 |
| short | 65,535 | 1 | 65,535 | 65,535 | 26.23 |
| full | 4,194,304 | 64 | 268,435,456 | 268,435,456 | 274.31 |
| tail | 4,194,341 | 65 | 268,435,493 | 268,435,493 | 264.41 |
| encrypted | 8,388,925 | 129 | 536,874,841 | 536,871,229 | 1758.11 |

```text
empty: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
short: c7a39775de6866de723aeb952d3b489bb9451a29ee7be4e9c06575d688b2687d
full: d9fdb8d5d2b6178029ac0e0ed61c72662a0d99dbe798040acdff0b1b4eac7cfe
tail: ed204bfc0e2ef979493143fb68de9416ec4bdde22c67b2bbf8023efffc94a8ee
encrypted: 1741fdae533c1ecfbbba88527a0d842a633fb45d0820df3677f9995bb69be9ed
```

The encrypted sample has two full parts and a 317-byte tail. Its 129 physical-file
API reads include 28 bytes of AES-GCM framing each; SHA input is plaintext. For a
full 4-MiB plaintext object, 64 output windows read/hash 256 MiB. These are **logical
read/hash bytes**, not physical disk traffic or a disk-read multiplier. Page-cache
state and physical block reads were not measured. Stack instrumentation adds
cost; the times are single-run diagnostic observations, not production latency,
a throughput comparison or a measured async improvement. Event-loop latency,
concurrent request responsiveness, CPU/RSS and an async candidate remain untested.

The same final run separately exercised the unchanged host reader after real HTTP
upload: read `[0,65536)`, mutate offset 4,194,303 of that part on disk, then read
`[65536,131072)`. The second read throws `conflict`, status 409, even though the
changed byte lies outside the requested output window. This directly demonstrates
the current next-window full-part corruption discovery. This witness is a direct
Ingress reader check, **not** an HTTP stream-mutation/cancellation test; that real
stream barrier is still required for a future candidate. No cache or larger-window
candidate was implemented or asserted equivalent.

## Executed WAL boundary evidence

NEW direct `openScopeStorage`/`assertScopeStorage` generated probes, SQLite
`3.53.4` under Node `v26.11.1`. The observed compile options
include `DEFAULT_SYNCHRONOUS=2`, `DEFAULT_WAL_SYNCHRONOUS=2`,
`DEFAULT_WAL_AUTOCHECKPOINT=1000`, `THREADSAFE=1`.

| Generated state | Actual result |
| --- | --- |
| New scoped database | `journal_mode=delete`, `synchronous=2` (FULL), auto-checkpoint 1000, page size 4096. |
| Existing current-format WAL after own writer SIGKILL | Reopens as WAL/FULL; committed generated row recovered; `integrity_check=ok`. Auto-checkpoint1000 and page size 4096 on reopened connection. |
| Wrong epoch with stopped uncheckpointed WAL/SHM | `unsupported_vault`,409. Main DB, WAL and SHM names, lengths, mode, mtime and SHA identical before/after rejected preflight. |

The child explicitly sets WAL/FULL and auto-checkpoint 0 **only in a new generated
fixture**, commits a generated row, and kills itself. No active same-process vault
is passed to preflight. The rejection snapshots contain exact per-file SHA in the
local JSON receipt; comparisons exclude access time. All generated directories
and owned children are removed/finished. This does not establish atomic preflight
against an active writer, every link/malformed failure, real product CLI/ACK
recovery, power-cut durability, online backup, backup/restore equivalence,
checkpoint performance, low disk behavior or network filesystem support.
No production WAL/FULL/checkpoint setting was changed.

## Commands, identities and cleanup

The local control directory is the frozen campaign `mote-performance-20261020-l33r5sf0`.
Let `CONTROL` denote that external orchestration directory; it is not a product
home override. Commands ran from this isolated worktree. `run-resource.py` supplies
C/tmp as `TMPDIR`; no product CLI or actual profile was launched.

```sh
python3 "$CONTROL/run-resource.py" --owner C --kind heavy --wait-seconds 60 -- npm ci --no-audit --no-fund
python3 "$CONTROL/run-resource.py" --owner C --kind heavy --wait-seconds 0 -- npm run build:libs
python3 "$CONTROL/run-resource.py" --owner C --kind heavy --wait-seconds 180 -- node --import tsx "$CONTROL/C/artifacts/run-evidence.mjs"
```

The combined final command imports the WAL probe, then the export probe
sequentially under one lease. Both finish with exit 0, `cleanupConfirmed:true`;
the gate confirms the entire process group has ended and releases lease
`5a78a31f-3984-48a1-965e-f3b9709c4377`. The independent local installation and
library `dist` outputs are retained in this worktree as prerequisites, not
committed. They do not count as Server/Web consumer checks.

Raw generated evidence/scripts remain in `CONTROL/C/artifacts` with these exact
identities; this documentation-only PR does not add a public executable harness:

| Local artifact | SHA-256 |
| --- | --- |
| `run-evidence.mjs` | `bca097dd01adb26815473f2bc92df15d69d09372ff2c4ed22be563b9f68f50fe` |
| `export-read-evidence.mjs` | `cdb74a634e016059390e340f4433de3119a7c69ab1e8df1c73b8d9338aa47827` |
| `export-read-evidence.json` | `0c22f29caf8b4cf209dabc2170e78fe9e03188c6de4f17d37c11d0ccc5afb658` |
| `wal-baseline-evidence.mjs` | `f19e09b09b2f4eea9f983563f925e48f6b1c0c4ce5eb099023c1c8a62d8cdbd6` |
| `wal-baseline-evidence.json` | `400f8cd0aadf8685bca361ef50f05e4ddb248786098085419e625f11b69312e4` |

Earlier diagnostic attempts are retained separately: export attempt 1 used a
nonexistent returned `storage.db` field; attempt 2 included directory identity
hashes; attempt 3 included content-key fingerprints. Their exit 1 results are not
PASS. The corrections fix instrumentation, preserve the real entry and exact
expected read/hash/size/SHA assertions, and do not relax a product test. A passed
intermediate run used a disposable MIME-row control; the final run above supplies
MIME through actual HTTP metadata instead and removes that extra DB connection.
The first WAL attempt failed its child-script quoting before WAL scenarios; its
source was corrected without changing any success assertion. Every acquired
failed-run process group/fixture was cleaned. Resource-occupied requests exited 75
`UNRUN` without executing a probe or stealing a lease.

REUSED evidence: none. The final command is newly executed. No complete
`check:affected`, `check:local`, whole repository test, UI/browser, physical device,
simulator, native app or live-model check ran. Documentation formatting/link/scope
checks and exact review receipts are recorded separately. The controller retains
final consumer/integration validation responsibility after any later implementation
and base/head rebind. Nothing here claims a delivered performance fix.
