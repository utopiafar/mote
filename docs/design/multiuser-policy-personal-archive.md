# Applied file plans in same-account personal archives

This bounded extension starts from Joint runtime
`a2cbf3aaf1ae2f2fbfe5f647cf9a4f23dfdc1695`. It follows the
[M16 personal merge contract](multiuser-lifecycle.md#personal-portable-3-import),
[M04 configuration authority](../adr-unified-configuration.md#responsibilities-and-transaction)
and [execution recovery fences](../adr-task-recovery-and-execution-budgets.md#failure-handling-contract).
It consumes no later Joint root/Imports/profile work.

| Disposition | Existing capability | This extension |
| --- | --- | --- |
| KEEP | One original deployment and account; complete portable-3 domain envelopes; atomic canonical merge; current configuration and execution domains preserved | Reuse the existing HTTP export/import, receipt, preflight and publication transaction. Foreign users/deployments remain rejected before admission. |
| KEEP | `mp_file_policies` is the M04 YAML effective projection | The configuration export already contains the credential-free policy graph. Personal import preserves current YAML, policy selection and model settings; it never writes this projection independently. |
| CHANGE | Processing export omitted all immutable applied plans and current bindings | Add an optional versioned `policyPlans` data section to the existing processing-v1 domain payload. Export all owned historical plans and bindings, with each binding's plan included. |
| KEEP | Existing per-file bindings and running controls win a personal merge | Insert missing immutable history; never replace a current binding or an existing local control. An immutable ID with different original/body conflicts and rolls back the whole import. |
| EXCEPTION | A restored original can have no surviving local file control | Give its newly restored plan binding a fresh file generation above the archived control and every surviving local task input for that original. This is a data fence, not task admission. Archived cancellation remains cancelled. |
| KEEP | Current local controls must not be silently advanced to fit old archive intent | If putting back a missing binding would revalidate an unfinished old task under an existing uncancelled local control, reject with an archive conflict. Current local cancellation remains authoritative. |
| REMOVE | Treating restored plan metadata as a model, processor, lease or task grant | Restore invokes no policy save/complete hook, admission, preview creation, model hydration, provider transport or task retry. No model selection fallback is inferred from a missing reference. |
| UNKNOWN | Final profiles/root/import/attachment override contracts, final clients and combined app/Hindsight archive | Separate owner composition and acceptance; this extension does not close those areas. |

## Wire shape and historical identity

The existing `mote-processing-v1` payload gains:

```ts
policyPlans?: {
  version: 1;
  plans: Array<{id: string; original_id: string; json: string}>;
  bindings: Array<{original_id: string; plan_id: string}>;
}
```

IDs are lowercase SHA-256-shaped historical admission identifiers. The JSON is
the frozen selected `{rule, profile, services, fingerprint, archiveOnly,
connections}` shape. Services contain only M04 reference kind/ID; connections
contain only reference kind/ID and optional historical fingerprint. Endpoints,
API keys, caller ownership fields, grants and unknown extra properties are not
part of these shapes. The existing full configuration export retains unselected
profile/service definitions; each applied plan contains only its selected
profile and referenced services.

The old plan ID formula also included the admission-time processor contract,
which was not saved in plan JSON. Import therefore does not claim to recompute
that complete historical ID from JSON or the currently installed processor.
It validates shape, rule/profile/service/connection closure, source/MIME and
original parent ownership, uniqueness, ID shape and exact immutable-ID content
conflicts. Removed processors and absent current M04 references do not prevent
restoration of historical data and do not authorize execution. Explicit later
processing still uses current M04 leasing, processor availability and normal
M05 admission/fences. No processor ID formula, stored plan JSON or SQL schema is
changed by this extension.

An old processing-v1 archive with no `policyPlans` remains valid and leaves
current plans untouched. Unknown section versions and malformed/incomplete
graphs reject. An empty section does not erase current data. Bindings must
reference a plan in that same archive section with the same original. All
original parents must exist under the authenticated owner after the earlier
canonical-domain publication. Equal IDs belonging only to another account do
not supply a parent. Import never selects another owner's rows.

## Publication, controls and external facts

The helper validates before its writes, inside the existing M16 SQLite
publication transaction. Earlier private-data/ingress writes and newly restored
original directories roll back if a later plan, review or import journal fails.
Plan and binding inserts have owner-qualified conflict handling. Repeated
operation IDs retain the host receipt/hash contract; new operation IDs dedupe
the same historical data and do not advance an already restored control.

Existing local bindings, controls, cancellations, settings, task inputs/results,
grant rows, leases, admissions, preview tokens, issued-call facts and replay
confirmations are preserved. A missing control receives a generation strictly
above surviving task generations, so reintroducing a plan ID cannot make an old
task current again. Integer exhaustion rejects rather than wrapping. Existing
local controls are never overwritten with archived generation/cancellation.
An existing binding must already have its correctly owned original/plan parent.
Import rejects a dangling local binding instead of filling a missing plan under
historical execution. Exporting/importing plans without bindings cannot bypass
that check; this is a local integrity conflict, not an implicit repair tool.
The existing M06 physical-activity guard continues to reject import beside an
unresolved call; import neither settles nor acknowledges that fact. Elapsed time
and restart are not evidence of physical settlement.

Deleting originals/account data retains the existing foreign-key cascades and
M06 deletion order for bindings, plans and policy projection. There is no new
private table or cleanup mechanism. Whole-instance stopped recovery remains the
separate M16 path; personal merging is not historical execution recovery.
