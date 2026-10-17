# Saved model connection tools (finite M04 contract)

These manual tools preserve the original preset copy, connection test and model
directory capabilities. They use M01 protocol-2 authentication and the existing
M04 personal configuration transaction. Device credentials cannot invoke them.
This is a backend consumer contract, not a whole Models or Web acceptance claim.

## Personal preset copy

`POST /api/models/profiles/:id/copy`

```json
{"revision":12,"id":"new-preset","name":"New preset","includeCredentials":true}
```

The path identifies an existing personal profile. The new ID and name use the
existing M04 limits. `includeCredentials` defaults to true, preserving the old
personal-copy behavior; false clears the copied API key, headers and extra body.
The original profile, selections and global defaults do not change. The response
is the existing redacted `ConfigServiceView`, including its new revision. No
plaintext credentials are returned. The copy is one existing M04 CAS operation;
a stale revision or duplicate destination returns 409 and an unavailable source
returns 404.

A shared profile is a fixed instance resource. Its public metadata grants no
right to copy the endpoint, credentials or other private connection fields. This
route cannot copy a shared ID or the legacy deployment profile.

## Directory and synthetic connection test

`POST /api/models/catalog` and `POST /api/models/probe` accept:

```json
{"revision":12,"reference":{"kind":"personal","id":"saved-preset"}}
```

`kind` can also be `shared`, with an existing fixed shared resource ID. There are
no endpoint, credential or model overrides in either body. Use the current
personal configuration revision even when inspecting a shared resource.

The catalog returns the existing `{items:[{id,name,...}]}` model directory. It
uses the original provider/Codex directory algorithm and can discover IDs before
a personal profile has a model selected. A manual model ID remains possible when
the provider has no compatible directory.

The probe returns the existing `{ok,code,message,durationMs}` result. It reuses
the original generated reader, requiring a real search/evidence/citation round
trip. It does not connect an archive reader, admit an Ask run or create a task.
The generated record contains no personal content. An unconfigured saved model
returns `not_configured` without falling back to another preset or global model.
Provider error details and credentials are not returned.

The caller, original configuration entry, revision, complete selected connection
and shared-resource generation are rechecked before transport and publication.
Logout, relogin, configuration replacement or withdrawal of a shared resource
rejects the stale result. A held probe response cannot authorize later model/tool
requests after credential retirement.

These routes inspect saved references. Testing unsaved form fields is not part
of this finite contract: save the visible personal preset through the original
M04 form first. Shared connections stay read-only. No new store, scheduler,
credential cache or automatic retry mechanism is introduced.

## Executed validation and open work

The durable missing-route REDs are `multiuser-model-copy.test.ts` and
`multiuser-model-inspection.test.ts`. The same real M01/M04/M08 and generated
loopback provider fixtures pass after implementation: copy/use and explicit
credential clearing; A/B same-ID isolation; stale CAS; fixed shared lookup and
withdrawal; directory pagination; a synthetic tool/citation probe; empty model;
forbidden overrides; held logout and no following physical probe requests.
Together with the original probe and effective-snapshot neighbors, 7 tests pass
without skips. The three original model settings/catalog files pass 34 tests
without skips. Server typecheck and the scope/import checker pass.

Independent review then confirmed a physical Codex-RPC retirement gap in the
initial PREP: logout during a held initialize response correctly rejected the
final HTTP result, but the directory helper still wrote the next RPCs. The
durable `multiuser-model-codex-retirement.test.ts` uses a generated executable,
activates its restart-only path and checks that effective path before discovery.
After logout only `initialize` can have been written; neither `initialized` nor
`model/list` may follow. A same-resource B positive still reads the directory.
The helper now accepts an optional authorization callback before launch and
every stdin RPC write, closing the child on rejection. Existing callers without
the callback keep the original algorithm. The same-case RED and the fixed
catalog/copy/probe neighbors pass 8/8 without skips. Consumers of the initial
`89ec8fbc` PREP must include this follow-up; final-result hiding alone is not a
transport fence.

Original Web/Android controls must still consume these routes, retain their
connection/owner retirement checks and get their own UI and final affected
validation. This document does not declare those consumers or the whole module
complete.

### Default-feature choice metadata

`GET /api/models` additionally returns `features: ModelFeature[]` copied from the
same shared `MODEL_FEATURES` registry enforced by M04. It is present when the
personal `selections` map is empty. Consumers render feature choices from this
metadata and save explicit personal/shared references through the existing
whole models CAS; metadata reading neither selects a default nor grants a
shared endpoint/credential copy. Unsupported feature keys still reject400.
The model-tool POST contracts above are unchanged.
