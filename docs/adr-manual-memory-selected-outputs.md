# ADR: preserve explicitly selected Memory outputs

Date: 2026-10-09. Status: accepted for the manual selection correction.

A composed Material can contain source text, exact OCR/transcript blocks and
visual interpretations. Its automatic source policy may choose only some of
those outputs. Manual requests with explicit current evidence IDs inherited that
automatic default even when the recipe declared no input requirements. Selected
OCR anchors could disappear from the resulting job, leaving only interpretation
text. An exact allowlist was consequently a ceiling without ensuring that the
chosen supported originals actually reached the worker.

MaterialStore owns the mapping from current anchors to declared output blocks.
For a recipe without explicit requirements, the manual selector now derives its
pins from ready named outputs containing the chosen anchors. It retains the
original allowlist. Blocks without complete declared mappings use the existing
whole-Material readiness and revision fence. No image pixels, future siblings or
unselected evidence are added. Existing jobs and automatic grants stay frozen;
an owner-authorized fresh manual request can select the missing current outputs.

## Supersession check

| Classification | Disposition |
| --- | --- |
| KEEP | Explicit recipe requirements, automatic source input policies and receipts, range selection, exact allowlists, source pins, permissions, quote validation, review and commit fences. |
| CHANGE | An exact manual selection without explicit recipe requirements pins the mapped ready outputs it actually names. |
| REMOVE | Applying an automatic default that silently excludes selected current OCR/transcript originals from that manual request. |
| EXCEPTION | Unmapped legacy blocks retain conservative whole-Material semantics. Explicit recipe restrictions can still exclude evidence outside that recipe. |
| UNKNOWN | Providing text originals does not guarantee semantic recall or resolve a genuinely visual question; extraction still has no pixel-read capability. |

Affected surfaces: Material anchor/output mapping, EvidenceReader manual plan
construction, existing manual-job HTTP lifecycle and input-plan documentation.
The automatic organizer, frozen jobs, media workers, extraction/review prompts,
retry policy, model selection and UI navigation are unchanged. Generated route
regressions verify delivery and lifecycle boundaries; live corpus recovery and
semantic quality require their own private receipts and observations.
