# ADR: Single-owner MVP and incremental recovery

Accepted by the owner, 2026-10-23. Implementation and evidence are recorded in the [recovery inventory](https://github.com/utopiafar/mote/blob/9c9a36e25355b1251aedbec2d5da89a63d8926de/docs/single-owner-recovery-inventory.md); this decision is not itself a test or release qualification.

## Decision

One instance serves one owner and that owner's devices, sources and Agent clients. Each instance owns its database, originals, indexes, tasks, configuration, secrets and private plugin state. Multiple people can run independent instances. This work does not implement shared accounts, a control plane, federation or speculative multi-tenant interfaces.

The owner accepts a fresh-data MVP with one current storage and wire contract. No previous database, queue, archive or configuration needs migration or preservation. Version validation rejects mismatched clients; it is not an old-format reader. Current-format backup/restore and ordinary restart recovery remain product capabilities.

Full personal clients authenticate once as owner and retain full functionality. Purpose-specific collector and MCP credentials are independently scoped and revocable; collector access does not silently acquire archive or management rights. This requires neither an account registry nor another login for an already authorized full client.

ConfigService owns effective configuration; processing produces evidence and Material; Memory independently reviews/publishes; Ask retrieves and cites; Actions owns approved effects. Provenance, people described by evidence, source permissions and deletion remain meaningful with one owner. Query agents receive read-only tools.

Dev uses private files for Mote-owned credentials; Prod retains system protection. Third-party CLIs keep their credential management. Real profiles and devices are not fixtures.

## Recovery and supersession

Recovery starts at `7142fdce1d2ec488410051e4f224655ac3beac95`. Commit `52110244c848001aeae56cf525188a266aa3f01d` reverses all 29 intervening first-parent commits using merge parent 1. Its tracked tree exactly equals single-owner baseline `2c2627621e2598332ae8169845bc7343be7ed63e`; original commits remain ancestors. Pure rollback is an intermediate source snapshot, not runtime qualification.

This supersedes the shared-account contracts in the former `adr-multiuser-scope`, `adr-multiuser-main-integration`, account-host portions of `adr-shared-business-flows` and `adr-unified-user-journeys`, available at the original head in Git. Their account machinery and delivery procedures are not restoration requirements. Evaluate independent behavior against the baseline before porting.

| Disposition | Contract |
| --- | --- |
| KEEP | One database/executor per instance; evidence revisions/citations; source withdrawal, retention, cancellation, checkpoints and honest external-effect outcomes. |
| CHANGE | Single-owner configuration and instance resources replace account hosts. Full clients and restricted callers have explicit capabilities. |
| REMOVE | Account administration/switching, cross-account SQL/cache namespaces, shared/personal resource duality, isolation inventories and compatibility migrations. |
| EXCEPTION | Independent instances, Dev/Prod profiles, restricted collector/MCP access and current-format backup/restore. |
| UNKNOWN | Runtime, packaging, physical-device and live-model results require actual verification; historical passes do not establish them. |

Appearance, unified configuration, retained historical answers and some Memory/evidence reliability already exist in the target. Restore recording, retry, Memory, plugin, client and performance requirements only where the baseline lacks desired behavior. Account-regression repairs are not automatically new features. UI prototype PR #185 is not production implementation.

The [recovery inventory](https://github.com/utopiafar/mote/blob/9c9a36e25355b1251aedbec2d5da89a63d8926de/docs/single-owner-recovery-inventory.md) records the disposition of every intervening first-parent change and distinguishes restored requirements from behavior already present in the baseline.

## Development and validation

The owner chose the lightweight workflow discussed at the beginning of this recovery, rather than importing later testing PRs wholesale. Short global rules, module commands and on-demand guidance replace extensive routine process obligations. No 16-bucket receipt engine or hand-maintained campaign ledger is required.

Develop small modules, check them locally and connect real boundaries early. The initial generated journey uses actual Central startup, owner authorization, intake, Material/query and shutdown/restart. Extend it as functionality converges. One integration owner runs the final affected plan.

Functional correctness is the MVP acceptance priority. Performance that does not
prevent practical use can be optimized later; earlier multiuser PR benchmarks
are not recovery targets. Preserve complete input processing, authorization,
data safety and lifecycle assertions. Distinguish a functional hang or failure
from a fixture's elapsed-time budget, and report deferred performance work
separately instead of expanding this recovery to match historical optimizations.

R1 received independent pre-implementation **APPROVE** from GPT-6.1 Sol High against the exact starting/target revisions above. It covers rollback, initial architecture/rules and a minimal focused-test entry. Later capability or lifecycle changes receive bounded review of their actual delta; R1 does not approve unknown redesigns.

See [testing](testing.md), [CI](ci.md) and [development](development.md).

R2 restores client Dev private credentials and signed-out queue continuity; see [Profile policy](adr-profile-release-policy.md). R3 adds explicit collector invitations with a closed intake route set, device/platform binding and source metadata projection. Both received independent approval before implementation. Full native clients remain owner clients; collector and MCP credentials do not create accounts.
