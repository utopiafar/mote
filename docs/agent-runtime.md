# Agent runtimes and durable execution

Mote keeps formal context, conversation and task state independently of a selected model runtime. The model interprets intent and chooses retrieval; the host enforces authorization, privacy, current versions, transport and measured usage. Captured text, documents and tool results are untrusted evidence, even when they contain apparent instructions.

## Runtime roles

The shared Agent package adapts DSH and Codex. Current query providers receive read-only Mote context tools. Import is a different role with a private writable analysis workspace and bounded output validation. Product Actions authorize external effects; adding a runtime or reading a document does not grant them.

The official DSH query composition can load installed original ESM packages, Hooks and a Factory selected for a model profile. It keeps Mote's existing context, model, output and Action authorization. Native applications with persistent internal sessions, pages and workflows remain a separate integration step. See the [architecture map](architecture.md).

Runtime startup builds the prompt from current owner instructions, selected tools, effective preferences and task context. Keep tool availability and capabilities consistent with the actual provider. Do not replace semantic decisions with keyword routing or treat a source's first-person text as the current user. Use [model configuration](model-providers.md) for credentials, selection and approved fallback scope.

## Installed native DSH packs

Install a trusted package through Plugin Center, configure an instance, check it and enable it. Its package descriptor uses `runtime: service` and declares each native entry as a contribution with `surface: agent`, `runtime: native` and a relative `entry`. The original `package.json` must declare ESM, its name/version and public exports. Installation and checking verify immutable bytes and export metadata without importing native code into Central. An enabled instance supplies an actual Host activation and exact dependency pins; it still needs an explicit owner selection and grant before a query loads it.

The owner-only `GET /api/agent-runtime/native-modules` directory returns checked instances' exact references, original package name/version, requested native capabilities and current activation state. It contains no filesystem or launch paths. Copy these references into the `dsh` configuration domain through the existing owner configuration editor/API or the same YAML file. `PUT /api/configuration/dsh` uses the ordinary configuration revision and validates this selection's installed references and declared capabilities. Saving does not reserve an activation or grant a future query access to a disabled instance.

For example, a package whose original native manifest declares `hooks` can be selected with a document shaped as follows. Replace the generated example identity/digest with the exact directory values:

```yaml
dsh:
  profiles:
    - modelProfileId: env:deployment
      assembly:
        packages:
          - contribution:
              instance: &nativeInstance
                packageId: example.native
                installationId: generated-install-0001
                instanceId: generated-instance-0001
              contributionId: example.native-package
            revision: 0
            artifactDigest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
            exportName: default
        hooks: []
      grants:
        - instance: *nativeInstance
          capabilities: [hooks]
```

`assembly.hooks` takes the same reference shape; the optional `assembly.factory` holds one reference. `exportName: default` denotes the existing module namespace loader protocol, including an original Cordis `apply` export. It does not select an arbitrary JavaScript named export. The Host maps the declared entry to a valid public subpath, preferring the root and then stable lexical order when the original package exposes aliases. Selecting the same real entry more than once is rejected. Reference revision `0` describes the immutable installed contribution pinned by installation identity and artifact digest; live activation identity is separate.

Each selected instance needs exactly one grant, including an explicit empty capability list for a package with no native declarations. The grant must match all original `dsh.native.capabilities`; missing or extra capabilities are rejected rather than intersected silently. Same-process native code is trusted code, so these package-level declarations are not a fine-grained sandbox. Host tools, evidence disclosure, model admission and Actions keep their own authorization, and native delegation stays disabled.

This domain applies after a Central restart. The configuration view shows saved and effective values separately; ordinary model edits do not apply pending DSH changes. Selection belongs to one exact model profile, with no inheritance by another profile, connection probes or file-service adapters. Non-DSH model transports cannot receive native selections. Every query resolves fresh installed metadata and pins the actual Host scope through SDK startup, tools and output. Disabling, replacing or stopping that scope cancels the run and rejects late delivery. Re-enabling the same immutable installation supplies a fresh activation to subsequent queries without requiring a new model adapter.

Current native-only packages use their original default configuration; Central configuration fields on such packages are rejected until a real native configuration consumer exists. Original peer contribution requirements must also be selected, and external typed Host requirements must resolve to actual unambiguous providers. Original package, Hook and Factory registrations live for the query SDK child and are disposed when that child stops. This does not preserve an application's internal sessions or artifacts across queries, and the import/probe/file-service roles do not install these query extensions. Generated installation/SDK tests establish this bounded production chain, not arbitrary third-party package compatibility or live-model quality.

## Context and delivered evidence

Catalog, search, paged reads, Memory, original images and progress use the shared bridge. Models choose how far to expand; a small overview is a navigation aid rather than evidence that every original was read. Original ranges become citable only after successful authorized delivery. Image questions need actual image delivery where selected; an OCR description is a different product. Permissions and source versions are checked again at read and publication boundaries.

The current runtime may parse and repair structured outputs within its bounded recovery path. A failed schema, model timeout or provider rejection remains a typed failure; arbitrary message text is not a semantic error classifier. Avoid inventing a universal tool-call cap or truncating an original and then reporting full coverage. The bridge records what was delivered, not whether a model paid attention.

Ordinary tool pagination and provider/context limits still apply. Admission reserves the actual request, text, image and tool-return capacity required by the operation. Active execution time excludes explicitly reported queue/resource wait. Usage that the provider does not report is unknown, not zero; token measurements and estimated costs are separate from elapsed time.

## Execution state and recovery

The shared `ExecutionEngine` persists tasks, steps, dependencies, attempts and checkpoints. A type declares its own processing budget and retry policy; there is no one timeout appropriate for files, model calls, metadata checks and long-lived workflows. Resource waiting does not consume an inference attempt. Independent tasks should continue while another waits for a model, input or owner response.

Claims and transactional commit checks prevent expired, cancelled or superseded work from publishing. Output commits recheck current source/model bindings, cancellation, permissions and input fingerprints. A late worker result is not enough to establish completion. SQLite transactions stay short, and asynchronous work stays outside them; contention and unexpected lock errors remain observable instead of being concealed as success.

Persist successful intermediate products before downstream work. Restart and retry reuse valid checkpoints and recompute only unfinished or invalid work. Some model attempts may need repetition; completed work is not blindly replayed. Imports, Memory input planning, source organization and processing use their shared durable primitives rather than an independent table for every feature.

An external effect with a lost response has an unknown result. Retain request identity and reconcile actual state before resending; retryability alone is not permission to duplicate a message or action. Explicit cancellation, confirmed termination and connection loss are different facts. Actions apply the same owner instructions, effective Memory and authorized scope to native and external Agent clients.

Generic batch work and older delegation currently coexist. Consolidate duplicate scheduling and state progressively as real needs arise; the MVP has no blanket freeze on host concepts, delegation or interfaces. Necessary implementation controls remain while their consumers need them. Models can still delegate useful research subtasks through supported product capabilities.

## Diagnostics and security

Operations provide a common view of input readiness, stages, waiting, failures and output references. Parent waiting does not consume a model slot, and a completed body stage does not imply that all required outputs finished. Progress wording must describe actual work rather than manufacture percentages or turn every untested scenario into a todo.

Diagnostics record safe identifiers, fixed failure codes, stage timing and available usage. Keep source bodies, prompts, credentials and raw provider errors out of routine logs. Structured test fixtures use generated inputs and isolated profiles. A native extension runs trusted code; a subprocess boundary does not make it safe to install malicious code.

## Code and operational references

| Area | Entry points |
| --- | --- |
| Runtime adapters and shared tools | [packages/agent](../packages/agent), [model-agent.ts](../apps/server/src/model-agent.ts) |
| Durable tasks and policy | [execution-engine.ts](../apps/server/src/execution-engine.ts), [shared execution schema](../packages/shared/src/execution.ts), [execution-policy.ts](../apps/server/src/execution-policy.ts) |
| Operation projection | [operations.ts](../apps/server/src/operations.ts) |
| Memory work | [Memory](memory.md), [material inputs](materials.md#processing-authority) |
| Import and media work | [processing](processing.md), [media setup](media-setup.md) |
| User conversation and external effects | [assistant](assistant.md) |

See [development](development.md) for build/profile commands, [runtime acceptance](testing-agent-runtimes.md) for explicitly requested native checks, and [troubleshooting](troubleshooting.md) for logs and recovery. Generated host tests do not establish real-model quality, native package compatibility or physical-device behavior.
