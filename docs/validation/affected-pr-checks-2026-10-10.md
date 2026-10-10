# Affected PR checks

The PR entry point is `npm run check:affected`. It shares component selection with
CI and adds uncommitted inputs for local development. This replaces the blanket
requirement to rerun every TypeScript workspace before each non-documentation PR
or update. Root configuration, lockfiles and unknown build inputs still select
all consumers. Runtime API or permission changes require journey validation even
when their consumer files have not changed.

All automated regression inputs are generated. Git fixtures use temporary local
repositories, synthetic identities and synthetic source files. No personal
screenshots, production archives, production signing credentials or model calls are used.

| Regression scenario | Expected behavior | Durable coverage |
| --- | --- | --- |
| AGENTS.md, localized root README, protocol/adapter/plugin README, docs or release notes change | No application checks | `affected-components.test.mjs` |
| Runtime Agent prompt or SKILL.md changes | Central remains selected | `affected-components.test.mjs` |
| Only Android release workflow changes | Android and release-tool regression checks; no Central or Desktop checks | `affected-components.test.mjs`, local plan tests |
| Component workflow mixed with another component's source change | Union of affected components | `affected-components.test.mjs` |
| Shared protocol, root lockfile or unknown input changes | All consumers selected; local plan includes Android JVM tests as well as full TS checks | Both suites |
| Check-selection infrastructure changes | Regression tests execute without application commands | Actual local CLI fixture |
| Committed, staged, unstaged and untracked changes coexist | All are included locally; ignored files are excluded | Actual local CLI and Git fixtures |
| Staged and working edits to one file cancel out in the combined diff | Staged consumer remains selected | Git and local CLI fixture |
| Explicit head is supplied | Only committed PR inputs are included | Actual local CLI fixture |
| Runtime source moves into docs | Old consumer remains selected, before and after committing the move | Git and local CLI fixtures |
| Base branch advances independently | Its unrelated changes are excluded from PR inputs | Diverged Git fixture |
| A revision or CLI option is invalid | Failure, never a successful empty plan | Actual local CLI fixture |
| A check fails | Preserve failure status and stop subsequent checks | Real child-process fixture |

## Verification

- Focused selector/local CLI regressions: 14 passed, 0 failed, 0 skipped.
- Central build completed successfully.
- Changed Markdown syntax, relative links, explicit anchor and HTML table rendering checked.
- Component-check workflow YAML parsed successfully.
- `npm run check:local` passed: 2,444 tests passed, 2 existing opt-in tests skipped, 0 failed; central-runner checks also passed. The skips are macOS sandbox execution and installed Codex integration, and remain unperformed.
- Android JVM validation was stopped at the owner's request during SDK preparation. It did not reach test execution and is not claimed as passed. No Android product code changed.

GitHub `Checks` and `Component checks` were confirmed `disabled_manually` during
this change; this PR preserves that repository setting. YAML parsing and local
fixtures do not claim an executed GitHub workflow. macOS native builds, browser
E2E, physical-device checks, release signing and live-model checks are outside
this infrastructure change's validation scope.
