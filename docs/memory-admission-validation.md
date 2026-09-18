# Memory admission validation — 0.0.44

Date: 2026-09-18. The live semantic suite uses the locally installed Codex App Server, model `gpt-5.6-luna`, low reasoning, an isolated temporary archive and generated text. No real personal screenshots or archived personal content were sent. Run explicitly with `node --import tsx scripts/test-memory-admission-live.ts`; it is not part of unattended CI because it consumes model quota.

Final full run: **5 groups passed, 7 actual model calls**.

## Live model cases

| Case | Required result |
| --- | --- |
| Passive optics article, notifications, device settings, shopping page, captured malicious instructions | No selected personal memory |
| Explicit request to remember an article for next week's exam | Retain the scoped resource association; no inferred agreement or permanent interest |
| Explicit project meeting preference and confidential-file constraint, alongside another author's preference | Retain both scoped user constraints; do not attribute the author's preference to the user |
| Deliberately fabricated draft title claiming comparison and product preference | Independent reviewer rejects or downgrades it |
| Two already adequate, unrelated project constraints | No redundant consolidated checklist |

During development the live suite caught both an unnecessary consolidated checklist and an overly strict rejection of the explicitly requested article. The admission instructions were corrected and the complete suite rerun. Local JSON reports and model timing logs are outside source control. Model judgments remain probabilistic; this finite regression suite is not a guarantee of factual correctness.

## Automated and UI validation

- Workspace suite: 519 tests, 518 passed, 1 skipped, 0 failures. Includes seven admission/provenance/review/round-draining regression tests.
- TypeScript checks, shared library/server/web builds, bilingual message checks and release version consistency checks.
- Generated-data Electron navigation test: selected-memory default, observation/legacy filters, settings save, desktop and mobile layouts. No personal screenshots captured.
- Release CI separately runs platform packaging and existing protocol, privacy, container, update and generated UI suites.

Physical Android/Mac capture behavior was not revalidated against personal devices. The user's running local service and personal archive were not restarted or rewritten by these tests. Legacy memories remain explicitly unreviewed until separately reprocessed.
