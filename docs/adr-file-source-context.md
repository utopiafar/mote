# ADR: File tasks and versioned source descriptions

Date: 2026-10-12. Status: accepted by the owner.

The owner approved a shared Android file-task interface, an audio folder preset,
and optional descriptions stored as versioned metadata. Editing a source
description applies to existing and future material without automatically
authorizing paid historical processing. Central and Android release separately;
deploy the supporting Central version before upgrading Android.

## User journey

Home and Add retain Import files and Sync a folder. Both open the same native task
editor in the appropriate mode. Opening the editor does not launch a system file
picker. The user explicitly selects a file or folder; cancelling selection returns
to the draft. Selection, descriptions and settings survive picker round trips and
page recreation. Cancelled new tasks do not register a source. Unused persisted
URI grants are released.

Import files saves one selected file once. It does not discover later edits after
the immutable local input has been captured. Delivery and processing of an already
captured input continue after restart, offline operation or transfer failure.
Existing continuously tracked files retain that policy. Explicit continuation is
available in source settings rather than being the default import workflow.

Sync a folder keeps discovering authorized files and revisions. The editor shows
the selected scope, file types, optional description, whether existing files are
included, Central destination and original retention. Scan frequency, size limits,
detailed extensions, exclusions and naming are advanced settings. Source management
continues to manage saved sources, calendars, pause, reauthorization and removal;
it is not a separate creation funnel.

The audio directory action becomes an audio preset in this editor. A newly chosen
audio preset retains the existing audio extensions and archive default. Original
retention remains visible and independently editable. Switching presets must not
overwrite an explicit retention choice. Selecting an existing URI opens its saved
settings rather than overwriting them with preset defaults.

Snapshot extraction sends complete file bytes to Central, then releases the
temporary original after processing. Archive retains the original. Reference
retention records file information without reading or transmitting the body or
transcribing it. Phone originals are retained. Reception, extracted output and
search availability remain separate facts.

## Description ownership and scope

Descriptions retain the owner's exact text, scope and version. They are metadata,
not a new global Memory, an inferred classification or a processing instruction.
The model interprets the declaration within its stated scope; captured content,
file names and frontmatter cannot create owner declarations. Participation in a
call does not identify an anonymous speaker or make another person's statements
the owner's opinions.

Android stores the description and pending synchronization state in its existing
private source configuration. Central owns immutable private description versions
and the current source declaration reference. MaterialStore owns effective
inheritance, material revisions and evidence dependencies. Descriptions are opened
only through authorized context reads and follow the existing private-content
encryption and portable backup policy.

An Android one-time file task has its own LocalSource, limiting its description to
the selected file and derived evidence. A folder description is a source default.
Web import declarations retain their existing frozen original-capture scope and
ImportJob lifecycle; sharing a description design does not merge the transport or
parsing contracts.

Source description edits apply to current and future material; existing individual
ownership corrections remain effective. Clearing a description is a versioned
change. Historical versions remain available as historical evidence. Normal source
registration does not clear or overwrite a description. Owner context edits use
an expected version; lost responses permit safe retries and conflicting edits are
reported instead of silently overwriting another edit.

Metadata edits must not discard pending bytes, reset one-time capture checkpoints,
change source scope or manufacture new ingress receipts. Source/context writes are
acknowledged before newly queued files are sent. Offline edits remain pending and
obey the existing node binding, authorization and pause-all-sending rules.

## Discovery and processing

Read-only source discovery searches source names and description text using queries
chosen by the model. A matching preview provides a source locator and pinned
declaration version, not a claim that the full description or source body has been
read. The existing context reader expands source declarations with pagination,
permission checks and version validation. No keyword-to-topic or intent dispatch is
introduced.

Material, evidence, semantic file analysis, Memory extraction/review and Ask consume
the same effective context. Semantic dependencies include the declaration version;
edits invalidate affected current conclusions and reject late results using old
context. ASR/OCR output and original bytes remain reusable. A description edit does
not issue historical model grants or automatically queue paid processing for
completed historical inputs. Explicit historical reprocessing remains the existing
owner action. Original evidence remains readable while derived conclusions require
fresh processing.

## Supersession check

| Classification | Disposition |
| --- | --- |
| KEEP | Home / Content / Ask, native components, owner authorization, read-only evidence tools, privacy filters, stable source identity, immutable bytes, node binding, reliable ACKs, pause scopes, existing retention and one-time discovery lifecycle. |
| CHANGE | File/folder creation uses one draft-based native editor; source descriptions become optional owner-controlled versioned metadata; source discovery and semantic processing consume those declarations. |
| REMOVE | Automatic picker launch on task entry, a separate audio-directory action, dense advanced settings in the main form, and source registration as the visible import confirmation action. |
| EXCEPTION | Existing source configurations and continuously tracked files retain their settings. Web import declaration scope and lifecycle remain separate. Historical paid reprocessing still requires an explicit owner action. |
| UNKNOWN | Physical SAF providers, OEM background behavior and real-model attribution/transcription quality require separate validation; generated fixtures do not prove these behaviors. |

This refines the file-entry interaction in [action-first native clients](adr-client-action-first.md)
and [client navigation](client-navigation.md), and extends the source-default context
in [material attribution](adr-material-attribution.md). It does not supersede source
authorization, retention, physical capture, automatic memory admission or charged
historical-work boundaries.

## Validation requirements

Generated fixtures exercise the real Home/Add/editor/picker ordering, cancelled and
changed selections, draft recreation, existing URI/custom settings, audio defaults
and manual retention, one-time versus continuous input, offline/restart delivery,
and metadata edits with pending files. Central tests cover version concurrency,
clearing, encryption and backup, existing/future Material inheritance, source
discovery and context paging, summary/Memory/query propagation, stale commits and
absence of historical model grants. Cross-end checks use the real source/context
API and transport ordering. Native builds, simulator checks, physical devices and
live-model checks are reported separately in the corresponding validation record.
