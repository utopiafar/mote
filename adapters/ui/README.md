# Structural page rules

`builtin.json` is the source for the generated TypeScript module and the Android rule asset. It contains both legacy selected-node rules and version 2 article/product mappings. A legacy rule remains readable for desktop and queued observations; it is not a structured Android mapping.

## Version 2 mappings and provenance

| Rule | App version and historical structural evidence | Limits |
|---|---|---|
| `wechat-article-android-8.0.78` | WeChat 8.0.78, `TmplWebViewMMUI`; `js_article` region, `activity-name` title, `js_name` author, TextView descendants of `js_content`. The original lab's 2026-09-22 article snapshot supplied the structure; committed text is newly generated. | Visible window only. No observed URL or article ID was available, so observations remain identity-free fragments. This release has not revalidated the real App. |
| `taobao-products-android-10.66.22` | Taobao 10.66.22, `com.taobao.tao.welcome.Welcome`; the original lab's `20260922_115242_taobao-home.json` supplies this Activity and the `rv_main_container_wrapper`, RecyclerView direct FrameLayout card structure. Four title endpoints follow recorded sibling path `[0,0,1,0]`; the historical JSON did not retain platform child indices, so their current Android index correspondence is unverified. Committed text is newly generated. | Visible title only. URLs and product IDs are not exposed by that historical structure and are never guessed. Changed layouts fail the mapping and allow screenshot fallback. This release has not revalidated the real App. |

Mappings use an exact installed App version. `region` must uniquely identify a container. `repeatParent` matches a repeated container's direct parent. `fields.*.childPath` follows the platform's original child indices from the repeat container (or region for a non-repeated page), then verifies the required selector. Privacy filtering must not compact or renumber those indices: a hidden or skipped target fails the path rather than selecting its neighbor.

The historical WeChat `20260922_110438_wechat-article3.json` contains 256 nodes and is already truncated. Its 138 body TextViews occur at zero-based positions 54–255 and depths 25–27, within the current 256-node/32-depth traversal budgets. Earlier `20260922_110327` and `20260922_110403` article snapshots have no TextView descendants under `js_content`; this mapping yields no article body there and permits screenshot fallback. These are structural observations from saved lab metadata, not current device validation.

Article title and body are required; product title is required. Scalar fields with multiple matches are not guessed. Missing required fields reject that object; optional ambiguous fields are omitted. Body order and duplicate paragraphs are preserved. Only an actually observed HTTP(S) link or explicit source item ID can grant a reliable identity. Titles never grant cross-observation identity.

Each version 2 upload record contains one article or product object, adapter and App versions, visible-window coverage, and observation times. It does not contain the local UI tree, node coordinates, roles or resource IDs. Capture and metadata timestamps match the last observation; duration remains zero and is not a claim about reading time. A successfully mapped visible fragment can replace a screenshot without claiming the whole article was captured.

## Generated examples and conformance

`examples/generated-article-product.json` is an importable rule pack for generated fixture Apps, not a claim of support for any installed third-party App. `fixtures/structured-conformance.json` includes that pack and generated mirrors of the historical mappings, with normal, wrong-version, wrong-page, missing-field, repeated-card, original-index, long-text and truncation cases. No captured personal text or screenshots are committed.

```sh
npm run build -w @mote/shared
node scripts/ui-adapters.mjs generate
node scripts/generate-ui-rule-fixtures.mjs --check
node scripts/generate-ui-structured-fixtures.mjs --check
node --test packages/shared/test/ui-page.test.mjs
```

The TypeScript and Kotlin rule engines replay the same generated snapshots. Fixture conformance proves extraction and protocol behavior, not current real-device or real-App accessibility coverage.
