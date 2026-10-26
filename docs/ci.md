# CI responsibilities

Test layers and selection rules live in [testing](testing.md). `component-checks.yml` is the affected PR/main entrypoint; `checks.yml` is the explicit manual entrypoint for broad integration. Documentation-only changes receive document review without application builds.

The automatic affected lane is for ordinary unit/module feedback and light contracts. Heavy cross-client E2E, expensive scale correctness, pure performance benchmarks and real external-model checks require explicit manual selection, as defined in [testing](testing.md#test-layers). They must not be pulled into every push through an automatic workflow's transitive npm command. A suite split must preserve required correctness cases, assertions, scale and timeouts; classifying by filenames alone is insufficient.

For local work use the app's focused commands. `npm run check:affected -- --dry-run` shows the plan implemented in the checked-out revision; inspect the nested commands before executing a broad plan. `npm run check:affected` executes that plan, while `check:local` is broad TypeScript integration. Neither is a requirement to run a blanket local suite for each PR. Suite command names and dispatch inputs must come from the actual scripts/workflows, not assumed selectors.

To select a manual CI run, use GitHub Actions **Run workflow** (`workflow_dispatch`) on the intended branch/revision and choose the relevant implemented options. An explicit manual workflow run may execute the selected heavy acceptance scope; an ordinary push must not. Real devices, native permissions and live-provider quality still need their relevant environments. Release qualification follows the relevant scope in [testing](testing.md#early-integration-and-candidate-checks) and [releasing](releasing.md); it does not make benchmarks mandatory for every release.

CI checks the pushed revision. Avoid duplicating unchanged successful work locally, and never call a local-only result a CI pass. Workflow source, enabled/disabled state and a successful revision-specific run are separate facts; inspect actual runs before reporting CI success. Earlier recovery notes about workflow state are historical observations, not current status.

The PR owner reads failure logs and repairs ordinary failures with the module owner. Store full logs in CI artifacts or ignored local files and preserve nonzero exit status when showing excerpts. The PR description records behavior changes, checks actually run and untested risks; no separate ledger is required. A known failure is not resolved by moving it outside automatic CI.

Public API, shared protocol, persistence and authorization changes need the affected actual consumers. New releases use new versions and immutable tags; rollback never authorizes overwriting a release.

See [testing](testing.md) and [releasing](releasing.md).
