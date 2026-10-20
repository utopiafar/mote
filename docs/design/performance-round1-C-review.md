# Round 1 C: independent plan review receipt

Reviewer: `/root/independent_plan_review`, independent `gpt-6.1-sol`, High.
The reviewer read the plans, frozen source, consumers, existing tests, generated
probe scripts/JSON and resource cleanup evidence. The reviewer did not implement,
install, build, run tests or rerun C's diagnostics. Original implementation owner
remains C. No product implementation occurred before or after this review.

## Review history and exact identity

Both reviews bind source base/head
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.

| Review | Exact documentation identity | Decision |
| --- | --- | --- |
| Initial | Working plan SHA `fca0b158cb93ec643dda35b5300587053475298d3f8b1a6f307de1efc68d06d3`; source HEAD unchanged | Export `CHANGES_REQUESTED`: define early cancellation, pending-next cleanup, unconditional FD cleanup and host shutdown drain; do not claim a not-yet-executed witness or link a missing report. WAL investigation `APPROVE`. |
| Bounded export delta | Commit `d377d65d94f7fb84099a60c5e2a4e6c2f58a529a` | Export `APPROVE`. WAL investigation `APPROVE`, without production enablement. |

Final reviewed text identities:

| Document | Reviewed SHA-256 |
| --- | --- |
| [Export plan](performance-round1-C-export-plan.md) | `6f0e903a7b3f6b7909cb3bb4a3aa93b292bd40555ddf2cc40ff02909f232dcc7` |
| [WAL plan](performance-round1-C-wal-plan.md) | `5c40c8b53fabc9ff882f50ad7a4fe0672735d67cafe55e219886a72d4d9fbebf` |
| [Evidence](performance-round1-C-evidence.md), as reviewed at d377d65d | `fdc404a18a6fb46b385d126734f26de51398bf7d86e3e8688168f39cef933f1b` |

After that reviewed commit, `59f581e5ac647027982c3e7d474c932cf45df23c` only
adds readability spaces to evidence units/result wording, such as `exit 0` and
`status 409`. Its evidence-text SHA is
`31dc60ebf700860452e32543c2f1769f88b272210938d769fed35fa782896533`.
Both plan hashes, product sources, probe scripts, commands, raw JSON, numbers,
assertions, scope and limitations are unchanged. This is a recorded documentation
delta; the approval remains attached to the exact reviewed commit/text above,
not falsely reported as a newly executed review on a later SHA. This receipt
only records the review and introduces no new design decision.

## Approved scope and boundaries

The export direction preserves 64 KiB windows and fresh full-part read/decrypt/
checksum validation for every window. Only raw split export may adopt bounded
asynchronous FS/SHA. Cancellation first signals pending work, then waits for
`next()`/`return()`/native work to settle; acquired FDs close without current
account authority. IngressHost uniquely owns its app's admissions and drain;
C-owned app composition must await that drain before shared database close.
No cache, enlarged window, new pin/grant/export job or other-reader adoption is
approved. Repeated logical read/hash work remains; responsiveness is a separate,
currently unverified target.

The shared TAR adapter remains controller owned. The controller's response
`C-file-export-tar.json` reserves that ownership and requires actual integration
base/head rebinding before second-round implementation. All existing synchronous
consumers and async authority, cancellation, error and backpressure boundaries
must be included. Round1 approval does not authorize Round2 implementation.

WAL approval covers only generated mode probes, stopped uncheckpointed fixtures,
current-WAL reopen and unsupported-epoch rejection without modifying original
files. It does not approve production WAL, production pragmas, checkpoint policy,
startup/preflight changes, backup/restore or new failure policy. Future enablement
requires a separate delta review and resolution of its product/deployment unknowns.

## Evidence and remaining work

The reviewer confirmed the five export cases, direct reader mutation's actual
409, three WAL probes, artifact hashes and final gate exit 0/cleanup record.
Those are NEW executions by C; the reviewer did not rerun them. Failed attempts
and resource-occupied UNRUN results remain distinct. No test evidence is REUSED.

Unverified: async performance and peak resources; real HTTP mutation/cancellation;
snapshot/pin deadline and shutdown implementation; actual CLI/ACK recovery, locks,
backup/restore, low disk, power loss and filesystem support for WAL; UI, native,
physical device and live models. Module-directed evidence only; unified
consumer/integration validation remains with the controller's single driver.
