# Structural page rules

`builtin.json` is the canonical source for the generated TypeScript module and Android rule asset. Android uploads named observations in the current version 3 format. Rule authoring supports explicit article/product mappings and version 3 named fields; article/product extraction produces the same version 3 observation format.

## Current exact-version mappings

The pack includes resource-ID mappings and 109 converted subtree mappings plus one current-layout variant for these exact versions. Xiaohongshu 9.51.0 and Bilibili 9.16.1 reuse the prior 9.50.0 / 9.15.0 selectors and subtree guards at the owner’s request; rebinding the version does not establish that every page still matches:

| App | Exact version | Converted subtree rules | Additional resource-ID mappings |
|---|---|---:|---|
| Xiaohongshu | 9.51.0 | 25 + 1 current-layout variant | Visible video captions and note author |
| WeRead | 10.2.2 | 4 | Individual bookshelf titles and mini-player progress |
| Bilibili | 9.16.1 | 46 | Uploader display fields, player progress, scoped ad titles |
| QQ | 9.3.75 | 34 | Conversation header display fields |

These are migrations of reviewed offline declarative rules, **not claims of current physical-device support**. No historical personal text, screenshots, coordinates, or record identifiers are included. Version 3 preserves the rules' named field semantics: message body and quoted message are separate; displayed time, progress, counts and descriptions remain original display strings; app-generated summaries remain labelled as such. A rule match establishes an observation, not reading completion, agreement, playback duration or an action.

The pack retains the existing WeChat 8.0.78 article and Taobao 10.66.22 product mappings. WeChat uses the `js_article`, `activity-name`, `js_name` and `js_content` containers in `TmplWebViewMMUI`. Taobao uses the `rv_main_container_wrapper` RecyclerView and original child path `[0,0,1,0]` in `com.taobao.tao.welcome.Welcome`. Taobao's historical export did not retain platform indices, so current Android index correspondence remains unverified. Generated fixtures validate these extraction contracts, not real-App coverage.

Physical-device checks on 2026-10-27 verified WeRead 10.2.2 bookshelf titles, Xiaohongshu 9.51.0 note author, and Bilibili 9.16.1 scoped ad title and displayed player progress through the real Android collector into the running development Central archive and searchable materials. This does not validate every mapping, note body, video title, uploader field, or viewing duration. The additional Xiaohongshu two-visible-leaf variant has generated structural conformance coverage; its Activity-bound extraction remains unverified on the device.

## Named fields and structural fences

Version 3 supports configurable snake_case field names with `select`, optional `ancestor`, optional `childPath`, explicit `source` (`text`, `description`, or `state`), `cardinality` (`one` or `many`), and `required`. A repeat rule emits each matching container independently. Multiple matching rules retain independent observations; lists in one field imply no pairing with lists in another field. Duplicate strings remain separate observations.

`region` must uniquely identify a container. `repeatParent` matches a repeat container's direct parent. `childPath` follows the platform's original child indices from the repeat container or region. Empty paths select the root itself. Privacy filtering must not compact or renumber those indices: a hidden or skipped target cannot become its neighbor.

`repeatSubtreeHash` uses SHA256 of compact JSON `[resourceId, role, directChildHashes]`, recursively, with children in original index order. This matches the portable offline subtree contract. Bounds, text, descriptions and node IDs never participate. Removing hidden, sensitive or unsupported nodes can cause a conservative mismatch; the collector must not weaken the guard to recover a match. These rules need a fresh review when the app version changes.

Android description extraction is limited to an explicitly matched, fully visible, safe leaf. A container's composite description can include hidden descendant content and is therefore unavailable. Some converted candidates, particularly WeRead chapter cover descriptions and composite feed cards, will consequently emit fewer fields or no observation. The rules remain guarded; descriptions are never replaced with descendant scraping or an untyped fallback. On-device OCR is a separate explicit capture option.

## Reusable converter and exclusions

`convert-rule-pack.mjs` accepts declarative format 1 offline rule metadata and writes version 3 repeat mappings. It preserves exact app version, selectors, subtree hashes, field names, original paths, sources and cardinality. It rejects unknown constraints instead of silently dropping them. It never opens records or images.

```sh
node adapters/ui/convert-rule-pack.mjs INPUT.rules.json OUTPUT.json
node --test adapters/ui/convert-rule-pack.test.mjs
```

The per-App generated results are in `packs/`; `packs/conversion-report.json` lists exclusions. Whole-page `structureHashes` are excluded because their historical encoding included export-specific parent IDs. Broad rules without a portable subtree guard require individual native-selector review. Selected native mappings in `builtin.json` cover only explicitly reviewed resource IDs, scoped ad ancestors, or individual repeated title/caption nodes. The converter does not silently turn a whole-page or subtree rule into an unrestricted role selector.

## Generated examples and conformance

`examples/generated-article-product.json` remains an authoring example for generated fixture Apps. It is not a support claim for third-party Apps. `fixtures/structured-conformance.json` exercises article/product extraction. `fixtures/named-field-conformance.json` contains six generated current-version subtree fixtures: XHS title/body with and without its hidden separator, WeRead chapter-container rejection, Bilibili title and metadata, and QQ message fields. Only reviewed structural resource IDs, roles and child ordering are retained; all content strings and bounds are generated. The WeRead fixture intentionally demonstrates safe rejection of a container description.

```sh
npm run build -w @mote/shared
node scripts/ui-adapters.mjs generate
node scripts/generate-ui-rule-fixtures.mjs --check
node scripts/generate-ui-structured-fixtures.mjs --check
node --test packages/shared/test/ui-page.test.mjs packages/shared/test/named-fields-conformance.test.mjs
```

The named-field tests independently verify the historical subtree hash using Node crypto, reject wrong versions and changed topologies, preserve original indices after a removed sibling, retain independently matching rules, and preserve duplicate bookshelf titles. Fixture conformance proves extraction and protocol behavior. Physical-device accessibility, actual latest App layouts, safe description availability and OCR quality require separate device evidence.
