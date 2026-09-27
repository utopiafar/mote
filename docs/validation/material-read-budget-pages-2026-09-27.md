# Material pages within the existing result budget

`material_read.length` bounds body UTF-16 units. The complete tool response also
contains material metadata, spans, original references and host budget metadata.
A valid body request could therefore exceed the serialized result budget and
force the model to request a smaller page.

The shared bridge now fits a page within the unchanged per-result and remaining
query character budgets. It first reads the requested window through the normal
reader. If the fully validated and projected JSON is too large, it halves the
requested body length and reads the same pinned revision, offset and scope again.
Lengths of 1–12000 require at most 14 local candidate reads. These reads do not
invoke a model. Reader errors, invalid pages, changed revisions, scope failures
and cancellation are not treated as budget failures. They stop the tool call.

Only the accepted page contributes delivered characters, disclosure IDs and a
successful tool trace. The bridge does not trim serialized JSON, remove provenance
or infer relevance. The reader recomputes the spans and original references for
each shorter window. The existing limit of 64 spans and 30 original references
remains in force. If even the minimum page does not fit, the existing structured
budget error is returned; the host does not grant the rejected page's IDs.

The result includes `data.pagination`:

```json
{"requestedLength":10000,"returnedLength":5000,"limitedBy":"host_budget"}
```

`limitedBy` is `null` when the host did not shrink the request. A shorter page can
also arise from the existing block boundary or the end of the material.
`data.textRange.nextOffset` always identifies the actual continuation in the
original UTF-16 coordinate space; `null` means the end. The bridge rejects a
non-advancing or inconsistent continuation. Offsets and text are not normalized.
The complete result, including pagination metadata, is charged to the same
existing character budget.

Successful host tool traces retain the original model arguments and add
`materialPage` with `readAttempts`, `requestedLength`, `returnedLength` and
`budgetLimited`. A rejected tool trace records the local `readAttempts` too.
These counts are separate from provider requests and model tool calls. Codex and
the Harness adapters continue to transmit ordinary JSON tool results unchanged.

The server reader may establish internal source grants while preparing a
candidate. Such a grant alone is insufficient to expand or cite it: the bridge
only discovers the accepted page's IDs, and image reading still requires an
accepted original expansion. Generated tests simulate those early internal
grants and verify that omitted IDs cannot be expanded or read as images.
An additional server integration test uses actual generated captures,
`MaterialStore`, `EvidenceReader.agent`, an `AsyncLocalStorage` query identity,
and the bridge. It verifies that the larger rejected candidate really establishes
an internal screen grant, while both omitted screen and note capture IDs remain
unavailable through bridge `evidence`, `read_image`, `read_file_evidence`,
`file_chunks`, and `source_history`, including typed capture aliases. They cannot
be cited. An accepted screen still requires explicit original expansion before
its image is readable. `read_raw` is not an exposed tool in this production
revision and is tested only as an unknown-tool rejection. A fresh query cannot
inherit the preparatory source grant.

## Offline validation

Generated fixtures cover full serialized budgets, original offsets and both
capture-member and archive-anchor reference shapes, the 64-block boundary,
empty end pages, non-advancing readers, cancellation, scope/version/deletion
failures, concurrent consumption of the total budget, and metadata that cannot
fit even after 14 local reads. Provider fixtures verify the same accepted page
through a fake Codex App Server and real Harness adapters connected exclusively
to loopback fake providers for Chat Completions, Responses, Anthropic and Google.
Existing server Material paging/reader/projection tests also run unchanged.

The generated oversized request uses local lengths `[10000, 5000]`, returns one
successful model tool result and records two local reads. A metadata-only size
failure terminates after 14 reads with zero successful material results.

These are transport and authorization checks. No real model, private corpus,
semantic quality assessment, or token/latency benefit comparison is performed.
Halving is deliberately bounded and does not attempt to maximize page size.
Repeated local authorization work and more pages can still cost time; a fixed
sample live comparison would be required before claiming net efficiency gains.
