# Execution protocol

Mote keeps the existing domain tables and wire fields for compatibility, and
adds an `execution` projection to file jobs/steps, Memory jobs/batches, query
runs and insight runs.

The projection answers four separate questions:

- `status`: waiting, queued, running, retry_wait, succeeded, failed,
  cancelled, or skipped;
- `failure`: a safe machine code plus recovery (`auto_retry`, `needs_action`,
  or `permanent`) and scope (`item`, `provider`, or `system`);
- `waiting`: why a run is waiting and which resource/action can unblock it;
- `allowedActions`: the controls the client may offer.

Older clients can continue reading `state`/`status`, `summary_state`, and the
existing error fields. Older SQLite archives are read through the same
normalizer; opening an archive does not rewrite evidence or derived artifacts.

If an operator wants to materialize the additive projection once, stop the
server and run:

```sh
node scripts/migrate-execution-state.mjs --data-dir /path/to/mote-data
```

The script makes a timestamped SQLite backup, runs in one transaction, and is
idempotent. Use `--dry-run` to inspect the number of rows that would change.

The protocol deliberately does not classify user text or infer intent. The
only deterministic mappings are explicit persisted state/error codes and
transport/runtime boundaries.
