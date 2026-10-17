# M13 saved model tools: finite validation

The pure-server PREP is `89ec8fbcf38a36ff72c45883d3cf4791b7d2e278` on
`codex/mote-m13-public-models`, based on the safe Agent `19c5592f` checkpoint.
Its formal bodies and limitations are in
[the model tools contract](../design/multiuser-model-tools-http.md).
It contains no whole Web consumer changes. Independent bounded review of the
stateless-probe extraction and exact scope-import exception is still pending.

## Real entry evidence

- Personal copy and catalog/probe each first failed at the real route with 503:
  `/tmp/m13-model-copy-red.log` and `/tmp/m13-model-inspection-red.log`.
- The fixed copy, inspector, original probe and effective-snapshot neighbors
  pass 7/7 without skips (`/tmp/m13-model-tools-green5.log`). Three original
  model settings/catalog files pass 34/34 without skips
  (`/tmp/m13-model-tools-legacy.log`). Server noEmit and scope checks pass.
- On the Web/shared-policy composition the new real server cases pass 2/2
  (`/tmp/m13-model-tools-composed.log`); the correct effective-snapshot file
  separately passes 4/4 (`/tmp/m13-model-tools-effective-composed.log`). A
  guessed nonexistent extra filename in the first command was ignored by Node;
  those two tests were never counted as the missing file's coverage.

The original `ScopedConfiguration` UI first reaches its real A model profile,
then fails on the absent copy control (`caf27c86`,
`/tmp/m13-model-controls-valid-red.log`). The restored controls use fixed saved
M04 references. A dirty form cannot silently probe the older saved connection.
Copy has the existing explicit credential checkbox and uses the server-side
copy route; it does not reconstruct secrets from masked fields. Shared entries
have fixed-reference inspection and no credential-copy control.

The same original-page journey passes (`/tmp/m13-model-controls-green3.log`):
directory selection, real M04 save, synthetic search/evidence/citation probe,
credential-preserving and credential-clearing copies, unchanged selections and
B YAML, then held A directory response, A-to-B remount, a detached old button
with zero new I/O and a B directory positive. Together with file-settings and
per-request selectors the neighboring Web files pass 4/4 without skips
(`/tmp/m13-model-controls-neighbors.log`). Web noEmit, bilingual 8,471-key check,
scope/import check and Web production build pass.

Early fixture runs are retained separately: one used the wrong fixture host
property, another routed the generated provider HTTP request into app.inject,
and a response-completion log counted an already-admitted held response as a
new request. These were corrected at their test boundary. None is reported as a
production bug. Initial no-argument React ref typing was corrected before the
final noEmit run.

## Actual browser check

IAB, with a generated localhost host and generated model provider, exercised the
original settings page: loaded a real model directory, completed the synthetic
probe, saved a credential-retaining personal copy and displayed its new M04
revision. Switching through the original account entry to B showed only B's
same-ID profile. No private Ask run was admitted; the fixture reported seven
generated provider requests. Screenshots are
`/tmp/m13-model-tools-iab-final.png` and `/tmp/m13-model-tools-iab-b.png`.
Both temporary hosts closed normally and their generated directories were
removed; the agent-created IAB tab was closed. The old host's cached build
index was not reused after changing build assets.

The original inline editor had inherited a two-column legacy sidebar grid with
one child. The IAB screenshot exposed the narrow form. Its scoped class now
uses one column and the existing preference grid; unrelated legacy provider
layouts are unchanged.

## Limits and current gate

These are saved-reference operations. Unsaved-draft connection testing and
automatic draft directory discovery are outside this finite interface. This
does not claim all Models, settings, Memory, Files or Imports parity.

Main fixed `750a7b00` affected checking ended with EXIT1, separately from this
controls branch. Desktop 501/501 and Web 538/538 pass; Server has 2,733 pass,
31 fail and two skips. Trailing root tests and Android were not reached. Its
environment had a Node26 ABI147 native SQLite binary under a Node24
ABI137 runner. The exact dependency version 12.10.0 was isolated under the
server using a verified ABI137 binary; the root Node26 dependency was untouched.
The unchanged four real mem0 worker tests then pass 4/4; five dependent files
separately pass 16/16 without skips after the repair. These actual same-case
results support the ABI diagnosis for the twenty affected failures. The stopped
stuck file and original full log remain recorded, never relabeled as passing.

The same fixed run also hit two real Ask delegation observation timeouts. A
diagnostic with unchanged production and assertions, observing for 60 seconds,
completes both chains (including the failed-child exact retry counts). That is
diagnostic evidence, not a replacement full gate or an accepted fixture fix.
The other failure rows include import progress observation, Files cancel,
Coding projection, M06 pipeline assertions and old Web feature metadata. They
remain unclosed; they are not automatically classified as ABI failures. The
full failure inventory is `/tmp/m13-750-server-failure-inventory.json`. Necessary
follow-up and a real final combined gate must be completed before an own PR is
accepted. No own PR or remote delivery is claimed here.

M15's earlier omitted-policy scalar PUT 400 attribution is superseded by its
declared client repair: unconfigured scalar settings use the existing M04
configuration CAS; a configured graph uses the full file-processing CAS. Its
original native GREEN was still pending at the time of that update. This Web
named-scheme Save is not evidence for native scalar parity.
