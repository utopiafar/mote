# Execution protocol

Mote persists each current workflow's domain phase and projects it into the shared
`execution` scheduling vocabulary for file jobs/steps, Memory jobs/batches,
query runs and insight runs. Domain phases carry details such as model admission,
input readiness, or user confirmation; they are required by the current workflow.
Unknown or retired phase names fail explicitly instead of becoming `queued`.

The projection answers four separate questions:

- `status`: waiting, queued, running, retry_wait, succeeded, failed,
  cancelled, or skipped;
- `failure`: a safe machine code plus recovery (`auto_retry`, `needs_action`,
  or `permanent`) and scope (`item`, `provider`, or `system`);
- `waiting`: why a run is waiting and which resource/action can unblock it;
- `allowedActions`: the controls the client may offer.

Central storage epoch 3 creates the current execution schema directly. It does
not run ALTER/backfill passes or persist a historical projection sidecar. The old
execution migration command has been removed. Restart recovery, dependency waits,
retry deadlines, cancellation fences, and lease ownership remain current runtime
behaviors. For the destructive MVP upgrade procedure, see
[compatibility cleanup](audits/compatibility-cleanup-2026-10-04.md).

The protocol deliberately does not classify user text or infer intent. The
only deterministic mappings are explicit persisted state/error codes and
transport/runtime boundaries.
