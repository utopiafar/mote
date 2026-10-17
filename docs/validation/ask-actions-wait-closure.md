# Ask / Insight / Actions waiting failures

Final runtime/test commit: `d622a4f2fb2d187882483e92a65b642cda2572ac`.
The final complete required gate naturally exits **1**, with all original
Ask/Insight/Actions waits and all five new regressions passing inside it.
The complete gate is **RED**, not a splice of passing subsets.

| Final required stage | Actual terminal |
| --- | --- |
| i18n, Central builds and types | Exit0 |
| Shared | 192 pass,0 fail/skip |
| Agent | 317 pass,0 fail,1 existing opt-in skip |
| Server | 2797 pass,1 fail,2 existing skips /2800;1454.566s |
| Web | 515/515,0 fail/skip;41.572s |
| Later supervisor/release `&&` stages | Not reached in this failed invocation |
| Same frozen source, independently invoked supervisor / release | Exit0;52/52,0 fail/skip,exit0 |

Launched clean at documentation HEAD
`b944fafd70501bdf189b2ffa79e5300a347c0486`, source exactly finald622a4f2,
using its own Node24.21.0/ABI137 locked dependency installation.
`required-final.sha/.production.sha/.dirty/.log/.exit` retain the exact receipt.
Later commits change validation documentation only.

The sole final failure is `multiuser-file-unknown.test.ts`: “owner acknowledgement
cannot release a still-live physical original through a new processing operation”.
At line68 its generic child retry returns409 `task_retry_invalid` instead of the
fixture's200. The subsequent new-operation occupancy guard, B-positive and
post-settlement assertions are **not reached in that case**. It is not evidence
that an unknown physical call can be replayed. The identical original scenario
already fails409 on untoucheda2 in
`/tmp/mote-policy-archive-a2-additional3-baseline.log` (0/3 whole diagnostic list,
exit1,53.857s). Contract/fixture classification remains with M04/M05/M06/Joint;
this lane changes neither their backend nor this fixture.

The earlier complete e53787e2 gate fails a different inherited M06 summary-restart
case; that case passes in the final run. The earlier ACK pass and later summary
pass are **not combined into an aggregate green gate**. All historical REDs remain.

Inside the final complete run: ordered14.211s, narrowedInsight13.617s,
no-current-disclosure14.223s, pause/restart11.814s and failed-child retry11.383s;
real periodic Insight78.767s; unchanged-child admission8.997s and stale-conversation
while child held7.259s. All original waits/assertions remain. Memory1000 originals
passes50.226s and HTTP1000 import138.761s, with original120/300/390s and125 package
budgets/corpora unchanged. These timings are observed runs, not a new product SLA.

Existing skips: installed-Codex synthetic opt-in (Agent), configured pinned Python
Source Pack and macOS sandbox opt-in (Server). Physical client union and real-model
semantic quality are not acceptance claims of this module. No private Central data,
merge, deployment, CI enablement or real permission change is involved.

The following sections retain the investigation and failed candidates; final
terminal status and source above supersede their launch-time status.


The independent baseline is PR150
`67b992f32016ac5d31f4da265ff0e02cfb2e12bd` (production `2699d1f7`, test
freeze `371bd186`). PR151 `21e97819f275944e39025eadcdd7675e4610782d` and
the M15 checkpoint are read-only evidence, not composed source. Their complete
failed gates remain failed. Later Joint WIP is not consumed.

M08 production and the reader-race fixture at this baseline are byte-identical
to Joint `a2cbf3aaf1ae2f2fbfe5f647cf9a4f23dfdc1695`. The Ask fixture includes
PR150's explicit independent-branch retry setup and retained-sibling checkpoint
assertion; that setup still reproduces RED here. The final module changes four runtime/test files plus this ledger
and does not require the personal-archive implementation. The Draft comparison
against the old integration base includes pending module dependencies; consuming
owners should select the exact module commits below.

## Attribution

The original failed-child retry twice expires at its unchanged 20-second
`f.wait`. One run reaches the parent's two `delegation_read` calls after the
retried child succeeded; another reaches the retry/yield fragment. This is a real
completion wait, before final owner/citation assertions. It does not establish an
infinite yield loop. SQL-template-only observation records 832,878 prepares and
16.147 seconds in SQLite, including 161,107 account reads, 113,985 task reads
and 658 pin-journal UPDATE executions. No bindings or payloads are recorded.

The original Actions catalog failure waits for a real completed `ac_jobs` entry
for `other-source`. Its three original cases pass here, preserving all-source
filtering before LIMIT, Unicode tail, model-selected sameAs and B-positive. The
original Web immutable-review case also passes with the official Web JSX config.
An initial direct invocation omitted that config and failed with `React is not
defined`; it is an environment invocation failure, retained separately.

Memory 1000/125 packaging, 120/300/390-second pressure budgets, M06 image/summary
prerequisites, unknown physical calls and unrelated fixtures are unchanged.
Their historical failures are not reclassified by these results.

## Mechanism and preserved authority

KEEP every PrivateSql statement's current identity check and owner binding,
source/receipt/version checks, model-transport and publication fences, finite
model correction, child checkpoints and original observation budgets. CHANGE
compound caller-proof checking from every internal SQL to the existing logical
read and asynchronous-return boundaries. REMOVE repeated expansion of the entire
outer proof inside one synchronous read, and identical journal writes on repeated
evidence observation. EXCEPTION: generated external responses and temporary
audit triggers. UNKNOWN: live-model quality and whole-system final acceptance.

`AskHost.evidence` gives `AskEvidence` the same domain assertion. SQL retains
`AskHost.sql`/PrivateSql identity and domain-liveness checks. The public read
binding revalidates all accumulated original, Material, Memory and artifact pins
after awaits and before return. Background work retains its task context,
admitted run generation and final publication proof. No permission, result or
time-window cache is introduced. Complete proof revalidation is now a separate
read-only synchronous traversal, enclosed by the same full task/run checks; it
does not recursively re-enter those checks or observe pins again. Every SQL in
that traversal still revalidates current identity and cancellation remains active. This follows the current-boundary requirements
in the [scope ADR](../adr-multiuser-scope.md) and
[Ask evidence ADR](../adr-ask-evidence-quality-and-simple-context.md).

`accumulate` still compares existing fingerprints, receipts and Material identity
inside its transaction. It writes only when a genuinely new pin or Material was
added. No successful child or first original receipt is replaced.

No M04/M05/M06, account, authority, PrivateSql, executor, lockfile, protocol,
provider, timeout, workload size or client source changes are made. Public-layer
coordination messages to Joint returned submission-unconfirmed; no shared-layer
optimization was attempted without confirmed coordination.

## Actual local receipts

These generated-fixture files live in task-14 outside Git. No private Central
database or derived private data was read, committed or attached.

| Receipt | Actual result |
| --- | --- |
| `ask-original-red.log/.exit`, baseline67b | 1 pass / 1 fail, exit1, 43.665s; original retry20s RED. |
| `ask-retry-profile.log/.exit`, baseline67b | 0/1, exit1, 24.482s including setup/cleanup. |
| `ask-sql-original.log/.exit`, baseline67b | RED, SQL counts above in `sqlite-observer-54892.json`. |
| `ask-pin-journal-red.log/.exit` | New real-Harness audit trigger: 0/1, exit1, 12.564s; 96 identical journal writes. |
| `ask-pin-candidate.log/.exit`,04fa9ce3 | 2/2, exit0, 31.901s. Insufficient closure: subsequent six-case run fails. |
| `ask-delegated-candidate.log/.exit`,04fa9ce3 | 5 pass / 1 fail, exit1; retry again expires at20s. |
| `ask-domain-fence-candidate.log/.exit`, candidate productione53787e2 | 7/7, exit0, 98.785s, no skip/cancel. Includes original ordered, narrowed Insight, no-disclosure, pause/restart, failed-child, any-child cancellation and pin-journal scenarios. |
| `ask-actions-fence-neighbors.log/.exit`, same production | 20/20, exit0, 68.770s; external provider waits, same-ID recreation, source-context change, conversation deletion, catalog-source revocation and native ACK fences. |
| `ask-caller-fence-final.log/.exit`,e53787e2 | 2/2, exit0, 9.093s; caller-policy revocation and request abort during actual provider await while account identity remains current; A body rejected, B-positive and foreign-ref rejection. |
| `ask-sql-final.log/.exit`,e53787e2 | Original retry1/1, exit0, 18.907s; same observer records727,634 prepares,12.142s SQLite and2 pin UPDATEs. One comparison, not a latency distribution. |
| `actions-catalog-original.log/.exit` | Original3/3, exit0, 107.060s. |
| `actions-original-web.log/.exit` | Original immutable review1/1, exit0, 19.914s with Web config. |

Installed Node24.21.0/ABI137 is under
`/tmp/mote-node24-runtime-20261014/node-v24.21.0-darwin-arm64`. This checkout's
locked dependencies were installed offline with scripts suppressed, then its own
better-sqlite3 compiled with local24.21 headers. Root and the actual
`apps/server/node_modules/mem0ai/dist/oss/index.js` entry both construct/read/write
their resolved SQLite, using this checkout's root better-sqlite3.
`native-preflight.json` and `native-preflight-before-gate.json` record executable,
ABI, full module/native paths and inode. No peer dependency was linked or rebuilt.

Two host samples at05:55 UTC show32.85–36.24% CPU idle, zero interval swap activity
and about5.6GiB unused RAM. They do not establish a resource cause or justify global
throttling. No other healthy test was stopped.

## Additional RED and final candidate

The exact a2 three-file projection of e53787e2 is **3 pass / 1 fail**, exit1,
41.982s (`minimal-a2-critical.log`). The original retry20s expires again while the
parent resumes after its retried child. Therefore e53787e2 is an insufficient
candidate even though its seven-case list passed. No isolated pass is promoted
into stable closure.

A second generated audit trigger observes actual `ask.coordinate` lease claims.
While a real child remains physically held and unchanged, the old coordinator
claims two additional leases in400ms (34 vs32): `ask-admission-red.log/.exit`,
0/1, exit1,15.383s. RED commit
`87be8907` retains this test. The correction uses the existing M05 **admission**
hook and the same100ms wait; unchanged child/fragment state does not mint a new
running lease or context. New/missing/replaced units, ready any/all waits, terminal
failures and publishable fragments still enter normal execution. All queries use
the engine's durable owner and no grant is reconstructed from a userId.
There is no executor, scheduler, retry-policy, timeout or physical-call change.

`ask-admission-green.log/.exit` is2/2, exit0,38.439s on the intermediate projection.
The following complete-proof read-only improvement records the original retry1/1,
exit0,18.045s with538,545 prepares and10.960s SQLite
(`ask-pure-recheck-profile.log`, diagnostic projection before final defensive
JSON-shape hardening). The intermediate production/test freeze was
`2fdcef08782d1ea504164e164f520e9f5c2acb6c`.
Its complete Ask/Insight and reader-neighbor suite, exact a2 minimal projection,
original Web Actions consumers and required gate are reported separately below.

The intermediate a2 patch contains only four M08 files, including PR150's eight additions/five removals
fixture delta. SHA256 of local `next-minimal-a2.patch`:
`9c7eb425798736bd55181a3502ad618f05aee7aef8a95e88364fed217fbd6307`.
It excludes all personal-archive and image runtime changes. Root lock, Shared
and Agent source are byte-identical between a2 and67b; only this task's own
ABI-verified dependencies are linked into the disposable projection.

## Required gates and consumable commits

The first clean source `e53787e2edc1951e6b24474bb3a42efaadc95c66` runs once:

```sh
npm run check:affected -- --base 67b992f32016ac5d31f4da265ff0e02cfb2e12bd
```

The selector chooses i18n and the full Central build/type/Shared/Agent/Server/Web/
supervisor/release chain. `required.sha`, `required.dirty`, `required.log` and
`required.exit` retain source, clean status and natural terminal result. The
terminal result is exit1 as recorded below; it remains independent of the later candidate.
The later guarded candidate has its own full gate; no first-run outcome
substitutes for that source. Narrow receipts do not establish full acceptance. Native
client union, real-model semantics, merge, deployment and CI are not claimed.

Module commits (select after the stated fixture baseline):

- RED `31a75095874a579443392342d9318e0a50fd6396`.
- Journal fix `04fa9ce31aab86f50306b3817a8ffd4ed6dfb63c`.
- Compound-fence fix and held-await neighbors
  `e53787e2edc1951e6b24474bb3a42efaadc95c66`.
- Lease-churn RED `87be8907` and final admission/read-only proof fix
  `2fdcef08782d1ea504164e164f520e9f5c2acb6c`.

Delivery records the Draft URL and verified remote exact head/base. Nothing is
merged into integration or main.


## Final admission boundary and source freeze

Intermediate2fdcef08's complete Ask/Insight/reader/catalog-source suite is64/64,
exit0,423.866s (`next-ask-full-neighbors.log`), including the real61-second
periodic Insight and all original delegated waits. Its exact four-file a2
projection is5/5, exit0,40.829s (`next-minimal-a2-critical.log`). Original Web
paging and immutable review are2/2, exit0,34.090s; the native review-target file
is3/3, exit0,33.578s. Server noEmit and scope checks exit0.

A further real journey caught a regression in that **new admission candidate**,
not in a2: a competing turn completes while the original child remains held,
but the old coordinator keeps waiting rather than rejecting the changed
conversation. `ask-admission-conversation-red.log/.exit`:0/1,exit1,30.403s with
the original20s wait. RED commit `61c09bad` retains the scenario. The minimal
predicate correction lets a deleted Ask domain or changed conversation scope,
incarnation or revision enter the existing `execute/current` rejection path
immediately. It creates no context, repairs no old grant and does not wait for
physical child settlement. The three-case corrected projection (original retry,
unchanged-child lease stability, changed conversation while held) passes3/3,
exit0,37.616s (`ask-admission-conversation-green.log`). Its four M08 files are
byte-identical to final `d622a4f2fb2d187882483e92a65b642cda2572ac`, recorded in
`final-projection-source-receipt.json`; this mapping does not pretend the later
Git commit already existed at projection launch.

Final runtime/test freeze: `d622a4f2fb2d187882483e92a65b642cda2572ac`. The
final complete affected gate uses distinct `required-final.log/.exit/.sha/.dirty`
receipts and the same base67b992f3 command. Its natural terminal result is recorded above. First-gate
`required.*` remains separate on runtimee53787e2. Neither whole run is interrupted
or reported green before its natural terminal result.


## First full terminal and dependency-layout correction

The complete e53787e2 gate naturally exits1: Shared192/192; Agent317pass/1skip;
Server2795pass/1fail/2skip out of2798,1460.716s; Web515/515,46.409s. All original
Ask/Insight/Actions waits pass inside that whole run, including retry17.620s,
periodic Insight77.378s and catalog18.720s. The unchanged1000-original cases
pass70.712s and175.899s with their original budgets and125 packaging unchanged.
The sole remaining failure is the already recorded M06 summary-page restart:
`processing.analysis` becomes `stale/input_changed` after `provider_unavailable`,
retaining its checkpoint and one unresolved fact. Its original a2 reproduction
remains in PR150's retained evidence; this lane does not change M04/M05/M06.
The failed Central workspace command prevents its later supervisor/release
`&&` stages from running in that invocation. No full-green claim is made.

The first final-candidate attempt used this task's other checkout's dependency
links. That was an environment error: a direct relative Agent import and
`@mote/agent` resolved different physical modules and different ContextToolError
classes. The unchanged legacy bridge case reproduced `context_tool_failed`
instead of `invalid_delegation_arguments`: `next-delegation-env-red.log`,0/1,
exit1,1.531s; `next-module-identity-red.json` records different paths/false.
It does not run through M08 production. After this exact proof, only that owned
invalid-environment runner and its verified15 descendants received SIGTERM;
`required-final-env-interruption.json` retains identities/reason, with no KILL.
The earlier healthy gate was excluded and naturally finished as above.
`required-final-linked-env.*` retains the interrupted candidate's actual143;
cancellation output is not a complete suite or a product failure count.

The final worktree now has its **own** offline lockfile installation and local
ABI137 native build, including all three nested workspace dependency trees.
No source, assertion, lockfile or peer dependency changes were needed. Actual
root/mem0 constructor-read-write and module-identity checks pass; alias and
relative Agent paths now resolve inside next-candidate and classes are identical.
The unchanged whole delegation-proposal file passes3/3 in
`next-delegation-env-green.log`. Fresh final gate receipts use `required-final.*`;
all interrupted evidence remains separately named.

Final a2 four-file patch SHA256:
`6d8a01a0746ffe5cd22199bc27b68aedeabbfadde9cb00a13fa63b0feff6ce17`.
Module-only patch against67b SHA256:
`d9a439375832f7855a32fe5d1600949adab05bd3ebad398f02ef02565ec059bb`.


## Exact source consumption

Select these seven source/test commits after the stated fixture baseline;
documentation commits are independent:

- `31a75095874a579443392342d9318e0a50fd6396` — test(ask): expose repeated writes while rechecking pinned originals.
- `04fa9ce31aab86f50306b3817a8ffd4ed6dfb63c` — fix(ask): avoid rewriting unchanged persistent evidence pins.
- `e53787e2edc1951e6b24474bb3a42efaadc95c66` — fix(ask): bound compound evidence checks to read and publication fences.
- `87be8907fc9f84128f244d75b08891e020d33b7f` — test(ask): expose coordinator lease churn while children remain pending.
- `2fdcef08782d1ea504164e164f520e9f5c2acb6c` — fix(ask): wait at admission and recheck complete proofs without recursive observation.
- `61c09bad71103b7046151c69601f3385631b3e3b` — test(ask): expose stale conversation hidden by pending-child admission.
- `d622a4f2fb2d187882483e92a65b642cda2572ac` — fix(ask): preserve stale-input rejection while children wait at admission.

The four-file a2 patch (including the declared PR150 test-only delta) has SHA256
`6d8a01a0746ffe5cd22199bc27b68aedeabbfadde9cb00a13fa63b0feff6ce17`.
The module-only patch against67b has SHA256
`d9a439375832f7855a32fe5d1600949adab05bd3ebad398f02ef02565ec059bb`.
No personal-archive/image implementation or later Joint WIP is required.

The independent release check initially encountered sandbox loopbackEPERM, then
50pass/2skip because the installed Docker CLI directory was absent from the
constructed PATH. Both environment receipts are retained separately. With the
installed CLI restored to PATH, the exact unchanged52-case list executes52/52,
zero skip,exit0. Only offline Compose `config` checks run; no Docker service or
volume is started or changed. This does not rewrite the failed Central command.
