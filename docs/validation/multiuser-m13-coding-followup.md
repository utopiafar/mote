# M13 Coding completion follow-up

This is the bounded post-Draft follow-up requested for PR156. The earlier
complete affected check on5a remains EXIT1; no old platform gate is rerun or
reclassified. Production changes are restricted to the existing `PrivateSql`
gateway's compiled statement metadata. No M03/M05/M06/Memory processing policy,
input, task, authorization, output or public DTO is changed.

## Original failure and unchanged semantics

The original whole-gate Coding case failed at20.298s against its15s observation
window. Its real Material already had6 members/6 blocks with complete indexed
status, while the count of running/waiting `processing.pipeline`,
`processing.extract` and `memory.materials` tasks was not zero. The log did not
include the pending step identities. It is not evidence of a wrong-owner
publication, and its subsequent body/foreign/retained-byte assertions were not
reached in that failed run.

The unchanged original case passed narrowly7.236s and with real Coding SDK,
M06 text and Memory admission neighbors5/5 (Coding7.203s). Read-only diagnostic
copies then observed both owners' real pipelines/extractors/organizers converge
to zero; no stuck step or external provider/model call was found. Unrelated
`memory.intake` tasks remained at their real `memory_window_pending` state and
were never counted as completed work. The old whole timeout itself has not been
made reliably reproducible in isolation; do not call the older gate passing or
claim one conclusively established cause for it.

The actual test retains its original15,000ms end, six original records per owner,
exact complete member count and global zero-pending condition. All later genuine
human/final text, exclusion of tool/environment/analysis/unattributed/foreign
text, search isolation and exact retained M03 original-byte assertions remain.
The follow-up also checks the deadline *before* accepting zero pending, so a
late `tick()` completion cannot bypass the original window. Only on deadline
failure does it collect actual task kind/state/error/count metadata.

## Measured critical-path cost and minimal change

A Node24 CPU profile of the original real case attributes2.650s of8.856s to
`PrivateSql.statement` preparing SQL. A paired generated-host preparation observer
counts94,440 repeated owner-bound preparations before the change versus114 after
it, with the same163 distinct SQL strings overall. Corresponding original case
times are7.986s versus4.573s. These are observations, not a promised deployment
latency or proof that the previous full-gate load had only this cause.

The fix reuses only compiled statements per exact DatabaseSync connection and
SQL/read-or-write mode, with a bounded256-entry internal metadata map. Every
get/all/run still invokes captured authority, verifies the owner-binding syntax,
and supplies the current `$user` and positional arguments. Rows, grants and owner
bindings are not cached. Read/write variants remain separate so run bigint
metadata cannot alter a later get result type. SQLite reparses a statement after
schema replacement. The existing fixed pin disposer remains restricted to its
captured owner/id. No statement escapes the private gateway.

Durable regression `private-sql-preparation.test.ts` fails on the unchanged
baseline because64 identical owner-bound reads prepare64 times; its other
schema/pin boundary case passes. The first preliminary run had an unrelated
null-prototype row comparison setup mistake, corrected before the valid1fail/
1pass RED. The final tests also assert authorization on all64 calls, retired
get/all/run rejection, A/B equal-ID separation, current row updates, read/write
numeric type preservation, schema replacement and equal-owner/different-database
separation. Actual omitted-argument probing returns no prior bound row.

Baseline observer source is restored in `finally` with equal before/restored
SHA256. Temporary observer files are removed from the source tree and retained
only in `/tmp/m13-coding-observers`; they are not a second runtime or committed
production diagnostic.

## Direct validation receipts

- Valid preparation RED1fail/1pass: `/tmp/m13-private-sql-preparation-valid-red.log/.exit`.
- New safety regressions2/2, then directly affected private-data/lifecycle/task
  authority neighbors30/30: `/tmp/m13-private-sql-authority-neighbors-approved.log/.exit`.
  Initial sandbox29/30 stopped only at existing loopback listen EPERM; the same
  generated fixture suite received standard approval and passes unchanged.
- Original Coding/SDK/Memory/M06/trusted-ACK neighbors5/5 after the optimization:
  `/tmp/m13-coding-preparation-neighbors-green.log/.exit`; Coding4.963s.
- Complete original ingress/Coding files and new safety regression25/25:
  `/tmp/m13-coding-final-direct-files.log/.exit`. Alongside those real neighbors,
  three concurrent original-window repeats all pass12.734/12.860/12.763s in
  `/tmp/m13-coding-final-15s-{1,2,3}.log/.exit`. No deadline or data was expanded.
- Same finite baseline load also passes the original Coding cases (11.59–11.91s)
  and fails only the new repeated-preparation assertion. This explicitly limits
  the attribution: load-dependent wall time is variable; the preparation-count
  reduction is the directly demonstrated improvement. Receipt:
  `/tmp/m13-coding-baseline-load-source.json` and related logs.
- Matched final fixed workload: original three cases8.117/8.244/8.227s and
  complete directly affected files25/25 (Coding5.014s,26.632s process).
  `/tmp/m13-coding-fixed-load-{1,2,3,direct-files}.log/.exit` and
  `/tmp/m13-coding-fixed-load-source.json`. Each original still enforces the
  exact15,000ms deadline and complete Material/global task-zero/full body/
  owner isolation/original-byte semantics.
- Final omitted read/write-binding safety additions2/2 and strict test types0:
  `/tmp/m13-coding-preparation-final-safety.log/.exit` and
  `/tmp/m13-coding-preparation-strict-final.log/.exit`. These additions do not
  change runtime code after the matched direct checks.
- Server source noEmit0, scope0, fresh Central build0:
  `/tmp/m13-coding-optimization-types-final.log/.exit`,
  `/tmp/m13-coding-optimization-scope.log/.exit`,
  `/tmp/m13-coding-followup-build.log/.exit`.
- `check:affected --base 3a9178ec --dry-run` exits0 and maps only Central.
  `/tmp/m13-coding-followup-scope-plan.log/.exit` is a plan, not an executed
  passing macro gate. Per the parent's explicit limited follow-up instruction,
  the old complete platform gate is not rerun. The previously recorded full
  EXIT1 and the final same-version E2E/union requirement remain.

## Frozen ACK fixture consumption and remaining acceptance

M15's declared fixture-only33ce7b0b4111fcbbb1ce8a011e2a5e31ea181220 is selected
exactly into6f493fe4, without its unrelated Android document. The source matches
that frozen test: real HTTP parent ID, explicit parentstale, public generic
retry409, authenticated host-only acknowledgement, B rejection, no requeue or
fabricated physical completion, original live-occupancy409/calls1/Bpositive and
late completion/new operation success. No retry producer is changed or
rediagnosed. Its direct check passes with the Coding neighbors.

A Joint coordination message for this investigation was automatically rejected
before sending for lack of trusted human authorization of that exact cross-task
message. It is known NOT SENT; no retry/proxy or claim of peer receipt is made.
Local evidence and the final exact thin commits are available to the parent and
final E2E through this normal task delivery. The change does not touch Joint's
processing producer files.

No new whole-platform pass, final same-version union, or three independently
assigned KEEP controls is asserted by these direct checks. The prior gate's red
receipt remains authoritative for that older candidate.

## Exact finite commits

Base is published PR156 head3a9178ec8d2f7e98a4c1a0209dd8fc479c08503f.
The following commits are the entire follow-up source/test range; final receipt
changes after them are documentation-only.

- `6f493fe46a9c8d5b9452e7917591cfa403f1c10f` — exact frozen ACK test migration (skip if identical M15 33ce already selected).
- `cb4df1d0e1ac301b0c3bb092add08391028a47d7` — durable repeated-preparation regression.
- `26c35e1554e39d7b56a36e052690c9b8c335f6e8` — one-file compiled-SQL metadata reuse and original15s completion guard/diagnostic; no processing producer edits.
- `e712d051aed7f755ce938583df1dd3e025bc6107` — omitted-binding safety assertions; runtime unchanged.

The separately assigned KEEP owner has now delivered DraftPR158, runtime
e663d48d351cdc9c4c21b9039f2023ef5295021a/head1d33119b00eb91515ad9e24d356b937bbaa637bc.
Its direct32/UI5/strict/scope pass, but initialaad complete gate and finale663
Central increment both remain EXIT1. The latter has Server2847pass/1fail/2skip
(older ACK retry409!=200) and Web561/561; its later unchanged single-case pass
is not substituted. Source remains unselected in this Coding follow-up; final
C must compose the declared finite stack and the explicit ACK fixture migration.
See the updated KEEP matrix and `/tmp/mote-keep-controls-e2e-input.json`.
