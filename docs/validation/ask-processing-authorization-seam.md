# Independent Ask / processing authorization seam acceptance

This lane verifies the composition of PR153's synchronous evidence optimization
and the approved bounded M05/M06 dependency handoff. It adds one regression file;
it changes no production source. These are synthetic local acceptance results,
not final multi-client, live-model or whole-project acceptance.

## Exact composition and consumption

The complete frozen Joint ancestry is
`073807a9821a169b41e507c6a06417e3260ba524`. This exact SHA was supplied by the
delegating owner. Relevant changes include the approved contract
`4c0770d33def94ebb4bde5c619011135db58bc96`, new-authority implementation
`ecc5d6928fe6542e8880dc3facc48578575ed9b4`, summary-retry preparation
`736e6b625032c78272c1c06460b2efe3fdda731a`, and queued-recheck correction
`073807a9821a169b41e507c6a06417e3260ba524`. Those four identifiers describe the
mechanisms; they are **not** a standalone minimal cherry-pick recipe. Consume
the full frozen ancestry, or independently establish equivalent prerequisite
source in the final union. No later Joint HEAD or worktree WIP was read.

On that base, select PR153's ordered module commits:

1. `31a75095874a579443392342d9318e0a50fd6396`
2. `04fa9ce31aab86f50306b3817a8ffd4ed6dfb63c`
3. `e53787e2edc1951e6b24474bb3a42efaadc95c66`
4. `87be8907fc9f84128f244d75b08891e020d33b7f`
5. `2fdcef08782d1ea504164e164f520e9f5c2acb6c`
6. `61c09bad71103b7046151c69601f3385631b3e3b`
7. `d622a4f2fb2d187882483e92a65b642cda2572ac`

The resulting local runtime is
`ac8896b1f6836d814575a5a1180ddb02d2cf541b`. Both Ask production files exactly
match PR153's supplied consumption manifest:

| File | SHA256 |
| --- | --- |
| `apps/server/src/scope/ask.ts` | `d410b15772a1af657ecd5411a63052069f1d35642697114ab04b2a4160257e44` |
| `apps/server/src/scope/ask-schema.ts` | `4e1048e68f8b64df04d880f2c10e99e91051d6d44c5610de532997faf2de735d` |

Only this lane's later test/document commit needs selecting into an equivalent
final union. Its independent test is
[`multiuser-ask-processing-authorization-seam.test.ts`](../../apps/server/test/multiuser-ask-processing-authorization-seam.test.ts).

## Actual journeys and boundaries

Every new case runs a real loopback HTTP listener, generated upload bytes, real
authentication routes, configuration saves, host services, the shared executor,
and read-only observations of the owned temporary SQLite database. The external
Memory read uses the installed generated provider fixture and its actual worker
barrier. The second barrier wraps the real M04 dependency refresh **after** it
returns under a genuinely running M05 control context. No grants, domain records,
account epochs or publications are fabricated in SQL.

| Case | Expected boundary, actually asserted |
| --- | --- |
| Source withdrawal during both awaits | Old Ask body rejected; held recheck admits no new pipeline or provider call. |
| Password reset / account epoch change | Old request and control authority rejected; B remains usable. |
| File cancellation plus request abort | Processing cancellation fences re-admission; aborted Ask discloses no body. |
| Forget / allow again / identical same-ID re-upload | Old original receipt rejected; new incarnation succeeds exactly once from a new owner intent, with no old `intentTaskId`. |
| Caller policy changes with current account | Ask rejects the old body; independently authorized M06 continuation succeeds once. |
| Actual unresolved external issuance | Unknown journal entry exists; dependency changes and restart mint no recheck context and do not replay external work; current unrelated Ask evidence remains readable. |
| Completed processing intent | Dependency changes and restart do not revive it; current Ask evidence remains readable. |

All cases use colliding A/B material and file IDs. They verify B's unchanged
chunks, one private B provider call, and B's own same-ID Ask body. Successful
synchronous repeated evidence reads retain A's own body. Duplicate reload
notifications retain the same control count. Every case also waits for an actual
periodic dependency-observer invocation after restarting the real host, then
checks settled controls and unchanged pipeline/provider counts. The held control has a new grant,
an actual running lease/fence, no model receipt, and no external-call journal
entry. Restoring the stopped original grant and HTTP submission of a forged
`processing.recheck` carrying A's `userId` through B are rejected.

Synchronous proof traversal and unchanged persistent pin writes may be deduplicated
within one operation. Identity checks still apply to every private SQL statement.
Neither that optimization nor an earlier successful control admission survives
an asynchronous return without current account, source, incarnation, cancellation
and caller/run checks. Caller-policy retirement does not cancel independent
already-authorized processing; unresolved processing I/O does not remove current
authority to read unrelated retained evidence.

## Terminal results on the composed runtime

| Invocation | Actual result |
| --- | --- |
| Final combined matrix, including periodic restart observation | 7 pass, 0 fail/skip/cancel; 50.059s, exit 0. |
| Original Ask reader races + Joint dependency fences | 21 pass, 0 fail/skip/cancel; 92.053s, exit 0. |
| Frozen active-session / logout-restart / queued barrier | 3 pass, 0 fail/skip/cancel; 13.977s, exit 0. |
| PR153 pin journal / lease stability / stale conversation + restored queued barrier | 4 pass, 0 fail/skip/cancel; 24.802s, exit 0. |

The three PR153 pin-journal / unchanged-child lease / stale-conversation boundary
regressions and the restored queued barrier are also run together. Their separate
terminal receipt is `optimization-boundaries.log/.exit`; it does not replace any
whole-suite result.

A separate diagnostic projected **only** the two production files changed by
073 back to parent `9655333994fdda1756294c32f9d28065ab676ebe`, retaining the
final queued regression and composed Ask runtime. It actually fails 0/1, exit 1,
at the applied-plan/current-shared-generation equality assertion. The later
duplicate-call assertion is not reached in that RED. Both files were restored
byte-for-byte in a `finally` block before the final boundary run; no production
changes are included in this delivery.

## Build blockers and limits

The required `npm run check:affected -- --base ac8896b1f6836d814575a5a1180ddb02d2cf541b`
selects Central only and exits **1** at i18n, both before and after the final test
strengthening. Two existing `ImageProgress.tsx`
keys lack English entries: `提交结果待确认；重试会使用原操作，不会重新创建任务。`
and `移除本机待确认提交`. The later Central chain is not reached.

An independent Server `typecheck` exits **2** in the unchanged frozen
`processing-images.ts`: line 43 has `flatMap` inference for optional `error`,
and lines 56–57 use un-narrowed SQLite output values as strings. A separate
strict compilation including the new test reports these existing source errors
and existing `scoped-query-accounts.ts` fixture typing errors; it reports no
diagnostic in the new test. These failures remain RED; this lane does not repair
another owner's production or fixture code.

Joint notification attempts return “An earlier turn submission is not yet
confirmed”; delivery to the final E2E owner is confirmed. The new tests and exact
source receipt are ready for the final candidate; fresh full acceptance requires
the corresponding owners' explicit frozen fixes. The physical ACK fixture remains
Joint's scope and is not rerun or changed by this lane.

### Test-only Draft publication and missing-consumer check

The owner subsequently explicitly authorized publishing this test patch as a
Draft despite these baseline failures. The publication branch starts directly
at integration `6272a9b51ec92cc4c32e2ff1a1eeb4fa38b142ed` and contains only this
test and document; it deliberately does not import the prerequisite production
ancestry. The test body is byte-identical to locally tested commit
`b4672adce50ee7739bda65f1e0f67b5e55999e20`. Integration alone is not the tested
runtime. This Draft is a consumable regression patch, not a merge-ready final
runtime, and no green check is claimed for the publication branch.

A bounded read-only check establishes that the two missing English entries are
already delivered by `6376aefa4` in PR151's exact remote head
`21e97819f275944e39025eadcdd7675e4610782d`, in
`packages/shared/src/i18n-en.ts`. The frozen 073 composition omitted those
catalog entries. Reimplementing their translations is unnecessary.

The image consumer's explicitly public frozen checkpoint
`5563c30ab01da7e1b2a8819278e530fb7c0922ba` also includes the typed image
projection from `9e8a910b86b5be66a24662d8b5e84683ca3b53d9`: explicit `flatMap`
result typing and string-normalized named products. Producer
`dcac72341004e6008ed24c1b1ca48eee625756d2` separately adds the `jobs` result
type. The later consumer includes other receipt behavior and prerequisites;
this lane does not select a partial overwrite or claim its runtime was tested
here. Joint and M13 must compose their exact reviewed dependency closure and
produce a new frozen candidate. The original type/i18n RED receipts above remain
unchanged. The precise failures and these source identities were sent to both
owners; M13 submission is confirmed, Joint submission remains unconfirmed.

The independent clone owns its lockfile installation, all workspace package
links and its SQLite binary. Node 26.11.1 / ABI 147 root and actual server mem0
resolution both construct/write/read the same owned `better-sqlite3`; Agent
alias/relative `ContextToolError` class identity is identical. No peer dependency
tree is linked. This verifies this environment, not every Node 24 build.

Receipts live outside Git in this task's directory, including
`native-preflight.json`, `seam-final.log/.exit`, `fence-neighbors.log/.exit`,
`baseline-focused-network.log`, `optimization-boundaries.log/.exit`,
`queued-before-fix-receipt.json`, `server-types.log/.exit`, and
`affected.log/.exit` / `affected-final.log/.exit`.
Initial sandbox loopback EPERM is retained separately as an environment failure.
One wrong-working-directory runner failed before loading `tsx` and was corrected;
it is not a product-test result. No private Central data or its
derivatives were read, committed, attached or transmitted. No real credentials,
account privileges, model login, merge, deployment or CI state were changed.
