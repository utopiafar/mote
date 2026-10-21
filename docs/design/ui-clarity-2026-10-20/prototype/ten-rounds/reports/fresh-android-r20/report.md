# Fresh first-use review: Android R20

## Outcome

I understood the product as a personal archive for files, thoughts, and device records, with search and questions as its later value. I found a path from the empty home screen to continuous folder collection, connected the sample folder, and paused it. The pause state clearly says that new content stops arriving and saved content remains readable.

The full data goal is only partially demonstrated. The folder is an explicit prototype example, not a real Android file selection, and its saved-item count stayed at zero. I could confirm the configured collection and pause states, but could not open an existing document before and after pausing to establish retention.

The largest concrete usability problem was the connected-source card at phone width: the source name, path, and count collapsed into a narrow vertical column beside its action buttons. Android setup also used a computer path and computer terminology.

## Method and first impression

- Candidate: `ten-rounds/rounds/r20/android.html` only.
- Real Chromium viewport: 390 × 844, empty default account, light appearance.
- `first-look.json` was written after viewing `00-first-look-viewport.png` and before the first application action.
- I read the supplied browser helper, rendered UI, and visible controls. I did not read the candidate source, other reports, author tests, or a feature list.
- This was a bounded, single-path first-use review. I made no candidate changes and assigned no target score.

My first intended action was **导入已有文件**. I expected an Android file selection step, followed by saved, readable, searchable copies. The initial viewport did not establish whether importing would watch later changes. The product promise and example were understandable. **设备记录** did not specify what device information was recorded, and **来源** could initially mean either collection connections or provenance.

The first viewport showed the two initial actions and most of the example card. Ongoing collection was not visible before scrolling. Evidence: [initial phone screenshot](00-first-look-viewport.png), [pre-action interpretation](first-look.json).

## What I did

| Step | My action and expectation | Observed result |
| --- | --- | --- |
| 1 | Tapped **导入已有文件**, expecting to select local material. | The heading explained that this saves existing files once and mentioned a folder source for subsequent changes. This corrected my initial assumption. |
| 2 | Scrolled the import form to find the continuous option. | Found **需要持续同步文件夹？** below the form, then tapped it. |
| 3 | Read the folder setup. | It opened as **管理文件夹来源**, with `~/Documents/研究资料`, a checked continuous-sync checkbox, and text about resuming. No prior connection had been made in this walkthrough. |
| 4 | Used the disclosed sample folder, renamed it **手机资料**, selected **本机与中央都保留**, and tapped **连接并保存**. | A saved-settings message and an active-receiving message appeared. The management screen now named the source. |
| 5 | Opened bottom navigation **来源**, then scrolled to connected sources. | The source was shown as syncing, with zero saved items. Its name and metadata were difficult to read because the card compressed them into a vertical column. |
| 6 | Tapped **浏览已保存资料** to check the result. | The library correctly scoped itself to **手机资料**, but said the source had no saved material yet. |
| 7 | Dismissed the persistent saved-settings toast, tapped **管理此来源**, and scrolled to the action row. | Found **暂停此来源** alongside **保存设置** and **取消**. The continuous-sync checkbox remained checked. |
| 8 | Tapped **暂停此来源**. | The button changed to **恢复此来源**. The main paused-status message was above the current viewport, so I scrolled upward to read it. |
| 9 | Read the paused status, then opened **浏览此来源的资料**. | Both management and library stated that new content was paused and saved material remained readable. The library still contained zero items. I stopped here. |

## Findings and concrete suggestions

### 1. Connected-source information becomes nearly unreadable at 390 px — high priority

The four-character source name **手机资料** wrapped to one character per line. The Android label, path, and zero-item count formed a long, narrow column, while the status and two actions occupied the neighboring horizontal space. This is exactly the row I needed to identify and manage my collection.

Give the name and path a full-width text area on a phone. Put the status and count below them, followed by a separate action row. Keep the path allowed to wrap naturally without forcing Chinese text into individual-character lines. Evidence: [connected-source row](07-connected-source-row-viewport.png).

### 2. The Android setup reads like a computer setup — high priority

The folder field contains `~/Documents/研究资料`, and the save-mode explanation says **本机指这台电脑**. The sources page then labels that same path **Android**. As a phone user, I could not tell whether I was selecting phone storage or configuring a folder on another machine. The form discloses that the folder is a prototype example; the confusing device framing still affects the interaction being evaluated.

Use an Android folder-selection action and an Android-shaped example location. Describe the device as **这台手机** or **此 Android 设备**, and state where the central copy lives in terms a new user can recognize. Evidence: [first folder setup](03-folder-setup-viewport.png), [chosen local-and-central preservation](04-folder-chosen.png), [source row](07-connected-source-row-viewport.png).

### 3. A new connection opens with management and resume language — medium priority

Before I connected anything, the page already said **管理文件夹来源**, asked me to verify “this folder,” and described the checked option as **这是恢复接收后的策略**. The only forward action was correctly labeled **连接并保存**, so the page offered competing signals about whether the source already existed or was paused.

Use a creation title such as **连接文件夹** for the first connection. Explain the checked option as saving future additions or changes. Reserve the “resume” explanation for an actually paused source. Evidence: [first folder setup](03-folder-setup-viewport.png).

### 4. The route from local files to ongoing collection takes a detour — medium priority

My first reasonable local-file action was the visible **导入已有文件**. The import introduction correctly explains the one-time behavior, but the actionable continuous-folder link is below the form. I had to scroll past save mode, name, parser, and image processing before reaching it. The homepage's large example occupied the space where a continuous-collection entry could have been noticed sooner.

Place a **持续同步文件夹** link directly beside the import introduction that explains the distinction. A short visible continuous-collection option near the initial home actions would also make the choice easier. Evidence: [initial screen](00-first-look-viewport.png), [import top](01-import-viewport.png), [import bottom](02-import-scrolled-settled-viewport.png).

### 5. Pausing works, but the complete feedback is away from the action — medium priority

The button changes from **暂停此来源** to **恢复此来源**, which gives immediate evidence that the action happened. However, after tapping it at the scrolled action row, the retention explanation is above the viewport. The checked **持续同步后续变化** option remains visible, so there is a moment where a checked continuous option and a paused source must be mentally reconciled. Its helper explains a saved future policy, but that distinction is secondary text.

Show **已暂停 · 已保存资料仍可阅读** next to the changed button, or bring a concise confirmation into view. Label the checkbox as the policy used when collection is running, and only introduce the resumption qualifier in paused state. Evidence: [action area before pause](09-management-actions-viewport.png), [immediate result](10-pause-result-viewport.png), [paused status after scrolling up](11-paused-status-viewport.png).

### 6. Saving the connection gives no concrete first-collection result — confidence limitation

The source says it is receiving selected content, but the count remains zero. The scoped library explains that received content will appear there, without showing a first scan, waiting condition, or first saved example. I therefore could not tell whether collection was still pending or whether the example simply did not simulate receipt.

For the prototype, show a clearly labeled first received sample or an explicit pending/empty-folder reason. For the actual product, expose the first collection's status and any permission requirement. Keep this distinction explicit: a saved connection is not yet evidence that a file was saved. Evidence: [saved connection](05-connected-viewport.png), [library before pause](08-browse-saved-before-pause.png), [library after pause](12-browse-after-pause.png).

## What already helped

The landing page gave a concrete, understandable example of saving records and asking about them later. The import page's one-time wording corrected my assumption early. Source-specific library browsing made the active filter clear, named the selected source, and offered management and all-material navigation. The paused management banner and library banner agreed about stopping new content while keeping existing material readable. These are useful foundations for the main task.

## Evidence and boundaries

The folder path was left as the explicitly disclosed prototype sample; only its display name and visible save-mode choice were changed. I did not seed unrelated content, switch the preview into a populated state, inspect application state, or claim a successful Android filesystem integration. The review covers this specific empty-account route at one phone size.

`trace.zip` contains the browser interaction trace. Numbered PNGs and rendered-UI JSON snapshots preserve the states used above. `02-import-scrolled-viewport.png` was captured while scrolling was still settling; the report uses `02-import-scrolled-settled-viewport.png` instead and does not treat the transient capture as a UI defect.
