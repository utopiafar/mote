# Fresh newcomer evaluation — Android R25

## Outcome

The empty account explains saving and retrieval clearly. I completed the first save, discovered the route from a note to a lasting memory, inspected its original, and found a weekly review with evidence. Correcting the newly created memory failed: saving created a history version while retaining the old content.

| Goal | Observed result | Evidence |
| --- | --- | --- |
| Save a short preference | Completed from the obvious first-record button; the saved note retained the entered text. | `01`–`04` |
| Keep a lasting fact and inspect its original | Completed through the note’s “从这份资料整理记忆”; the resulting memory linked to the correct note and original text. | `05`–`09` |
| Correct that fact | Blocked by a visible save/history mismatch. The editor held the correction, but the card, new history version, and reopened editor retained the original text. | `10`–`14` |
| Review changes across a week and inspect evidence | Discovered from “生成一份阶段回顾”. After enabling samples through the visible data selector, the seven-day report linked to the expected supporting originals. A source-date explanation remains incomplete. | `15`–`27` |

## Method and first impression

Fresh isolated Chromium context, viewport 390 × 844, default empty account. The candidate was `rounds/r25/android.html`, served through the supplied browser helper. I inspected only rendered content, controls, and screenshots. I did not inspect the application HTML/JavaScript implementation, other reports, a feature inventory, or internal application state. All navigation used observed labels and controls; no route was supplied to the evaluator after initial loading.

`first-look.md` was saved before any UI action. My first impression was a personal archive for notes, files, and device records, with later search/questions and original-source checking. “写下第一条记录” was immediately actionable. “记忆库”, the distinction between a source and original evidence, and the purpose of “活动” were initially uncertain. The note detail and memory page subsequently resolved the distinction between records, lasting memory, and stage reviews.

## Actionable findings

### Memory correction is silently discarded while history claims it was saved

**Observed reproduction:**

1. Save `写作时喜欢短句，会议纪要先写决定` as a note.
2. Open that note, choose “从这份资料整理记忆”, supply the context `请长期记住我的写作偏好：喜欢短句；会议纪要先写决定。`, and start organizing.
3. On the created memory, choose “管理这条记忆”.
4. Replace “记忆内容” with `写作时通常喜欢短句；会议纪要先写决定和行动项。`.
5. Click “保存这条记忆”.
6. Inspect the current memory, “全部修改记录”, and the reopened editor.

**Actual:** The draft screenshot and rendered field value contain the corrected text. Saving closes the editor and advances the effective time. The current memory still says `写作时喜欢短句，会议纪要先写决定`. History contains version 2 marked “人工纠正，替代版本 1”, but version 2 repeats version 1’s original wording. Reopening the editor also shows the original wording. There is no visible failure message explaining that the correction was lost.

**Why it matters:** The UI promises that users can correct a lasting fact and preserves an apparently successful audit entry. Here the visible content and the claimed correction disagree. This prevents completion of the correction goal and makes later reliance on the memory unsafe.

**Recommended behavior:** Save the editor’s current content into the current memory and its new history version. Reopening the editor should show that saved correction. If saving fails, keep the draft and make the failure visible; do not create a successful correction entry. Retaining the original supporting note is appropriate.

**Evidence:** `11-memory-correction-draft.png/json`, `12-memory-corrected.png/json`, `13-memory-history.png/json`, `14-reopened-correction.png/json`; exact actions and rendered values in `rawtrace.json`.

### Weekly evidence cannot explain why an event outside the displayed week is included

**Observed:** The sample report says `10月14日–20日 · 按保存日期纳入 6 份资料`. Its material list includes “周四设计评审”. Opening that material and “查看原始内容” shows `记录时间 10月22日 14:00`, with the body describing an event on October 22. Neither the evidence list, detail, nor original dialog shows its save date.

**Interpretation:** The report explicitly says that inclusion uses save date, so this is not evidence of incorrect filtering. It is a verification gap: the only visible date on this source is outside the selected interval, and the date that supposedly explains inclusion is absent.

**Recommended behavior:** Display the saved-on date used for inclusion alongside the event time, and label the latter as event time when the source is a calendar entry. The report evidence list or original dialog should let a newcomer reconcile the entry with the selected range.

**Evidence:** `20-weekly-review.png/json`, `24-weekly-calendar-evidence.png/json`, `25-weekly-calendar-original.png/json`.

## Discovery and evidence behaviors that worked

- The initial primary button led directly to a simple text editor, and saving offered “打开这条笔记”.
- The saved note exposed the memory action in context. No menu search or guessed destination was needed.
- The memory explanation identified it as long-lived information with evidence and correction. Its evidence button opened the correct synthetic note; the original dialog retained the original text and saving metadata.
- “生成一份阶段回顾” gave a natural transition to weekly review. The one-note account produced a review of that note and did not invent a next action.
- After the visible selector enabled existing samples, the library exposed “资料 / 记忆 / 洞察” with a plain explanation of their differences.
- The seven-day review retained the entered question and displayed the date range, source count, change summary, and source links. The research note supported the distinction between records, memory, and insights. The product-review note supported the later focus on first-add steps and the Thursday follow-up.
- “返回记忆” and “返回洞察报告” preserved the task context. I needed no wrong turn to locate any of the three goal areas. The additional history and editor visits were deliberate checks after the correction appeared not to save.

## Evidence package and limits

`actions.md` lists the actual interactions in order. `rawtrace.json` stores each action with its resulting rendered observation. Numbered PNG/JSON pairs preserve the key screens. `browser-trace.zip` contains the browser trace, and `browser-errors.json` records page errors. Screenshots are full-page captures taken from the 390 × 844 browser viewport.

The sample data was enabled only after the untouched first-look record and the empty-account note/memory/correction sequence. This changed the fixture through the visible prototype control and was not an application navigation failure. No backend behavior, native Android capability, operating-system permission flow, persistence across restarts, or unrelated surface was evaluated. No authoring changes were made to the prototype. No numeric score is assigned.
