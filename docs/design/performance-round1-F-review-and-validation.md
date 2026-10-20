# F round-one review and validation record

Module: Android configuration, queue and upload. Frozen base:
`af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
Branch: `codex/perf-r1-f-android`. This is a module draft; unified integration
validation belongs to the controller. No second-round implementation is included.

## Independent reviews

All reviewers operated read-only. None implemented, installed dependencies, ran
tests or used devices. These are original-owner plans reviewed before the
corresponding implementation, not test results relabeled as plan approval.

| Plan | Reviewer/model/effort | Decision and bound identity |
| --- | --- | --- |
| [F-AD05-v1](performance-round1-F-ad05-plan.md) | `/root/ad05_plan_review`, gpt-6.1-sol Medium | APPROVE at base/head af11ab7c; SHA-256 `198f97a16b4ae8d0f52db91cc171c22128e43eb3dec41a1e74abdfc4ff9d2a99` |
| [F-AD09-v1](performance-round1-F-ad09-plan.md) | `/root/ad09_design_review`, gpt-6.1-sol High | APPROVE design only at base/head af11ab7c; SHA-256 `34a3999adb45d6a1532d1c63797e193cbc915f8fe17cc9311ae7715d8da565d8` |
| [F-queue-followups-v1](performance-round1-F-queue-followups.md) | `/root/queue_followups_review`, gpt-6.1-sol High | AD04 APPROVE bounded design at base/head af11ab7c; AD01/02 investigation boundaries accepted, no implementation approval; SHA-256 `2ea324e3eee6edf55a6b1ea670536dcf7608456308c57ee18c6f996e7607db4c` |

AD05's reviewer subsequently inspected the implementation and new generated tests
against the approved scope and reported no findings. This separate code review
does not replace the preimplementation approval or JVM checks.

Recorded wording-only deltas, acknowledged by the same reviewers without a scope
change: AD05 now says ByteCipher.open calls rather than decryptions (format 4's
LocalContentCipher is identity bytes), current plan SHA-256
`aca36082bad69c8518eb0d86034a66864e5a3b72e1aff9b1794c06ad724e9a50`.
The queue follow-up document incorporates the nested flush and complete-receipt
clarifications below, current SHA-256
`9b21aec9cafb5dddcf61e0bdc4fb379af135a1aa28709b968a26d18124129469`.
The table preserves each original reviewed identity. No product/test input or
decision boundary changed with these wording deltas.

AD09 review requires a future exact-base/head review before coding, including:
one intent generation spanning every verification in an operation; complete
writer/snapshot/ABA inventory; explicit treatment of enabled callbacks nested
inside signOut or rollback (an inner setter lock cannot release an outer lock);
sound identity fencing for fault-injection SharedPreferences wrappers over one
backing store; and actual Android entry-point/lifecycle validation. The separate
UnifiedCentralSession monitor remains out of scope. This is not a delivered AD09
fix or proof of general UI responsiveness.

AD04 review clarifies that each finally decrements shared batch depth and only
depth zero attempts projection persistence. Nested/overlapping wrappers may
coalesce concurrent projection mutations; their authoritative writes remain
immediate. The wrapper must not span network, recursion, rejection publication,
or more than one already-verified success callback loop.

AD01 review clarifies the integrity claim: preserve checks currently exercised by
the part loop. The existing begin-with-complete-receipt shortcut bypasses that
loop and acknowledges directly; do not add a new validation step there or claim
that every ACK path currently verifies local bytes. Descriptor/stat caching does
not justify skipping existing corrupt-prefix detection. AD02 still needs its
complete mutation ledger and crash-safe publication protocol. Neither is ready
for implementation.

## Validation scope

The product patch changes the actual UploadWorker call to a small internal
selector. It supplies maxCount=1 before payload construction when packedUpload is
false; packed count and all existing queue/transport/ACK/lifecycle code stay the
same. Generated JVM regression covers actual selector blob reads, exact payload,
retry/restart, tied-time ordering, metadata windows/mixed records, oversized first
record and live/history preference. Existing queue and ingress outcome consumers
retain their original assertions and entry points.

Newly executed validation is recorded below when complete. No evidence is marked
REUSED. The initial heavy-gated Gradle attempt selected Android Studio's JBR
25.0.3 and failed during configuration, before tests. Its process-group cleanup
was confirmed and lease released. The same focused command was retried with the
installed Homebrew JDK 21; no build or dependency configuration was edited.

That JDK 21 run compiled the debug product and JVM test code. CaptureUploadBatchTest
(5), DurableQueueTest (9) and Ingress3OutcomesTest (12) all passed. All 12
MultiuserIngressTest cases failed before their fixture could start because this
new worktree had no tsx installation. Thus the run failed overall; those failures
are not integration coverage. Its process cleanup and lease release were confirmed.

Recorded preparation delta to AD05's initial no-node-install assumption:
MultiuserIngressTest starts the existing real HTTP fixture through node/tsx and
imports shared/agent package outputs. Install only the existing lockfile's root,
shared, agent and server workspace dependencies in this worktree and build shared
then agent before re-executing the unchanged four-suite command. This changes no
source, dependencies, assertions, scale, timeout or entry point. Installation and
build use the heavy gate; the first installation request was UNRUN because
another owner held it. No resource was stolen and no shared installation is used.

Final focused result: **38 tests passed, 0 failures**. The unchanged four-suite
command actually re-executed testDebugUnitTest after the prerequisite correction.
Gradle reported 1 executed task and 24 up-to-date preparation/compilation tasks;
the prior debug compilation is not described as newly executed again. No driver
check receipt was reused. Gradle reported 21 s total; this is validation timing,
not a device performance benchmark.

| Newly executed JVM suite | Cases | Result |
| --- | ---: | --- |
| CaptureUploadBatchTest | 5 | PASS |
| DurableQueueTest | 9 | PASS |
| Ingress3OutcomesTest | 12 | PASS |
| MultiuserIngressTest | 12 | PASS; existing real loopback HTTP fixture |

The exact Gradle task/filter arguments were:

```sh
apps/android/gradlew -p apps/android \
  --project-cache-dir /Users/utopiafar/.codex/orchestration/mote-performance-20261020-l33r5sf0/F/tmp/gradle-project-cache \
  --no-daemon --max-workers=2 -Pkotlin.compiler.execution.strategy=in-process \
  :app:testDebugUnitTest \
  --tests dev.mote.collector.CaptureUploadBatchTest \
  --tests dev.mote.collector.DurableQueueTest \
  --tests dev.mote.collector.Ingress3OutcomesTest \
  --tests dev.mote.collector.MultiuserIngressTest
```

Every Gradle/install/build command used run-resource.py, owner F, kind heavy.
JAVA_HOME was `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`,
ANDROID_HOME was `/Users/utopiafar/Library/Android/sdk`, and the gate supplied
F/gradle-user-home plus F/tmp. Project and package outputs were this worktree's
own. The final resource token was `df76c719-0933-4a74-8556-3c9bb14e5717`;
return code 0, process-group cleanup confirmed, lease released. All three
single-use Gradle daemon PIDs observed in the isolated home had exited.
External F/artifacts retains raw logs, JUnit XML, source hashes, dependency
identity and the full gate/command argv in ad05-focused-receipt.json. These local
artifacts contain generated fixture evidence and are not committed.

The heavy-gated `npm run check:affected -- --base af11ab7c3e9fb5f38deaea4e4bae11462a7306b4 --dry-run`
completed successfully and selected Android, i18n and its normal prerequisites;
Central/Desktop/protocol/tooling were false. This only inspected the plan. The
selected complete check plan was not executed by this module. The planning
process cleanup was confirmed and its lease released.

No check:affected/check:local/full repository test, instrumentation, emulator,
physical-device, personal-screen capture or live-model check is performed by this
module. JVM selection/adapter evidence cannot establish real WorkManager startup,
pause/conditions lifecycle or physical-device performance. Those remain explicit
controller integration obligations as applicable.
