# Small modules and early integration

Use this guide when work is split across several agents or sessions. Single-module fixes need no coordination document or extra reviewer role.

Agree on the user-visible result, shared interfaces, which files each module lead may change, and one shortest real journey: the actual entrypoint/startup, an authenticated action, real producer output and the consumer's result. Wire that journey early, before implementation grows. When an interface changes, add a light contract test that feeds the producer's real serialized output to its actual consumer. Each module lead changes one bounded module, runs focused checks and reports concrete gaps; the same lead handles related repairs.

Delegate only modules that are independent and can be checked on their own. Do not split work you can finish directly, do not run two implementations of the same module, and do not use another agent to re-check your own work. Do not install dependencies or rebuild shared output (`npm run build:libs`) concurrently. Coordinate expensive checks so several suites do not compete for the same CPU or emulator.

The integrator combines modules incrementally, freezes the candidate once planned changes converge and inspects `npm run check:affected -- --dry-run`. Stage or release acceptance follows [testing](testing.md#early-integration-and-candidate-checks).

Handoffs carry the goal, decisions, revision, relevant results and next action. Evidence stays in Git, the PR description, CI and ignored logs.
