# Small modules and early integration

Use this guide for multiple owners. Single-module fixes need no coordination document or extra reviewer role.

Agree on the user-visible result, shared interface, file ownership and one shortest real journey. Connect that journey early, before implementation grows; add light producer/consumer contracts for changed interfaces. Each owner changes a bounded module, runs focused checks and reports concrete gaps. Keep that owner for related repairs.

Prefer GPT-6.1 Sol subagents. Parallelize independent modules, not duplicate implementations. Do not install dependencies or rebuild shared output concurrently. Coordinate expensive checks so several suites do not compete for the same CPU or emulator.

The integration owner combines modules incrementally and freezes the candidate after planned changes converge. Use [testing](testing.md) as the single source for layers and triggers, inspect `npm run check:affected -- --dry-run`, and complete the relevant acceptance at stage completion and before release. Select relevant heavy checks explicitly and manually. After repairs rerun invalidated checks, not successful unchanged checks for a new timestamp; a handoff or Draft PR update does not expand scope.

Use Git, PR descriptions, CI and ignored logs as evidence. PRs record behavior changes, actual checks and untested risks. Handoff the goal, decisions, revision, relevant result and next action; do not maintain duplicate manifests, receipt tables or per-edit progress documents.

Changed product boundaries or architectural decisions follow [risk-based review](testing.md#risk-based-review); module fixes within existing decisions do not create another approval step. Report unavailable environments honestly; fixtures do not establish physical-device or live-provider behavior.
