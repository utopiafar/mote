---
name: real-world-testing
description: Design Mote regression tests from concrete user failures and review test coverage. Use when fixing bugs, adding or reviewing tests, or changing lifecycle behavior.
---

# Mote regression coverage

Name the user failure the test prevents. Prefer real domain objects or public entrypoints; use generated evidence and mock only external services or unavailable platform boundaries.

Reproduce a regression before its fix when practical. Preserve meaningful outcomes, required data scale, timeouts and cleanup assertions. Avoid existence checks, mock echoes, implementation mirrors and duplicated adapter scenarios.

Exercise timing where it matters: cancellation during work, late results, restart, partial upload acknowledgement, withdrawal or deletion. Control that state explicitly rather than hoping repeated runs exercise it.

Product decisions can supersede old assertions: explain the old/new behavior and remove obsolete tests in the same change. Classify a test by what it establishes, not by its name.

Commands live in the app `AGENTS.md` files. Test layers, triggers, logs and the review boundary live in [testing guidance](../../../docs/testing.md).
