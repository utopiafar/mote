# Independent user-feature contract for R30–R34

Status: **frozen before R30 evaluation**. Source: `81a73c0ec81af876d6eeef71451b75cd51684b34` (current application code). Owner: independent inventory agent, separate from the candidate generator and evaluator.

## Scope and count discipline

The historical 20 families and 78 directory entries are retained only as a crosswalk. They do not establish that their nested controls, data semantics, errors, or resulting state survived. The contract contains **188 named semantic features**, with **400 input requirements**, **642 action requirements**, and **618 outcome requirements**. These are authored audit units, not a claim to enumerate every possible backend branch. Runtime journeys have not been run by this inventory agent.

Central server-local collection is excluded by the owner’s correction. Browser-selected files/folders/ZIPs remain one-time uploads. macOS and Android collectors own local filesystem collection. Current code and owner corrections supersede stale catalogue text, including token login, v2-only portable import, and Central directory controls.

## Evaluation instructions

The evaluator receives this contract independently of the generator. Score each applicable must-keep item as observed / partial / missing / blocked / not exercised. Require a real control and a reviewable outcome; a route, menu item, generic modal, or toast cannot prove completion. Progressive disclosure may reduce page density but must preserve named entry points, context, inputs, and state-specific recovery.

A feature with a source anchor is **source-audited**. It is not thereby runtime-tested. Native-specific capabilities must be assessed only on supported native platforms or through clearly labeled handoff; do not claim cross-platform parity from a shared label.

## Cross-platform applicability

The `platforms` field records the implementation evidence source. Every UF requirement also applies on Mac and Android wherever the candidate exposes that shared Central task (Library, Import, Ask, Activity, Sources or Settings). A rendered import form on any of the three platforms must preserve its explanation, options, persistence and recovery. Where native code delegates, a clear functional Central handoff is acceptable. NAT requirements retain their exact supported native platforms; do not invent native parity or exempt shared tasks merely because their source code is Central web.

## Families

| Family | User goal | Semantic features |
| --- | --- | --- |
| F01 | 理解 Mote，知道如何放入资料、找回和提问 | 3 |
| F02 | 登录中央、连接设备、恢复连接 | 10 |
| F03 | 保存随手记、保留草稿、离线恢复 | 5 |
| F04 | 导入已有文件、文件夹、ZIP、音频或图片 | 12 |
| F05 | 持续同步一个文件夹或文件 | 11 |
| F06 | 记录屏幕、页面、应用活动、通知/媒体状态 | 15 |
| F07 | 管理隐私和三个不同暂停范围 | 12 |
| F08 | 浏览完整资料、原始记录、文件/录音，并核对来源 | 24 |
| F09 | 根据资料提问，查看依据和历史 | 5 |
| F10 | 看后台正在做什么，处理失败或等待确认 | 4 |
| F11 | 配置必要模型，随后继续原任务 | 17 |
| F12 | 找到所有已支持输入来源，不漏掉重要来源 | 5 |
| F13 | 接入飞书文档/日历、Google 日历、Gmail、厂商录音、MCP资料、外部/NAS引用 | 11 |
| F14 | 接入 Coding Agent 会话并回看经验依据 | 2 |
| F15 | 浏览、纠正、删除、导出和手动提取记忆 | 7 |
| F16 | 生成阶段洞察并回看证据 | 3 |
| F17 | 管理普通待办，审核日程建议再写日历 | 5 |
| F18 | 给其他 Chatbot/MCP 与设备授予或撤销权限 | 3 |
| F19 | 自动记忆暂停、选择记忆方案、可信插件安装/启停 | 7 |
| F20 | 存储/保留/备份/导出/删除、用量、诊断、语言与外观 | 27 |

## Detailed semantic requirements

### F01 — 理解 Mote，知道如何放入资料、找回和提问

#### UF-PRODUCT-BOUNDARIES — Understand where records are collected, archived, read, and used by AI

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 / 添加 / 来源
- **Historical units:** C02, C03
- **Inputs:** No new input fields
- **Actions:** Choose notes, import, sources, library, Ask, activity, or settings; Return to the owning workspace
- **Required outcomes:** Central archives/searches/understands selected material; Mac and Android collect on their own devices; Models are optional for recording and browsing
- **Visible entry:** A short purpose statement and a few primary task entries.
- **May be disclosed progressively:** Full capability catalogue, installation guidance, and uncommon views.
- **Adversarial journey:** A new user on Central wants to sync a local folder: identify the collector route without a server directory field.
- **Source:** [apps/web/src/DeviceOverview.tsx:21–36](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/DeviceOverview.tsx#L21-L36); [apps/web/src/Archive.tsx:33–66](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Archive.tsx#L33-L66); [apps/web/src/Ask.tsx:16–22](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Ask.tsx#L16-L22)

#### UF-NAVIGATION-STATE — Find a task and return from its detail without losing context

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 全局导航 / 对应页面
- **Historical units:** C02
- **Inputs:** No new input fields
- **Actions:** Open a workspace; Open and close a detail; Return to parent; Use an unavailable-entry fallback
- **Required outcomes:** Selected list/detail identity and applicable filters remain meaningful; Unsupported entry does not pretend to be available
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Open a filtered material, then its source and original, close the detail, and recover the same reading context.
- **Source:** [apps/web/src/LibraryBrowse.tsx:21–44](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/LibraryBrowse.tsx#L21-L44); [apps/web/src/main.tsx:385–419](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/main.tsx#L385-L419); [apps/web/src/ScopedConfiguration.tsx:82–94](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedConfiguration.tsx#L82-L94)

#### NAT-060 — Protect unsaved settings and return to original task

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Every settings/task page
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Unsaved field edits
- **Actions:** Save; Continue editing; Explicitly discard; Back to caller
- **Required outcomes:** Unsaved marker; Native back/history preserved; Permission/connection handoffs return to source task
- **Visible entry:** Unsaved status and save visible when dirty; back does not silently lose edits
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** From Ask open connection, edit settings, back: choose continue/discard and return to Ask rather than unrelated overview.
- **Source:** [apps/desktop/src/index.html:42–42](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L42-L42); [apps/desktop/src/ui.ts:35–89](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L35-L89); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:1539–1640](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L1539-L1640)

### F02 — 登录中央、连接设备、恢复连接

#### UF-ACCOUNT-LOGIN — Sign in to the selected Central account and continue the intended task

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 登录 / 设置 → 当前账号
- **Historical units:** C01
- **Inputs:** Username; Password; Browser session / 1 day / 7 days / 30 days
- **Actions:** Sign in and continue; Close login; Retry a failed login
- **Required outcomes:** Current Central origin is shown; Destination is retained; Busy, validation failure, and expired session states are explicit
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Start Ask while signed out, choose a duration, fail once, then sign in and return to the original destination.
- **Source:** [apps/web/src/shell-components.tsx:290–333](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/shell-components.tsx#L290-L333); [apps/web/src/main.tsx:198–206](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/main.tsx#L198-L206)

#### UF-ACCOUNT-SESSION — Know which account is active and manage its session

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 设置 → 当前账号
- **Historical units:** C01
- **Inputs:** Current password; New password
- **Actions:** Switch account; Sign out; Change password
- **Required outcomes:** Username, administrator role, origin, and expiry are visible; Private state is bound to the active account
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** With a note draft in one account, switch accounts and verify the old account content is not shown as the new account.
- **Source:** [apps/web/src/AccountSettings.tsx:11–25](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/AccountSettings.tsx#L11-L25); [apps/web/src/web-auth.ts:1–55](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/web-auth.ts#L1-L55)

#### UF-ACCOUNT-ADMIN — Administer accounts without exposing other users’ private archives

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 当前账号 → 账号管理
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** New username; Initial password; Administrator checkbox; Replacement password
- **Actions:** Create account; Enable / disable account; Reset password
- **Required outcomes:** Role and disabled state update; Controls are administrator-scoped; Errors are local to the attempted mutation
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** As a regular account inspect settings; administrator account management must not appear as a generally available capability.
- **Source:** [apps/web/src/AccountSettings.tsx:27–43](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/AccountSettings.tsx#L27-L43)

#### UF-DEVICE-INVITATION — Issue a one-use invitation to the correct collector

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 来源 → 连接设备
- **Historical units:** C05
- **Inputs:** Device-reachable Central address; Connection name; New device or existing device identity
- **Actions:** Generate / regenerate invitation; Select original device for re-pairing
- **Required outcomes:** Device invitation authorizes account-bound collection/sync only; Private library/admin access requires separate login; Loopback address caveat and current device identity remain clear
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Re-pair an existing Android device using a reachable HTTPS address; preserve device identity and do not describe the credential as full account login.
- **Source:** [apps/web/src/DevicePairing.tsx:24–44](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/DevicePairing.tsx#L24-L44)

#### UF-DEVICE-INVITATION-DELIVERY — Transfer and cancel a device invitation

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 来源 → 连接设备 → 邀请详情
- **Historical units:** C05
- **Inputs:** Generated invitation
- **Actions:** Copy JSON; Download JSON; Save QR image; Expand manual-copy content; Cancel invitation
- **Required outcomes:** Countdown / expiry; QR failure has JSON fallback; Closing is not cancellation; Cancelled invitation cannot be reused
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** QR rendering fails; use JSON, then cancel the invitation and distinguish cancellation from simply closing the panel.
- **Source:** [apps/web/src/DevicePairing.tsx:26–44](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/DevicePairing.tsx#L26-L44)

#### UF-CLIENT-LOGIN-APPROVAL — Approve the correct client and credential scope

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 登录 → 客户端批准
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Client name; Current account identity
- **Actions:** Approve client login / collector connection
- **Required outcomes:** Full Central login and collector-only connection are described differently; Receipt account mismatch blocks misleading success
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Approve a collector request and verify it is not described as permission to browse private archives.
- **Source:** [apps/web/src/ClientLoginApproval.tsx:5–21](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ClientLoginApproval.tsx#L5-L21)

#### NAT-035 — Pair device by invitation with identity preview

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Settings / Connection
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Invitation JSON/text/URI; Mac QR image or Android camera QR; Device name
- **Actions:** Import/scan; Preview locally; Confirm; Cancel
- **Required outcomes:** Server/instance/account/device identity shown; Single-use expiry; No auto capture; Unbound queue destination explicitly confirmed
- **Visible entry:** Address/account/device/queue consequence visible before confirm
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Paste invitation while offline; preview works without network; expired or other-account invitation cannot silently redirect queue.
- **Source:** [apps/desktop/src/index.html:177–184](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L177-L184); [apps/android/app/src/main/java/dev/mote/collector/ConnectionActivity.kt:75–119](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/ConnectionActivity.kt#L75-L119)

#### NAT-036 — Recover interrupted pairing and test connection

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Settings / Connection
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Persisted pending invitation; Current device ID
- **Actions:** Resume interrupted confirmation; Test saved connection; Rename device; Copy ID on Android
- **Required outcomes:** Same identity retained; Revoked/offline/mismatch/expiry errors distinct; Tokens not echoed
- **Visible entry:** Recovery and test visible from connection failure
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Lose final pairing receipt and reopen; recover same request/device rather than issue new identity or erase offline queue.
- **Source:** [apps/desktop/src/index.html:181–184](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L181-L184); [apps/android/app/src/main/java/dev/mote/collector/ConnectionActivity.kt:121–146](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/ConnectionActivity.kt#L121-L146); [apps/android/app/src/main/java/dev/mote/collector/ConnectionActivity.kt:166–211](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/ConnectionActivity.kt#L166-L211)

#### NAT-037 — Use manual connection and offline mode safely

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Settings / Advanced connection
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Server URL; Credential; Device name; Explicit local-queue binding
- **Actions:** Save; Test; Clear URL
- **Required outcomes:** Blank address permits local save; Remote HTTPS; Existing bound queue cannot move to another account/server; Existing credential not displayed
- **Visible entry:** Manual connection disclosed under connection; binding effect explicit
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Change server with pending old-bound records; preserve ownership and prevent accidental retargeting.
- **Source:** [apps/desktop/src/index.html:196–198](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L196-L198); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:600–640](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L600-L640)

#### NAT-038 — Keep account sign-in distinct from collector pairing

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Ask / Central account
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Username/password or browser login; Session duration
- **Actions:** Sign in; Browser approval; Sign out; Return to task
- **Required outcomes:** Device credential only collects; Archive/Ask requires account access; Ask unavailable does not block local notes/files
- **Visible entry:** Clear task-specific sign-in route; no conflation with device token
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Device connected but account signed out: save locally, show Ask login, preserve prior question after return.
- **Source:** [apps/desktop/src/index.html:150–154](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L150-L154); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:600–640](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L600-L640)

### F03 — 保存随手记、保留草稿、离线恢复

#### UF-NOTE-DRAFT — Write and recover a note before committing it

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 添加 → 随手记
- **Historical units:** C12
- **Inputs:** Note text up to the implemented limit
- **Actions:** Edit draft; Leave and return; Save and sync
- **Required outcomes:** Draft persistence is scoped to deployment and account; Storage-unavailable warning prevents false saved claims; Saving has explicit local/central outcomes
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Write an unsent note, navigate away, return, then lose network; text remains recoverable and the UI distinguishes local storage from Central acknowledgment.
- **Source:** [apps/web/src/Notes.tsx:119–170](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Notes.tsx#L119-L170); [apps/web/src/Notes.tsx:184–220](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Notes.tsx#L184-L220)

#### UF-NOTE-ATTACHMENTS — Save existing image or audio attachments with or without text

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 添加 → 随手记 → 附件
- **Historical units:** C13
- **Inputs:** Up to 10 existing attachments; Each attachment up to 50 MiB; Optional note text
- **Actions:** Choose files; Remove selected attachment; Save attachment-only note
- **Required outcomes:** Attachment upload precedes note submission; Original archiving and OCR/transcription readiness are separate; No live-recording claim
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Save an audio-only note while transcription is unavailable; retain the original and show pending processing rather than declaring it fully searchable.
- **Source:** [apps/web/src/Notes.tsx:172–220](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Notes.tsx#L172-L220)

#### UF-NOTE-OFFLINE-QUEUE — Recover an offline note submission and find the exact original

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 随手记 → 待同步 / 历史
- **Historical units:** C12
- **Inputs:** No new input fields
- **Actions:** Retry sync; Remove local pending copy after confirmation; Refresh history; Load older notes; Open original
- **Required outcomes:** Local pending state and Central-confirmed history are distinct; Removing local copy does not imply Central deletion; Retry does not promise a second independent note
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Central received a note but its ACK was lost; local removal explains uncertainty and history can be refreshed to inspect the submitted original.
- **Source:** [apps/web/src/Notes.tsx:151–172](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Notes.tsx#L151-L172); [apps/web/src/Notes.tsx:224–230](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Notes.tsx#L224-L230)

#### NAT-047 — Create offline notes with durable drafts

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Add / Quick note
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Note text
- **Actions:** Edit; Autosave draft; Save note; Retry failed save; Clear/new with confirmation on Android
- **Required outcomes:** Local-first persisted note; Sync follows policy; Failure preserves draft; Idempotent submission
- **Visible entry:** Composer and local-save outcome visible
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Interrupt after local queue commit but before schedule success; retry preserves original submission identity and text.
- **Source:** [apps/desktop/src/index.html:110–112](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L110-L112); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:743–822](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L743-L822); [apps/android/app/src/main/java/dev/mote/collector/QuickNotes.kt:16–42](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/QuickNotes.kt#L16-L42)

#### NAT-048 — Add image and voice note attachments through Central

- **Priority / platforms:** P1 / macos, android
- **Canonical home:** Quick note / Attachments
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Image/audio attachment
- **Actions:** Open Central note composer
- **Required outcomes:** Native note attachment link is a Central handoff, not an offline native attachment promise
- **Visible entry:** Named image/voice attachment route
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Tap attachments while disconnected; explain Central requirement without losing local note draft.
- **Source:** [apps/desktop/src/index.html:112–112](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L112-L112); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:825–829](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L825-L829)

### F04 — 导入已有文件、文件夹、ZIP、音频或图片

#### UF-IMPORT-SELECTION — Choose the exact material to import once

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 添加 → 导入资料
- **Historical units:** C09
- **Inputs:** Multiple files; Browser-selected folder; Dragged files/folders; ZIP; Optional material name
- **Actions:** Add files; Inspect paths, count, bytes; Remove one; Clear selection; Enqueue
- **Required outcomes:** Selection errors are inline; Reading-selected-files state blocks unsafe submit; Browser folder selection is one-time upload, never Central folder watching
- **Visible entry:** File/folder selection, selected items, name, contextual-description entry, and submit.
- **May be disclosed progressively:** Long selection list and uncommon parser/image options.
- **Adversarial journey:** Select a folder with documents and attachments, remove one item, name the import, and verify the frozen submission contains precisely the remaining files.
- **Source:** [apps/web/src/Imports.tsx:75–98](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L75-L98); [apps/web/src/Imports.tsx:128–138](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L128-L138)

#### UF-IMPORT-CONTEXT — Tell the Agent how to interpret this batch of material

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 添加 → 导入资料 → 格式、作者与归属说明
- **Historical units:** C09
- **Inputs:** Optional free-form format, author, subject/background, date/timezone and ownership explanation (one existing instruction field, max 12,000 characters)
- **Actions:** Enter context before submission; Enqueue it with selected files
- **Required outcomes:** Exact owner explanation survives submission; Third-party and AI quoted speech retain their original roles; Unknown attribution still permits archiving and useful source-scoped observations
- **Visible entry:** Clearly labeled context entry visible or one obvious labeled disclosure BEFORE enqueue.
- **May be disclosed progressively:** Examples and longer explanation of scope; never hide the entire field in a global settings page.
- **Adversarial journey:** Import mixed personal notes, a vendor quotation, and an AI reply; explain format, subject, author, Asia/Shanghai time, and which passages are yours; inspect the saved explanation exactly.
- **Source:** [apps/web/src/Imports.tsx:133–138](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L133-L138); [packages/shared/src/material-context.ts:24–31](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/packages/shared/src/material-context.ts#L24-L31); [apps/server/src/materials.ts:270–275](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/server/src/materials.ts#L270-L275)

#### UF-IMPORT-CONTEXT-RECOVERY — Correct the interpretation of the same archived import

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 活动 / 导入详情 → 本次说明 / 补充说明
- **Historical units:** C10
- **Inputs:** Existing saved instruction; Revised explanation
- **Actions:** Read saved instruction; Edit explanation; Regenerate preview in awaiting-confirmation / needs-configuration / failed / unsupported states
- **Required outcomes:** Current import identity and originals remain attached; New preview is generated from the revised context; A saved name does not substitute for this explanation
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A preview treats an AI quote as personal belief; open the same import, revise ownership/time explanation, regenerate, inspect it before confirming.
- **Source:** [apps/web/src/Imports.tsx:145–158](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L145-L158); [apps/web/src/Imports.tsx:176–179](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L176-L179)

#### UF-IMPORT-PARSER — Choose a format parser independently from explanatory context

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 导入资料 → 解析方式
- **Historical units:** A02
- **Inputs:** Installed Source Pack and fixed version; Default format/model parsing
- **Actions:** Select parser; Keep the selection visible before submit
- **Required outcomes:** Parser/version is identifiable; Explanation remains background and attribution input; Unavailable fixed component is not silently substituted
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Choose an installed Source Pack and add ownership prose; verify selecting a parser does not erase or replace the prose.
- **Source:** [apps/web/src/Imports.tsx:33–33](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L33-L33); [apps/web/src/Imports.tsx:91–97](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L91-L97); [apps/web/src/Imports.tsx:134–135](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L134-L135)

#### UF-IMPORT-IMAGE-PLAN — Choose how this import’s images are processed

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 导入资料 → 更改本次图片处理
- **Historical units:** A02
- **Inputs:** Follow default; Archive originals only; Available image processing profile
- **Actions:** Select a per-import image plan
- **Required outcomes:** Original is retained first; Chosen override is part of the submitted request; Archive-only does not claim OCR completion
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Select archive-only for a mixed image import and confirm that successful intake is not shown as image text being ready.
- **Source:** [apps/web/src/Imports.tsx:31–33](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L31-L33); [apps/web/src/Imports.tsx:91–97](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L91-L97); [apps/web/src/Imports.tsx:129–129](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L129-L129)

#### UF-IMPORT-UPLOAD-QUEUE — Continue independent uploads without blocking other imports

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 活动 / 导入 → 本地上传队列
- **Historical units:** A03, C10
- **Inputs:** A pending upload item
- **Actions:** Pause; Continue; Retry same submission; Remove local queue item; Reselect missing files
- **Required outcomes:** Per-item bytes/progress; Queued/uploading/submitting/throttled/paused/failed/submitted states; Local bytes need the browser session; Removing the queue item does not delete archived originals
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Pause a large upload, enqueue a second import, leave the page, return and resume; a failed item must not block or impersonate another task.
- **Source:** [apps/web/src/ImportQueueEntry.tsx:7–46](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ImportQueueEntry.tsx#L7-L46); [apps/web/src/Imports.tsx:119–125](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L119-L125)

#### UF-IMPORT-PREVIEW-CONFIRM — Review an ambiguous interpretation before records are published

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 导入详情 → 解析预览
- **Historical units:** C10
- **Inputs:** Preview samples; Expected record count; Attachment counts; Review-gate reason; Warnings
- **Actions:** Inspect preview; Confirm and start import
- **Required outcomes:** Reliable unambiguous results can publish automatically; Ambiguous results require explicit confirmation; Confirmation error remains with the same import
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A multi-record chat export awaits confirmation; inspect samples, warnings, and attachment counts before confirming the same batch.
- **Source:** [apps/web/src/Imports.tsx:146–157](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L146-L157)

#### UF-IMPORT-DISPOSITIONS — See what happened to every input file

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 导入详情 → 文件解析情况
- **Historical units:** C10
- **Inputs:** No new input fields
- **Actions:** Expand file parsing outcomes
- **Required outcomes:** Parsed / processing / attachment / container / excluded / unsupported outcome per file; Reason and counts are preserved; Unsupported and excluded inputs are not silently counted as complete records
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A ZIP includes a document, image, unsupported binary, and excluded file; inspect which became records, attachments, pipeline inputs, or preserved originals.
- **Source:** [apps/web/src/Imports.tsx:147–148](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L147-L148)

#### UF-IMPORT-RECOVERY — Recover processing without losing archived originals

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 活动 / 导入详情
- **Historical units:** C10
- **Inputs:** No new input fields
- **Actions:** Cancel processing; Retry failed/cancelled/unsupported import; Open model settings when required; Continue same task
- **Required outcomes:** Queued / preparing / awaiting confirmation / importing / completed / failed / cancelled / needs configuration / unsupported are differentiated; Cancelling preserves archived originals and saved records; Still-stopping or still-finishing operations explain why retry/confirm is unavailable
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** After an import reaches model-required state, inspect its originals, configure the needed module, then return and continue that import rather than start an unrelated one.
- **Source:** [apps/web/src/Imports.tsx:15–20](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L15-L20); [apps/web/src/Imports.tsx:99–110](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L99-L110); [apps/web/src/Imports.tsx:149–158](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L149-L158)

#### UF-IMPORT-STAGES — Distinguish received originals, readable records, search, and memory

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 活动 / 导入详情
- **Historical units:** C10
- **Inputs:** No new input fields
- **Actions:** Inspect intake progress; Inspect per-media states; Open a record; Open memory progress
- **Required outcomes:** Original archive / parse preview / record publication / memory are separate; Processed, imported and duplicate counts remain meaningful; Media received does not imply searchable or remembered; Memory waiting-model/paused/cancelled/disabled/unavailable remain visible when applicable
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A completed audio import has failed transcription and disabled automatic memory; the UI must not show a single unqualified success state.
- **Source:** [apps/web/src/Imports.tsx:141–144](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L141-L144); [apps/web/src/Imports.tsx:159–170](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L159-L170)

#### UF-IMPORT-ORIGINALS — Reopen exactly the originals and records from an import

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 导入详情 → 已保留原件 / 已归档记录
- **Historical units:** C10
- **Inputs:** No new input fields
- **Actions:** Expand retained originals; Open/download an original; Open archived records
- **Required outcomes:** Original filenames, relative paths, count and bytes remain linked to the import; Published records are separately addressable
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Open an import with two similar filenames in different folders and verify the right original and its published record can be distinguished.
- **Source:** [apps/web/src/Imports.tsx:169–171](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L169-L171); [apps/web/src/ArchivedFileButton.tsx:1–18](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ArchivedFileButton.tsx#L1-L18)

#### UF-IMPORT-DELETE — Delete a whole import with a reviewable scope

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 导入详情 → 更多 → 删除这次导入
- **Historical units:** C11
- **Inputs:** No new input fields
- **Actions:** Request deletion; Read dependency/shared-content scope; Confirm / cancel
- **Required outcomes:** Irreversible removal scope includes unused materials/originals/dependent memory; Shared items still referenced elsewhere remain; Intake in progress disables deletion
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Delete one of two imports sharing an original; confirmation must state shared retained data and cannot pretend all identical content is erased.
- **Source:** [apps/web/src/Imports.tsx:109–111](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L109-L111); [apps/web/src/Imports.tsx:172–172](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Imports.tsx#L172-L172)

### F05 — 持续同步一个文件夹或文件

#### NAT-003 — Choose one-time file or continuous folder collection

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Add / File or folder
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Selected files or directory; Continuous updates toggle; Confirmed destination
- **Actions:** Open native chooser; Review selection; Confirm; Cancel
- **Required outcomes:** One-time versus continuous explicit; Unconnected source stays local; Permission only for selected range
- **Visible entry:** File/folder distinction, selected range, destination, consent visible before commit
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Select a folder offline, cancel once, then confirm; no network or broad file access before confirmation.
- **Source:** [apps/desktop/src/index.html:118–126](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L118-L126); [apps/desktop/src/ui.ts:643–664](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L643-L664); [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:146–178](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L146-L178); [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:247–318](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L247-L318)

#### NAT-004 — Choose supported file classes for a folder

- **Priority / platforms:** P1 / android
- **Canonical home:** Add / Folder
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Supported files; Audio files; Custom extensions
- **Actions:** Select preset; Edit extensions
- **Required outcomes:** Audio preset defaults to archive; Supported text/audio/image/document formats visible
- **Visible entry:** Preset visible in folder step; custom extensions disclosed
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Select audio preset then choose snapshot; original retention explanation must match the final choice.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:152–160](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L152-L160); [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:228–240](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L228-L240)

#### NAT-005 — Describe source format, time, author and ownership

- **Priority / platforms:** P0 / android
- **Canonical home:** Add / File or folder / Material description
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Optional source.description free text: background, author, content ownership, format, time
- **Actions:** Write description; Save; Edit existing description
- **Required outcomes:** Description saved for Agent context; Existing+future material uses changed context; No automatic retranscription or historical memory recomputation
- **Visible entry:** Description field discoverable before import, with semantic example; never just generic metadata badge
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Import call recordings with speaker attribution and timezone explanation; return to edit and verify the entire description persists.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:161–167](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L161-L167); [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:294–318](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L294-L318)

#### NAT-006 — Recover material-description acknowledgement and conflicts

- **Priority / platforms:** P0 / android
- **Canonical home:** Sources / File source settings
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Local description; Central description; Central context version
- **Actions:** Refresh context; Keep local description and save; Use Central description and save; Cancel
- **Required outcomes:** Pending context acknowledgment explicit; Conflict blocks affected files pending resolution; Draft kept on failure
- **Visible entry:** Conflict is inline at affected source with both values and concrete choice
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Edit source description offline, concurrently change Central description, reconnect and select which version to keep.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:243–245](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L243-L245); [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:322–363](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L322-L363); [apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt:75–79](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt#L75-L79)

#### NAT-007 — Recover a file-task draft

- **Priority / platforms:** P0 / android
- **Canonical home:** Add / File or folder
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Range; Description; Name; Advanced settings
- **Actions:** Leave and return; Restore draft; Retry save
- **Required outcomes:** Encrypted local draft preserves pending selection and fields; Draft removed only after successful save
- **Visible entry:** Draft and save failure visible inline
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Enter source attribution then rotate/reopen before saving; text and retention choices survive.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:91–126](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L91-L126); [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:294–318](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L294-L318)

#### NAT-008 — Choose source initial history

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Sources / Rules
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** All existing items; New items only after complete initial inventory
- **Actions:** Save initial scope
- **Required outcomes:** Baseline persists; One-time file import always imports selected file; Incomplete scan not treated as complete baseline
- **Visible entry:** Choice visible before folder confirmation
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Choose new-only and restart after partial scan; old entries must not silently become new imports.
- **Source:** [apps/desktop/src/index.html:124–128](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L124-L128); [apps/desktop/src/ui.ts:639–666](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L639-L666); [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:168–172](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L168-L172); [apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt:175–176](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt#L175-L176)

#### NAT-009 — Choose source retention and extracted-body availability

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Sources / Rules
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Snapshot / extracted content only; Archive original+content; Reference / file information only; Retain full extracted text for offline reads
- **Actions:** Choose mode; Confirm complete-file processing
- **Required outcomes:** Snapshot and archive upload full files for Central parsing; Snapshot temporary original removed after processing; Archive keeps original; Reference does not read body
- **Visible entry:** Retention choice and its original/body consequence visible at confirmation
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Choose reference and ensure no transcript or body is promised; switch to snapshot and show complete-file upload consequence.
- **Source:** [apps/desktop/src/index.html:124–128](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L124-L128); [apps/desktop/src/ui.ts:665–690](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L665-L690); [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:173–190](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L173-L190); [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:239–240](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L239-L240)

#### NAT-010 — Restrict source extension, size and path range

- **Priority / platforms:** P1 / macos, android
- **Canonical home:** Sources / Advanced rules
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Extension allowlist; Relative path exclusions; Scan interval; Android max file MiB 1–512; desktop maximum 512MiB
- **Actions:** Edit; Save; Inspect skipped count
- **Required outcomes:** Hidden items/symlinks excluded on Mac; Scoped scan result; Android wildcard exclusions are case-sensitive; Mac exact/prefix paths
- **Visible entry:** Named Advanced rules disclosure from the source; current limits summarized
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Exclude private subtree and oversized file; inspect skip reason without assuming deletion.
- **Source:** [apps/desktop/src/index.html:124–128](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L124-L128); [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:181–187](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L181-L187)

#### NAT-011 — Redact exact source text before upload

- **Priority / platforms:** P0 / macos
- **Canonical home:** Sources / Advanced rules
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Literal strings per line
- **Actions:** Save redaction rules
- **Required outcomes:** Text/calendar/coding content redacted; Nontext files with configured redaction not uploaded; File position URI not sent when redaction configured
- **Visible entry:** Progressive but labeled privacy option with exact effect
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Configure secret literal on mixed PDF+text source; preserve refusal state for unsupported redaction format.
- **Source:** [apps/desktop/src/index.html:125–128](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L125-L128); [apps/desktop/src/ui.ts:665–666](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L665-L666)

#### NAT-012 — Track source deletions conservatively

- **Priority / platforms:** P0 / macos
- **Canonical home:** Sources / Advanced rules
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Track deletions toggle
- **Actions:** Enable or disable; Save
- **Required outcomes:** Off by default; Only complete successful scan marks vanished entries; Central historical versions retained
- **Visible entry:** Progressive option with historical retention explanation
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Temporarily detach a directory or deny access; incomplete scan must not appear as confirmed deletion.
- **Source:** [apps/desktop/src/index.html:126–128](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L126-L128); [apps/desktop/src/ui.ts:680–682](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L680-L682)

#### NAT-013 — Manage each source without changing other sources

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Sources
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Selected source; Enabled state; Range and rules
- **Actions:** Edit; Pause; Resume; Check now; Android reauthorize or remove connection
- **Required outcomes:** Per-source pending/skipped/last scan and error state; Pause does not erase history; Android removal only removes local connection
- **Visible entry:** Name, scope, status, pause/resume visible; advanced rules disclosed
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Pause failed folder while calendar continues; remove connection without deleting Central history.
- **Source:** [apps/desktop/src/ui.ts:698–729](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L698-L729); [apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt:70–107](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt#L70-L107); [apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt:366–374](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileTaskActivity.kt#L366-L374)

### F06 — 记录屏幕、页面、应用活动、通知/媒体状态

#### UF-DEVICE-REPORTED-STATE — Inspect the latest collector report without remotely changing collection

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 来源 → 设备详情
- **Historical units:** C04
- **Inputs:** No new input fields
- **Actions:** Choose device; Inspect latest contact/capture/queue report; Expand device and media metadata; Open connection grants
- **Required outcomes:** Last report is not live capture truth; Real-time/scheduled/batch/manual strategy and relevant conditions; Pending upload, needs-attention, local OCR wait and retained-copy counts are distinct; Capture start/pause/privacy stay on device
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A device has not contacted Central because it uses manual sync; do not label it stopped or offer a Central screen-capture switch.
- **Source:** [apps/web/src/DeviceOverview.tsx:24–36](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/DeviceOverview.tsx#L24-L36)

#### NAT-001 — Start and pause collection explicitly

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Sources / Screen collection
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Saved collection scope
- **Actions:** Preview scope; Confirm start; Pause collection
- **Required outcomes:** Permission requested only when needed; Collection state and pause reason; Pausing collection does not pause queued upload
- **Visible entry:** Start/pause and current state visible; detailed scope before confirm
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Deny capture permission, save a file and note, verify both still work; start only after explicit confirmation.
- **Source:** [apps/desktop/src/index.html:70–83](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L70-L83); [apps/desktop/src/index.html:245–245](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L245-L245); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:1153–1204](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L1153-L1204)

#### NAT-018 — Choose page extraction mode and fallback

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Sources / Screen / Page collection
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Mac screen_only/hybrid/ui_preferred/page_only; Android screen_only/ui_preferred; Page rule JSON
- **Actions:** Choose mode; Save; Load experimental rules on Mac
- **Required outcomes:** Page extraction limited by app/page rules; Privacy rejection never triggers screenshot fallback; Projection supports screenshots only
- **Visible entry:** Mode selectable in page collection settings; fallback explained in user terms
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Selected page adapter fails privacy: no screenshot fallback; unmatched app version may fallback only inside allowed scope.
- **Source:** [apps/desktop/src/index.html:222–222](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L222-L222); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:880–893](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L880-L893)

#### NAT-019 — Configure article/product fields by installed app version

- **Priority / platforms:** P1 / android
- **Canonical home:** Sources / App privacy / Selected app
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Installed version; Article or product; Title/body/author/URL/itemId selectors; Activity/region/repeat scope
- **Actions:** Preview app format; Edit field mappings; Load matching builtin; Import matching rules; Save draft
- **Required outcomes:** Version isolation; Required title and article body validated; Config does not grant content permission; Config match not live verification
- **Visible entry:** Per-app configuration offers named field setup; JSON only advanced
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Import rule for a different app version; reject without widening authorized app scope.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:1823–1919](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L1823-L1919); [apps/android/app/src/main/java/dev/mote/collector/AppPageSetup.kt:6–48](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/AppPageSetup.kt#L6-L48)

#### NAT-020 — Preview the saved capture scope using generated content

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Sources / Screen / Preview
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Current saved or draft scope
- **Actions:** View preview; Confirm start; Cancel
- **Required outcomes:** Example is generated; No personal screen read; Scope and destination shown
- **Visible entry:** Preview and confirmation before start
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Preview and cancel; no permissions or screenshot collection initiated.
- **Source:** [apps/desktop/src/index.html:245–245](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L245-L245); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:870–875](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L870-L875)

#### NAT-025 — Choose optional device metadata

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Sources / Screen / Metadata
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Upload device and capture metadata toggle
- **Actions:** Save
- **Required outcomes:** Actual OS/model/language/timezone/battery/space fields; No prohibited identifiers listed in source; Affects future records only; File-source size/time metadata independent
- **Visible entry:** Toggle plus concise category description; expanded details permitted
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Turn metadata off after pending records exist; do not promise retroactive removal or removal of source file timestamps.
- **Source:** [apps/desktop/src/index.html:225–225](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L225-L225); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:877–878](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L877-L878)

#### NAT-026 — Collect notifications with app privacy

- **Priority / platforms:** P1 / macos, android
- **Canonical home:** Sources / Capture types
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Notification collection toggle
- **Actions:** Enable after permission; Disable
- **Required outcomes:** Mac only currently exposed Notification Center views and excluded/activity rules suspend; Android visible system notifications respect app mode
- **Visible entry:** Named capture type with permission/status
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Enable notifications then exclude app; no body should be represented as still allowed.
- **Source:** [apps/desktop/src/index.html:223–223](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L223-L223); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:675–678](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L675-L678)

#### NAT-027 — Collect device events independently

- **Priority / platforms:** P1 / android
- **Canonical home:** Sources / Capture types
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Screen on/off and lock/unlock toggle
- **Actions:** Enable; Disable
- **Required outcomes:** System event stream distinct from screenshots; Screen off is not asserted as locked
- **Visible entry:** Independent source toggle
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Disable screen capture but keep device events enabled; UI reflects distinct scope.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:675–678](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L675-L678)

#### NAT-028 — Collect exposed media playback states

- **Priority / platforms:** P1 / android
- **Canonical home:** Sources / Capture types
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Media toggle; App privacy; Power policy; Metadata requirement
- **Actions:** Grant notification access; Start/pause collector
- **Required outcomes:** No audio recording or playback control; Observed intervals only; Can continue after projection stops
- **Visible entry:** Media purpose and live status visible in its configuration
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Projection revoked while media active; show screen stopped and media state accurately, no all-or-nothing status.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:679–690](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L679-L690)

#### NAT-029 — Choose screenshot mechanism and renew projection consent

- **Priority / platforms:** P0 / android
- **Canonical home:** Sources / Capture
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Accessibility capture; Projection screenshot-only mode
- **Actions:** Request permission; Renew projection; Start/pause
- **Required outcomes:** Projection needs renewed consent after lock/kill; Android10 screenshot requires projection; Current session state actionable
- **Visible entry:** Current capture mechanism and reauthorization action visible
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Lock phone after projection consent; return must offer reauthorize rather than claim ongoing capture.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:683–694](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L683-L694); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:1196–1220](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L1196-L1220)

#### NAT-030 — Tune capture frequency, power and idle behavior

- **Priority / platforms:** P1 / macos, android
- **Canonical home:** Settings / Capture
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Sampling interval; Mac idle pause; Mac launch at login; Battery/charging collection pause; Low-battery threshold
- **Actions:** Choose presets/custom; Save
- **Required outcomes:** Startup remains stopped; Lock/sleep pauses Mac; Power pause reason shown
- **Visible entry:** Advanced tuning disclosed from capture summary
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Enable launch at login and restart: no implicit collection start; previously queued data follows upload policy.
- **Source:** [apps/desktop/src/index.html:211–212](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L211-L212); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:691–700](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L691-L700)

#### NAT-031 — Set screenshot quality and live deduplication

- **Priority / platforms:** P1 / macos, android
- **Canonical home:** Settings / Capture / Quality
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** JPEG quality; max edge; Dedupe off/exact/conservative/balanced/aggressive
- **Actions:** Choose preset/custom; Save
- **Required outcomes:** Same-app comparisons; Near duplicates can omit small changes; Repeated image may retain activity observation without text reuse
- **Visible entry:** Quality summary plus named advanced settings
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Select aggressive mode; explanation must not claim lossless capture or reused OCR for all repeats.
- **Source:** [apps/desktop/src/index.html:213–215](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L213-L215); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:711–722](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L711-L722)

#### NAT-032 — Compare compression with generated samples

- **Priority / platforms:** P2 / macos, android
- **Canonical home:** Settings / Capture / Compression preview
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** JPEG quality; max edge; Zoom
- **Actions:** Compare original/compressed; Zoom/pan; Bring parameters back; Save in settings
- **Required outcomes:** Measured dimensions and bytes; No screen capture/upload; Not applied until save
- **Visible entry:** Named preview route; applying parameters and saving are distinct
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Adjust quality then leave preview without settings save; actual capture configuration remains unchanged.
- **Source:** [apps/desktop/src/index.html:190–190](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L190-L190); [apps/android/app/src/main/java/dev/mote/collector/CompressionPreviewActivity.kt:42–67](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/CompressionPreviewActivity.kt#L42-L67); [apps/android/app/src/main/java/dev/mote/collector/CompressionPreviewActivity.kt:86–116](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/CompressionPreviewActivity.kt#L86-L116)

#### NAT-033 — Inspect and grant required system permissions

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Settings / Permissions
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Permission category
- **Actions:** Open system settings; Return to original task; Refresh status
- **Required outcomes:** Mac recording restart instruction; File access path-specific; Android accessibility/notifications/usage/projection separately shown
- **Visible entry:** Permission status and recovery action visible per blocked task
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Deny permission and return; stay in original task with scope intact and accurate missing permission state.
- **Source:** [apps/desktop/src/index.html:156–156](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L156-L156); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:966–1020](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L966-L1020)

#### NAT-034 — Configure Android background operation

- **Priority / platforms:** P1 / android
- **Canonical home:** Settings / Permissions and background
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Battery optimization; Autostart; Restricted settings
- **Actions:** Open relevant system setting; Return
- **Required outcomes:** User-controlled system authorization; No claim of OEM long-run validation
- **Visible entry:** Named background section; status caveats progressive
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** System disallows direct settings link; app retains task and gives fallback instead of losing setup.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:985–990](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L985-L990)

### F07 — 管理隐私和三个不同暂停范围

#### NAT-002 — Pause all sending independently

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Activity / Sending
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Current sending state
- **Actions:** Pause all sending; Resume sending; Send now
- **Required outcomes:** Local collection can continue; Source pause, capture pause and send pause are distinct
- **Visible entry:** Current sending state and one pause/resume control visible
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Pause sending while capture runs, then pause one source; resume sending must not enable that source.
- **Source:** [apps/desktop/src/index.html:63–67](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L63-L67); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:333–388](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L333-L388)

#### NAT-017 — Set default and per-app collection privacy

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Sources / Screen / App privacy
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Default content/activity/off; Installed app rule; Manual bundle/package ID
- **Actions:** Select app; Change mode; Remove rule; Save
- **Required outcomes:** Activity-only excludes body/title/screenshot; Excluded app produces no record; Unknown/mixed windows fail closed as documented
- **Visible entry:** Default scope and per-app list visible; manual identifiers progressive
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Configure future apps default-off, allow one app, verify unknown or overlay windows do not bypass scope.
- **Source:** [apps/desktop/src/index.html:220–220](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L220-L220); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:842–861](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L842-L861); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:1804–1875](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L1804-L1875)

#### NAT-021 — Apply fixed screen masks before privacy review and storage

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Sources / Screen / Masks
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Preset regions; Custom rectangles; Normalized coordinates
- **Actions:** Add; Resize/move; Remove; Preview; Save
- **Required outcomes:** Generated screen schematic; Masks applied before OCR and persistence; Coordinate convention platform-specific
- **Visible entry:** Visual mask editor primary; raw coordinates disclosed
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Drag a mask then switch to numeric editing; both representations must agree and preserve values on save.
- **Source:** [apps/desktop/src/index.html:224–224](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L224-L224); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:895–910](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L895-L910)

#### NAT-022 — Configure exact text privacy gate and uncertain outcomes

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Sources / Screen / Privacy review
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Enabled; Forbidden exact text; Failure action hold/drop/allow
- **Actions:** Save rules; Open held records
- **Required outcomes:** Exact matches discarded; Failure policy only for incomplete review; Changing policy does not release held records
- **Visible entry:** Rule and failure mode discoverable; held count links to explicit review
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Set allow after a record is held; old held record stays held until individually released.
- **Source:** [apps/desktop/src/index.html:221–221](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L221-L221); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:911–932](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L911-L932)

#### NAT-023 — Review held records individually

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Activity / Needs attention / Held record
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Specific held record
- **Actions:** Inspect record; Explicitly release or discard where implemented; Retry
- **Required outcomes:** Release is record-specific; Existing queue policy preserved; Error keeps original
- **Visible entry:** Attention state links directly to held item and next action
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Network fails after release request; item remains visible with retry state, not false received status.
- **Source:** [apps/desktop/src/index.html:221–221](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L221-L221); [apps/desktop/src/ui.ts:1113–1115](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L1113-L1115); [apps/android/app/src/main/java/dev/mote/collector/SyncRecoveryActivity.kt:90–108](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/SyncRecoveryActivity.kt#L90-L108)

#### NAT-024 — Select on-device OCR used only for privacy review

- **Priority / platforms:** P1 / android
- **Canonical home:** Screen / Advanced privacy review
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Chinese+Latin single engine; Latin; Dual; Per-app engine JSON
- **Actions:** Select; Save
- **Required outcomes:** Runs only when screenshot text rules need it; OCR result not saved or uploaded; Full recognition performed by Central
- **Visible entry:** Named advanced privacy option; not represented as Central model setup
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Choose per-app latin engine, disable privacy gate; UI must not imply a searchable local OCR archive.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:920–932](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L920-L932)

#### NAT-039 — Select shared upload schedule

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Settings / Upload and sync
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Real-time; Scheduled; Batch; Manual; Interval; max batch; Packed upload; Android JSONL window
- **Actions:** Choose; Save; Send now
- **Required outcomes:** All local capture/notes/sources share strategy; Manual does not auto-send; Sleep/OS scheduling may delay; ACK before local cleanup
- **Visible entry:** Mode primary; only applicable numeric controls disclosed
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Choose manual, save note and add source; neither uploads until send-now; batch size hidden when irrelevant.
- **Source:** [apps/desktop/src/index.html:202–208](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L202-L208); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:652–663](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L652-L663)

#### NAT-040 — Set upload network and power conditions

- **Priority / platforms:** P0 / android
- **Canonical home:** Settings / Advanced sync
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Unmetered Wi-Fi only; Charging only; Pause on system-low battery
- **Actions:** Save; Send now; Reupload
- **Required outcomes:** Manual and reupload still obey selected conditions; Waiting reason visible
- **Visible entry:** Named conditions and active waiting reason
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Tap send-now on mobile data with Wi-Fi-only enabled; show waiting for allowed network, not failed/lost data.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:664–668](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L664-L668)

#### NAT-041 — Inspect pending upload queue

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Activity / Upload queue
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Source filter; Status/outcome filter; Pagination
- **Actions:** Open record; Refresh; Inspect source queue; Send now
- **Required outcomes:** Pending versus received explicit; Speed and waiting reason; Unreadable queue not rendered as zero
- **Visible entry:** Queue count/state summary visible; record details progressive
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** One corrupt/unreadable queue entry causes error, not empty queue success.
- **Source:** [apps/desktop/src/index.html:86–96](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L86-L96); [apps/android/app/src/main/java/dev/mote/collector/SyncQueueActivity.kt:24–88](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/SyncQueueActivity.kt#L24-L88)

#### NAT-042 — Inspect upload receipts and actual uploaded content

- **Priority / platforms:** P0 / macos
- **Canonical home:** Activity / Sending details
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Today/seven days; End date; Source/outcome filters
- **Actions:** Open daily history; Open receipt; Browse uploaded items; Preview content; Back to receipt
- **Required outcomes:** Deduplicated ACK count; Actual request bytes include retries; Received does not imply parsed/searchable
- **Visible entry:** Summary compact; source receipt/content drilldown reachable
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Receipt says received while OCR queued; content detail must preserve separate processing state.
- **Source:** [apps/desktop/src/index.html:86–96](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L86-L96); [apps/desktop/src/index.html:249–250](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L249-L250)

#### NAT-043 — Check both ends and reupload retained local records

- **Priority / platforms:** P0 / android
- **Canonical home:** Activity / Sync recovery
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Check-only versus full resend; Retained local records
- **Actions:** Check server visibility; Confirm full resend; Stop; Open conflict
- **Required outcomes:** Check visibility is not ACK; No resend of cleaned originals; No restore/overwrite of Central-deleted/conflicting items; Paused source stays paused
- **Visible entry:** Purpose and confirmation visible before full resend
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Central has deleted item; reupload must keep local copy with conflict and not resurrect it.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/SyncRecoveryActivity.kt:31–50](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/SyncRecoveryActivity.kt#L31-L50)

#### NAT-044 — Resolve source or record conflicts without blocking unrelated sync

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Activity / Needs attention
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Conflict/rejection item
- **Actions:** Inspect local copy; Retry eligible conflict; Reauthorize source; Resume after fix
- **Required outcomes:** 409 conflict /410 deleted reasons; Original preserved; Other items continue
- **Visible entry:** Affected row shows reason and recovery; no blanket global success
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** One file conflicts and another uploads: show separate outcomes and retain conflicted original.
- **Source:** [apps/desktop/src/ui.ts:714–718](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L714-L718); [apps/android/app/src/main/java/dev/mote/collector/SyncRecoveryActivity.kt:90–108](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/SyncRecoveryActivity.kt#L90-L108); [apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt:75–87](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt#L75-L87)

### F08 — 浏览完整资料、原始记录、文件/录音，并核对来源

#### UF-LIBRARY-FILTERS — Find published material by meaningful scope

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 → 全部资料
- **Historical units:** C14
- **Inputs:** Source; Device; Start/end date; Content type
- **Actions:** Filter; Clear filters; Refresh; Page through results; Select material
- **Required outcomes:** Empty archive, no matches, loading and invalid dates are distinct; Published body remains readable while other products process
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Filter a date with no results, clear it, find a partially processed material, and read available text without waiting for memory.
- **Source:** [apps/web/src/LibraryBrowse.tsx:84–138](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/LibraryBrowse.tsx#L84-L138); [apps/web/src/Archive.tsx:33–66](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Archive.tsx#L33-L66)

#### UF-MATERIAL-BODY-REVISION — Read complete available text and know which revision it belongs to

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 → 资料详情 → 正文
- **Historical units:** C15
- **Inputs:** No new input fields
- **Actions:** Continue body pagination; Return to first page; Open current revision from history; Retry reads
- **Required outcomes:** Text is pinned to selected revision; Current vs historical revision is explicit; Source-changed/rebuilding state is explicit; Partial body is not represented as full coverage
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Open a long historical material, continue beyond the first 4,000 characters, then compare its current revision without mixing the two bodies.
- **Source:** [apps/web/src/Materials.tsx:63–120](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Materials.tsx#L63-L120)

#### UF-MATERIAL-PROVENANCE — Inspect the source, origin and processing evidence behind a material

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 → 资料详情 → 来源与处理
- **Historical units:** C15, A11
- **Inputs:** No new input fields
- **Actions:** Open source/processing tab; Manage source; Open related activity; Open original member records; Page source members
- **Required outcomes:** Source identity, original retention, coverage and reason; Artifact-by-artifact status; Current/history identity and original links remain distinct
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A material has partial coverage and three originating records; inspect all members and do not call the missing portion already read.
- **Source:** [apps/web/src/Materials.tsx:115–120](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Materials.tsx#L115-L120); [apps/web/src/SourceDocumentDetails.tsx:7–14](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/SourceDocumentDetails.tsx#L7-L14)

#### UF-MATERIAL-ATTRIBUTION — Correct a single material’s relationship without relabeling the whole source

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 → 资料详情 → 内容归属
- **Historical units:** C16
- **Inputs:** Owner / third-party / mixed / unknown / follow source
- **Actions:** Inspect effective attribution and its basis; Save a material correction
- **Required outcomes:** Material override > source declaration > connector/default; Saved revision identity is respected; Historical material cannot masquerade as current editable content
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Source is owner-authored but one imported document is a third-party article; override only that material and inspect attribution basis/version.
- **Source:** [apps/web/src/AttributionContext.tsx:6–18](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/AttributionContext.tsx#L6-L18); [apps/web/src/Materials.tsx:111–120](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Materials.tsx#L111-L120); [packages/shared/src/material-context.ts:16–31](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/packages/shared/src/material-context.ts#L16-L31)

#### UF-MATERIAL-INDEX-RECOVERY — Recover search indexing while retaining readable material

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 → 资料详情 → 处理状态
- **Historical units:** C15
- **Inputs:** No new input fields
- **Actions:** Inspect index state; Retry only failed index
- **Required outcomes:** Published body and search-index state are separate; Index retry appears only for current eligible material; Failure is local and visible
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** An index fails after body publication; continue reading and retry index without reimporting or retranscribing the original.
- **Source:** [apps/web/src/Materials.tsx:97–113](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Materials.tsx#L97-L113)

#### UF-MATERIAL-EXACT-MEMORY — Start memory extraction from the exact current material

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料详情 → 提取记忆
- **Historical units:** C16
- **Inputs:** No new input fields
- **Actions:** Choose this material as input; Open extraction task
- **Required outcomes:** Ready/waiting/unavailable/too-large eligibility; Pinned evidence selection; Time-range extraction is not silently substituted
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Select one material from a broad time range; extraction confirms only its evidence, and a stale revision asks for reselection.
- **Source:** [apps/web/src/Materials.tsx:92–113](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Materials.tsx#L92-L113); [apps/web/src/Memories.tsx:111–121](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Memories.tsx#L111-L121); [apps/web/src/Memories.tsx:166–171](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Memories.tsx#L166-L171)

#### UF-ORIGINAL-RECORDS — Browse original captured evidence with filters

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 → 原始记录
- **Historical units:** C17
- **Inputs:** Day / date range; Device; Source; Content vs activity-only; OCR state; Thumbnail or list
- **Actions:** Previous/next day; Clear filters; Page results; Open record
- **Required outcomes:** Browser timezone labeling; Actual synchronized records; Loading/empty/read failure; Privacy labels and OCR readiness remain separate
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Find an activity-only capture with no image beside an OCR-pending screenshot and identify what content was actually collected.
- **Source:** [apps/web/src/Archive.tsx:189–198](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Archive.tsx#L189-L198); [apps/web/src/Archive.tsx:202–269](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Archive.tsx#L202-L269); [apps/web/src/LibraryBrowse.tsx:65–80](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/LibraryBrowse.tsx#L65-L80)

#### UF-ORIGINAL-METADATA — Read original evidence and time/role/provenance faithfully

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料详情 → 原始资料与元数据
- **Historical units:** C17, A11
- **Inputs:** No new input fields
- **Actions:** Expand original metadata; Open attachments/original file; Inspect record time vs event time; Inspect content role and original path
- **Required outcomes:** Authored / transcript / summary / reference / other roles; Recorded/occurred/observed times are not interchangeable; Metadata can retain provider title/subject/author without fabricated dedicated fields; Snapshot/reference/original/derived layers remain distinct
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** An email quoted in a meeting transcript has a provider subject and a different observed date; verify provenance and authored/event dates are not replaced by import time.
- **Source:** [apps/web/src/SourceDocumentDetails.tsx:7–14](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/SourceDocumentDetails.tsx#L7-L14); [packages/shared/src/sources.ts:100–145](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/packages/shared/src/sources.ts#L100-L145); [apps/web/src/Sources.tsx:81–83](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Sources.tsx#L81-L83)

#### UF-ORIGINAL-DELETE — Delete one original record with explicit scope

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 原始记录 → 完整详情 → 删除
- **Historical units:** C18
- **Inputs:** No new input fields
- **Actions:** Open full detail; Request deletion; Confirm / cancel
- **Required outcomes:** Deletion confirmation is separate from closing detail; Remaining history and invalidated evidence are not falsely presented as available
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Open a record from an answer citation, request deletion, cancel, then inspect the same original still present.
- **Source:** [apps/web/src/shell-components.tsx:509–547](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/shell-components.tsx#L509-L547)

#### UF-SOURCE-VERSIONS — Inspect source versions and distinguish a reference from archived text

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 → 来源资料
- **Historical units:** A11
- **Inputs:** Source filter
- **Actions:** Expand evidence; View versions; Inspect original URI
- **Required outcomes:** Current, historical, source-reported-deleted states; External reference stores title/location/time but no body; Calendar schedule is not proof of attendance
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A referenced NAS file is unavailable; show its location and no-body state without offering an invented remote read.
- **Source:** [apps/web/src/Sources.tsx:79–83](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Sources.tsx#L79-L83); [apps/web/src/Sources.tsx:141–156](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Sources.tsx#L141-L156)

#### UF-CAPTURE-GROUPS — Revisit screenshot sessions or application albums

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 → 片段
- **Historical units:** C19, A12
- **Inputs:** Date; Device; Session or app/15-minute grouping
- **Actions:** Open group; Return to groups; Page; Open record
- **Required outcomes:** Grouping rules and observed range; Preview failure fallback; Group duration is not asserted as continuous use
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Two same-app screenshot groups have a long gap; inspect grouping and avoid treating it as continuous focus time.
- **Source:** [apps/web/src/CaptureSessions.tsx:18–37](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/CaptureSessions.tsx#L18-L37)

#### UF-ACTIVITY-TIME — Read measured application activity without overstating attention

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 → 应用活动
- **Historical units:** C19, A13
- **Inputs:** No new input fields
- **Actions:** View application sampled durations and distribution
- **Required outcomes:** Devices accumulate separately; Unobserved time is not filled; Sampled activity is not attention or work output
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Two devices report overlapping foreground samples; read the explanation rather than interpreting their sum as unique work hours.
- **Source:** [apps/web/src/Archive.tsx:10–18](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Archive.tsx#L10-L18)

#### UF-MEDIA-OBSERVATIONS — Inspect media playback observations and their limits

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 → 媒体播放
- **Historical units:** C19, A14
- **Inputs:** Device/time scope
- **Actions:** Open media observation; View distribution; Open supporting record
- **Required outcomes:** App/state/title/author/album/progress when collected; Content-private mode omits titles; Lock/foreground/local-vs-remote unknown states; Playback samples are not total listening duration or captured audio
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A remote player reports paused media while the device is locked; the UI must not claim audio was recorded or that the track was fully listened to.
- **Source:** [apps/web/src/Media.tsx:13–59](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Media.tsx#L13-L59)

#### UF-FILES-FIND-ORIGINAL — Find a file or recording and access its retained original

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 资料库 → 文件与录音
- **Historical units:** C37
- **Inputs:** Filename/directory query; Source; Format
- **Actions:** Search/refresh; Load more; Open image; Fit width / original size; Play audio; Download original
- **Required outcomes:** Original-source disappearance does not erase archived copy; Unsupported browser codec offers download; Original, body and derived products remain distinct
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** The phone deleted an archived audio file and browser playback fails; download its Central original and inspect processing separately.
- **Source:** [apps/web/src/Files.tsx:24–35](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Files.tsx#L24-L35); [apps/web/src/Files.tsx:115–132](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Files.tsx#L115-L132)

#### UF-FILES-PROCESSING-STAGES — Identify which processing step is incomplete

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件详情 → 处理状态
- **Historical units:** C37
- **Inputs:** No new input fields
- **Actions:** Inspect original/body/summary states; Inspect selected strategy and match reason; Inspect extraction, diarization, alignment and semantic grouping attempts
- **Required outcomes:** Skipped/waiting/running/succeeded/blocked/failed/cancelled; Missing runtime/model/service, archive-only and stale temporary input have distinct reasons; Original transcription is retained when later steps fail
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Transcription succeeds but diarization fails; read the existing transcript and retry the failed step without treating all content as lost.
- **Source:** [apps/web/src/Files.tsx:18–20](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Files.tsx#L18-L20); [apps/web/src/Files.tsx:122–132](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Files.tsx#L122-L132)

#### UF-FILES-RECOVERY — Retry or cancel the correct file-processing step

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件详情 → 处理操作
- **Historical units:** C37
- **Inputs:** Current file; Supported processing action
- **Actions:** Cancel processing; Retry extraction; Regenerate summary; Redo speaker separation while keeping transcript; Refresh; Retry identical unknown submission
- **Required outcomes:** Uncertain external outcome may need explicit duplicate-risk confirmation; Still-running call is not retryable; Cancel retains originals and saved products; Removing local pending submit does not cancel Central task
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Lose the response after submitting a retry; use the same operation receipt, show uncertainty, and avoid silently launching another independent extraction.
- **Source:** [apps/web/src/FileProcessingControls.tsx:21–83](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileProcessingControls.tsx#L21-L83)

#### UF-FILES-SPEAKER-CONFIG — Redo this file’s speaker separation without changing global defaults

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件详情 → 单文件分人设置
- **Historical units:** C37, A24
- **Inputs:** Speaker model; Unknown / exact count / known range; Exact count or min/max speakers
- **Actions:** Apply and redo separation
- **Required outcomes:** Only this file changes; Raw transcript reused; Anonymous grouping does not infer identity
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Set a known two-to-four-person range for one recording; global strategy and another file remain unchanged.
- **Source:** [apps/web/src/FileProcessingControls.tsx:84–85](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileProcessingControls.tsx#L84-L85)

#### UF-FILES-MANUAL-CORRECTION — Correct transcript text while preserving the source

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件详情 → 文段
- **Historical units:** A24
- **Inputs:** Corrected text for selected segment
- **Actions:** Edit segment; Save correction; Cancel
- **Required outcomes:** No model call for manual correction; Original file and raw transcription retained; Correction has a distinct lineage
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Correct a proper name in one segment, cancel another edit, then reopen and distinguish corrected text from raw transcription.
- **Source:** [apps/web/src/Files.tsx:40–51](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Files.tsx#L40-L51)

#### UF-FILES-SPEAKER-NAME — Listen before assigning a speaker name

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件详情 → 说话人试听与命名
- **Historical units:** A24
- **Inputs:** Human-confirmed name per anonymous speaker
- **Actions:** Play speaker sample; Confirm name
- **Required outcomes:** Anonymous acoustic label and confirmed name remain distinct; Uncertain/overlapping audio is marked; Acoustic score is not identity probability
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Listen to an overlapping speaker segment and leave an unknown speaker unnamed; do not show model-inferred identity as confirmed.
- **Source:** [apps/web/src/FileReview.tsx:27–50](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileReview.tsx#L27-L50); [apps/web/src/FileReview.tsx:67–69](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileReview.tsx#L67-L69)

#### UF-FILES-MODEL-REVIEW — Review model-proposed session links or terminology corrections

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件详情 → 场次关联与术语复核
- **Historical units:** A24
- **Inputs:** Selected proposed replacements / calendar session
- **Actions:** Request session match; Check recognition errors; Accept selected suggestions; Reject; Check next batch
- **Required outcomes:** Suggestions do not overwrite raw transcript automatically; Stale-original state invalidates old suggestions; Pending/confirmed/ignored outcomes remain inspectable
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Generate corrections, let the raw text change, then inspect stale suggestions; acceptance must not blindly apply them to the new revision.
- **Source:** [apps/web/src/FileReview.tsx:69–71](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileReview.tsx#L69-L71)

#### UF-FILES-EXPORT — Export retained file evidence and interpretation

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件与录音 → 导出
- **Historical units:** A24
- **Inputs:** File type; Current versions / retained history; Metadata-only or files+attachments
- **Actions:** Export transcript/speakers/image results; Export selected file archive; Cancel
- **Required outcomes:** Metadata-only does not imply file bytes; History is limited to authorized retained versions; Operation receipt and archive validation errors are visible
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Export metadata for retained historical recordings and verify it is not described as a full audio backup.
- **Source:** [apps/web/src/FilesExport.tsx:5–16](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FilesExport.tsx#L5-L16); [apps/web/src/FileReview.tsx:21–24](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileReview.tsx#L21-L24); [apps/web/src/FileReview.tsx:67–67](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileReview.tsx#L67-L67)

#### UF-FILES-FORGETTING — Delete a Central file archive and control recollection

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 文件详情 → 删除中央归档
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** No new input fields
- **Actions:** Review scope; Confirm delete; Retry same delete submission; Allow recollection after deletion
- **Required outcomes:** Device original retained; Central original/products removed according to receipt; Recollection blocked until explicitly allowed; Pending cleanup/unknown outcome is not full deletion success
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Delete an archived collector file while a task is still active; show pending cleanup and retained device original, then explicitly permit recollection.
- **Source:** [apps/web/src/FileForgetting.tsx:12–48](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileForgetting.tsx#L12-L48)

#### NAT-045 — Browse local versus Central content with provenance

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Library
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Local/all/received scope; Record kind/date; Grouping; List/thumbnail
- **Actions:** Open item; Refresh; Load more; Return to group
- **Required outcomes:** Local versus Central distinction; Content source and state; Empty/loading/failed thumbnail states
- **Visible entry:** Content list primary; view options disclosed
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Switch local to Central while signed out; retain browse context and offer account sign-in instead of empty archive.
- **Source:** [apps/desktop/src/index.html:98–106](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L98-L106); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:465–521](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L465-L521); [apps/android/app/src/main/java/dev/mote/collector/CaptureRecordsActivity.kt:77–156](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/CaptureRecordsActivity.kt#L77-L156); [apps/android/app/src/main/java/dev/mote/collector/CaptureRecordsActivity.kt:278–328](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/CaptureRecordsActivity.kt#L278-L328)

#### NAT-046 — Read complete content, original and processing state

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Library / Item detail
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Selected record/file version
- **Actions:** Read next text page; Return to start; View original image; View metadata; Refresh; Open Central; Export local full original on Android
- **Required outcomes:** Exact source/record provenance; Original availability separately shown; Reception and processing stages separated; Truncated text range labeled
- **Visible entry:** Body primary; original/provenance/stages progressive; availability label remains visible
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Open a large pending file offline: paginate available body or export local original; do not label it Central-searchable.
- **Source:** [apps/desktop/src/index.html:247–247](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L247-L247); [apps/desktop/src/content-library-ui.ts:28–86](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/content-library-ui.ts#L28-L86); [apps/android/app/src/main/java/dev/mote/collector/FileContentActivity.kt:142–177](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/FileContentActivity.kt#L142-L177); [apps/android/app/src/main/java/dev/mote/collector/CaptureRecordsActivity.kt:451–512](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/CaptureRecordsActivity.kt#L451-L512)

### F09 — 根据资料提问，查看依据和历史

#### UF-ASK-COMPOSE — Ask about archived context in a new or continuing conversation

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 问一问
- **Historical units:** C20
- **Inputs:** Question; Per-request provider/model selection
- **Actions:** New conversation; Send; Continue conversation
- **Required outcomes:** Model readiness shown; Readonly query with source citations; Submitted question preserved during work; Enter send / Shift+Enter newline
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Compose a follow-up, switch its model for this request, and ensure the current conversation identity survives submission.
- **Source:** [apps/web/src/Ask.tsx:16–22](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Ask.tsx#L16-L22); [apps/web/src/Conversations.tsx:172–205](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Conversations.tsx#L172-L205); [apps/web/src/Conversations.tsx:238–271](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Conversations.tsx#L238-L271)

#### UF-ASK-IMAGES — Submit supported images with a question

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 问一问 → 输入区
- **Historical units:** C22
- **Inputs:** Up to 4 PNG/JPEG/WebP images, 8 MiB each
- **Actions:** Choose; Remove; Send with question
- **Required outcomes:** Validation and upload state; Per-turn attachment identity; No unsupported format silently accepted
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Attach five images including an oversized one, correct selection, then send only the accepted attachments.
- **Source:** [apps/web/src/Conversations.tsx:207–231](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Conversations.tsx#L207-L231); [apps/web/src/Conversations.tsx:267–269](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Conversations.tsx#L267-L269)

#### UF-ASK-RUN-RECOVERY — Recover a long or failed question without losing the conversation

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 问一问 → 当前对话
- **Historical units:** C20
- **Inputs:** No new input fields
- **Actions:** Stop generation; Reconnect/refresh progress; Retry failed turn; Return to running conversation
- **Required outcomes:** Running vs stopped vs failed; Server may continue during progress disconnect; Unknown submission reuses admission ID; Deleted run is distinguished from loading
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Lose the submit response and then reconnect; the pending question and exact run remain inspectable rather than creating duplicate answers.
- **Source:** [apps/web/src/Conversations.tsx:119–152](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Conversations.tsx#L119-L152); [apps/web/src/Conversations.tsx:178–205](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Conversations.tsx#L178-L205); [apps/web/src/Conversations.tsx:258–262](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Conversations.tsx#L258-L262)

#### UF-ASK-EVIDENCE-HISTORY — Return to past answers and their original evidence

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 问一问 → 对话历史
- **Historical units:** C21
- **Inputs:** No new input fields
- **Actions:** Open history; Load older conversations/turns; Open citation; Return to same answer; Inspect usage and trace
- **Required outcomes:** Answer stored on Central; History version and evidence-deleted states; Missing source is not reconstructed as if still present
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Open a historical answer with a deleted source and a still-valid citation, inspect both, then return without losing the selected conversation.
- **Source:** [apps/web/src/Conversations.tsx:154–170](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Conversations.tsx#L154-L170); [apps/web/src/Conversations.tsx:238–260](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Conversations.tsx#L238-L260); [apps/web/src/ReferenceDetail.tsx:12–28](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ReferenceDetail.tsx#L12-L28)

#### UF-ASK-DELETE — Delete an entire conversation with clear scope

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 问一问 → 对话历史 → 更多
- **Historical units:** C21
- **Inputs:** No new input fields
- **Actions:** Request deletion; Confirm / cancel
- **Required outcomes:** All turns are included in the stated scope; Confirmation does not silently remove source archive
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Cancel a conversation deletion, reopen its older turns, then confirm deletion only after reading the full-conversation scope.
- **Source:** [apps/web/src/Conversations.tsx:250–252](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Conversations.tsx#L250-L252)

### F10 — 看后台正在做什么，处理失败或等待确认

#### UF-WORK-LIST — Find background work that needs attention

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 活动
- **Historical units:** C28
- **Inputs:** Active / needs-attention / recently-completed filter; Source/material-related scope
- **Actions:** Refresh; Open work; Page; Return to list; Clear related scope
- **Required outcomes:** Work goal, stage, progress and next action; Empty vs not-linked vs failed-loading states; Connection interruption auto-reconnect does not mean job stopped
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A source has an unlinked older import plus a linked current failure; understand the limited related-activity scope and find all work.
- **Source:** [apps/web/src/Activity.tsx:57–75](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Activity.tsx#L57-L75)

#### UF-WORK-DETAIL — Inspect work branches, saved results, and evidence

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 活动 → 工作详情
- **Historical units:** C28
- **Inputs:** No new input fields
- **Actions:** Open branch; Page branches; Open saved artifact; Open evidence; Open actual Agent read; Open relevant task owner
- **Required outcomes:** Actual branch status, events, result count and evidence count; No saved artifact shown before confirmation; Technical records remain a secondary detail
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A work item has one completed branch and one waiting-input branch; inspect its saved result without presenting the whole work as complete.
- **Source:** [apps/web/src/Activity.tsx:27–46](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Activity.tsx#L27-L46); [apps/web/src/WorkProgress.tsx:4–8](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/WorkProgress.tsx#L4-L8)

#### UF-WORK-CAUSE-RECOVERY — Act on a specific blocking reason and return to the original task

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 活动 → 需要处理
- **Historical units:** C28, A25
- **Inputs:** No new input fields
- **Actions:** Read reason; Open needed provider/module/image/file settings; Answer related question; Reload cause
- **Required outcomes:** Archive/body/index/memory differ; Only inspected execution records support the shown diagnosis; Unresolved cause is honest; Model settings navigation retains original task context
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A failed file analysis uses a valid provider but missing module assignment; reach the correct module setting and return to that file task.
- **Source:** [apps/web/src/WorkIssueNotice.tsx:31–44](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/WorkIssueNotice.tsx#L31-L44)

#### UF-WORK-TECHNICAL-STEPS — Diagnose and recover an eligible technical step

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 活动 → 高级 → 技术执行记录
- **Historical units:** A25
- **Inputs:** Status; Task kind
- **Actions:** Open operation; Inspect dependencies/attempts/next runnable time; Page steps; Retry only eligible index/context step; Cancel task
- **Required outcomes:** Actual supported controls only; Completed products are retained; Unknown external result is distinguished from failure
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** One optional step fails while required body publication succeeded; retry that step without resetting unrelated completed work.
- **Source:** [apps/web/src/Processing.tsx:27–67](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Processing.tsx#L27-L67); [apps/web/src/WorkflowProcessing.tsx:21–34](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/WorkflowProcessing.tsx#L21-L34)

### F11 — 配置必要模型，随后继续原任务

#### UF-MODEL-PROVIDER — Configure a reusable model connection

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 设置 → 模型与服务 → 模型连接
- **Historical units:** C31
- **Inputs:** Preset name; Provider type; Protocol; Base URL; Default model; Available model catalogue/manual ID
- **Actions:** Create preset; Refresh model list; Save and apply
- **Required outcomes:** Personal vs shared/deployment read-only preset; Catalogue visibility is not proof of tool compatibility; Configured and unconfigured states are distinct
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Choose a local provider whose model catalogue is unavailable; enter the actual model ID manually and save without presenting the catalogue failure as successful validation.
- **Source:** [apps/web/src/ScopedModelsForm.tsx:16–42](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedModelsForm.tsx#L16-L42); [apps/web/src/ScopedModelFields.tsx:31–36](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedModelFields.tsx#L31-L36); [apps/web/src/ScopedModelTools.tsx:45–48](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedModelTools.tsx#L45-L48)

#### UF-MODEL-CREDENTIALS — Update hidden credentials deliberately

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 模型连接 → 凭据 / 高级
- **Historical units:** C31, A19
- **Inputs:** Keep / replace / clear API key; Keep / replace / clear headers JSON; Keep / replace / clear advanced parameters JSON; Allow credential reuse at changed destination
- **Actions:** Save desired credential operations; Confirm changed-host reuse when applicable
- **Required outcomes:** Secrets do not echo; Changed endpoint cannot silently reuse retained secrets; Save clears raw credential entry; Invalid JSON remains an inline error
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Change a provider hostname while retaining its hidden key; explicitly replace/clear/approve reuse instead of silently sending to the new address.
- **Source:** [apps/web/src/ScopedModelFields.tsx:44–57](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedModelFields.tsx#L44-L57); [apps/web/src/ScopedConfiguration.tsx:46–59](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedConfiguration.tsx#L46-L59)

#### UF-MODEL-PERFORMANCE — Choose supported generation behavior

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 模型连接 → 高级设置
- **Historical units:** A19
- **Inputs:** Reasoning strength; Standard/Fast when supported; Single request timeout; Agent total timeout; Output token budget; Local unauthenticated loopback option
- **Actions:** Edit supported values; Save
- **Required outcomes:** Unsupported model capability is shown; Queue wait not counted as execution timeout; Codex-managed request/output options are not falsely editable; Output budget is not fixed response length
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Choose a Codex model without Fast support and verify the unavailable setting is handled honestly rather than saved as effective.
- **Source:** [apps/web/src/ScopedModelFields.tsx:36–44](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedModelFields.tsx#L36-L44); [apps/web/src/ModelSettingsEditor.tsx:238–260](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ModelSettingsEditor.tsx#L238-L260)

#### UF-MODEL-TEST-DRAFT — Test a model draft without confusing test with save

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 模型连接 → 测试 / 保存
- **Historical units:** C31
- **Inputs:** No new input fields
- **Actions:** Test connection; Restore/reload draft; Save and apply; Inspect current effective values
- **Required outcomes:** Test uses synthetic input and does not save draft; Success/failure/duration; Unsaved vs saved/effective/restart-required state; CAS conflict retains draft until explicit reload
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Test an edited connection successfully then leave without saving; effective settings must remain the saved version and the unsaved state must be clear.
- **Source:** [apps/web/src/ScopedModelTools.tsx:18–48](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedModelTools.tsx#L18-L48); [apps/web/src/ScopedConfiguration.tsx:34–78](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedConfiguration.tsx#L34-L78); [apps/web/src/ModelSettingsEditor.tsx:266–285](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ModelSettingsEditor.tsx#L266-L285)

#### UF-MODEL-ASSIGNMENTS — Assign the intended model to each feature

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 设置 → 模型与服务 → 模块与模型
- **Historical units:** C32
- **Inputs:** Module; Provider preset; Follow default or specific model ID
- **Actions:** Choose module model; Save assignment
- **Required outcomes:** Per-request model overrides module defaults; Explicit file processor/local constraints take precedence; Missing assignment links back to same blocked task
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A working Chat model does not imply Import or Memory is configured; assign the missing module then continue the same blocked import.
- **Source:** [apps/web/src/ScopedModelsForm.tsx:23–42](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedModelsForm.tsx#L23-L42); [apps/web/src/ModelAssignments.tsx:26–69](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ModelAssignments.tsx#L26-L69); [apps/web/src/ModelStartGuide.tsx:1–17](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ModelStartGuide.tsx#L1-L17)

#### UF-MODEL-COPY-DELETE — Manage independent provider presets

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 模型连接 → 预设管理
- **Historical units:** A20
- **Inputs:** Copy name; Whether to copy hidden credentials/advanced parameters
- **Actions:** Copy; Delete unused preset after confirmation
- **Required outcomes:** Copy independent from original; In-use preset deletion blocked with owning modules; Historical conversations retained
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Try deleting a preset in use, change module assignment, then copy it without credentials and inspect the unconfigured copy.
- **Source:** [apps/web/src/ScopedModelTools.tsx:45–49](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedModelTools.tsx#L45-L49); [apps/web/src/ScopedModelsForm.tsx:30–36](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedModelsForm.tsx#L30-L36); [apps/web/src/ModelProfiles.tsx:73–75](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ModelProfiles.tsx#L73-L75)

#### UF-IMAGE-DEFAULTS-AUTH — Control new image processing and separate original-image disclosure

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 设置 → 模型与服务 → 图片
- **Historical units:** C36
- **Inputs:** Auto-process new images; Image/OCR profile or originals-only; Scene/source-context analysis; Remote OCR authorization; Query original-image authorization
- **Actions:** Inspect model readiness; Save image settings; Open advanced policy
- **Required outcomes:** New screenshots/imported/synced/attached images share Central policy; Remote OCR consent and query-original consent are separate; Original archiving precedes independent processing steps
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Enable local OCR while refusing remote OCR and model access to originals; a query may use extracted text but must not imply it can see the image.
- **Source:** [apps/web/src/PerceptionSettings.tsx:88–103](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PerceptionSettings.tsx#L88-L103)

#### UF-IMAGE-HISTORY — Process a known range of existing images

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 图片 → 补处理已有图片
- **Historical units:** A21
- **Inputs:** Start/end date; Source; Fill missing steps or recompute
- **Actions:** Preview count; Schedule full selected range; Inspect batch/step progress
- **Required outcomes:** Fill reuses existing results; Recompute creates new version; Queued vs fully scheduled are distinct
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Preview only one source’s old images, choose fill-missing, then inspect progress without claiming all historical images were recomputed.
- **Source:** [apps/web/src/PerceptionSettings.tsx:104–111](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PerceptionSettings.tsx#L104-L111)

#### UF-MEDIA-MODEL-INSTALL — Prepare required local OCR/audio models

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 设置 → 文件与语音 / 图片 → 本地模型
- **Historical units:** C38
- **Inputs:** Available OCR/audio/optional speaker model
- **Actions:** Install; Cancel download; Refresh status
- **Required outcomes:** Administrator-only installation; Model installed vs worker/runtime ready; Missing dependencies; Download does not change chosen default strategy; Originals remain while waiting
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Audio model is installed but FFmpeg/runtime is missing; show the actual readiness gap, retain the archived recording, and avoid another redundant upload.
- **Source:** [apps/web/src/ManagedMediaModels.tsx:14–39](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ManagedMediaModels.tsx#L14-L39)

#### UF-FILE-PROCESSING-DEFAULTS — Choose default Central file-processing policy

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 设置 → 模型与服务 → 文件与语音
- **Historical units:** C38
- **Inputs:** Enable file processing; Single audio max minutes; Single processing timeout
- **Actions:** Edit; Save; Reload
- **Required outcomes:** Saved setting affects new and unfinished work; Completed products retained; Configured limit failure differs from model/runtime failure
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Lower audio duration limit, save, and see an over-limit archived file as preserved-but-unprocessed rather than missing.
- **Source:** [apps/web/src/FileProcessingSettings.tsx:51–60](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileProcessingSettings.tsx#L51-L60); [apps/web/src/FileProcessingSettings.tsx:85–86](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileProcessingSettings.tsx#L85-L86)

#### UF-FILE-TYPE-RULES — Match file types to processing plans

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件与语音 → 类型策略
- **Historical units:** A22
- **Inputs:** Exact MIME or wildcard; Processing plan
- **Actions:** Add rule; Remove rule; Save
- **Required outcomes:** Exact MIME precedes wildcard; Other fallback; Unavailable/incompatible plugin marked; No hidden conversion from archive-only to processing
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Use image/* plus an exact image/png rule and inspect which plan matches a PNG.
- **Source:** [apps/web/src/FileProcessingSettings.tsx:44–58](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileProcessingSettings.tsx#L44-L58)

#### UF-FILE-PLAN-EDITOR — Create and maintain a processing plan

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件与语音 → 处理方案
- **Historical units:** A22
- **Inputs:** Name; Processor; Declared plugin parameters; Service; Speaker plugin; Analysis model; Summary checkbox
- **Actions:** Create; Copy; Edit; Delete if unreferenced; Save
- **Required outcomes:** Each plan retains independent params; Missing service means waiting; Local-only constraints are explicit; Raw transcription preserved separately from summaries
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Copy an audio plan, disable summary in the copy, and verify original plan remains intact and referenced plans cannot disappear silently.
- **Source:** [apps/web/src/FileProcessingSettings.tsx:60–73](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileProcessingSettings.tsx#L60-L73)

#### UF-FILE-SOURCE-OVERRIDE — Override a processing policy for one source and file type

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件与语音 → 来源覆盖
- **Historical units:** A22
- **Inputs:** Source; MIME type; Plan
- **Actions:** Add override; Remove override; Save
- **Required outcomes:** Precedence source-exact → source-wildcard → global-exact → global-wildcard → other; Unconnected source is labeled; Other sources unchanged
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Archive images from one source while extracting images elsewhere; inspect the source override and global fallback.
- **Source:** [apps/web/src/FileProcessingSettings.tsx:75–77](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileProcessingSettings.tsx#L75-L77)

#### UF-FILE-SERVICES — Connect an eligible processing service

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件与语音 → 服务连接
- **Historical units:** A22
- **Inputs:** Service name/type; Model connection reference or local/remote endpoint as supported; Secret operation
- **Actions:** Add; Edit; Check saved local service; Delete if unreferenced; Save
- **Required outcomes:** Shared connection is referenced without copying secrets; Local/remote placement honest; Missing service blocks affected work only; ASR and diarization readiness are separate
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** An audio service has ASR ready but speaker separation unavailable; test the saved service and see both results.
- **Source:** [apps/web/src/FileProcessingSettings.tsx:79–104](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileProcessingSettings.tsx#L79-L104)

#### UF-FILE-RULE-PREVIEW-REPROCESS — Preview existing-file reprocessing before scheduling

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 文件与语音 → 规则试算与已有文件
- **Historical units:** A23
- **Inputs:** Source; File type; Trial MIME
- **Actions:** Inspect matching saved rule; Preview eligible originals; Confirm current preview
- **Required outcomes:** Uses saved settings; Up to implemented batch limit / preview lifetime displayed; Archive-only or running files skipped; New derived versions and stale corrections explained
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Change a plan without saving, run rule preview, and verify it clearly uses saved configuration; then confirm a valid preview with known correction invalidation.
- **Source:** [apps/web/src/FileProcessingSettings.tsx:88–91](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FileProcessingSettings.tsx#L88-L91)

#### UF-EXECUTION-CAPACITY — Understand queue waiting and administrator execution capacity

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 设置 → 模块与模型 / 账号管理 → 执行队列
- **Historical units:** A29
- **Inputs:** Administrator concurrency limits
- **Actions:** Inspect running/waiting/blocked/failed/external-unknown counts; Save allowed limits
- **Required outcomes:** Regular user sees own tasks; Administrator limits are not arbitrary account controls; Lowering limits does not interrupt running work; External unknown is not stopped
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A regular account has queued work; distinguish capacity wait from failure and do not expose administrator mutation controls as usable.
- **Source:** [apps/web/src/RuntimeSettings.tsx:24–41](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/RuntimeSettings.tsx#L24-L41); [apps/web/src/InstanceControls.tsx:5–9](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/InstanceControls.tsx#L5-L9)

#### UF-RETRIEVAL-CONNECTOR-CONFIG — Configure supported retrieval and connector settings

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 设置 → 模型与服务 → 检索 / 来源与外部应用
- **Historical units:** A30
- **Inputs:** Embedding module/provider/model; Connector interval; MCP connection fields; OAuth callback where implemented
- **Actions:** Save scoped configuration; Reload effective values
- **Required outcomes:** Text search remains available without embeddings; Embedding sends text to configured provider; Saved/effective/restart-required explicitly distinguished; Old env-download-only flow is not authoritative
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Save a setting requiring restart and inspect the still-current effective value; do not show a completed restart or obsolete env-diff download as applied.
- **Source:** [apps/web/src/ScopedConfiguration.tsx:21–31](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedConfiguration.tsx#L21-L31); [apps/web/src/ScopedConfiguration.tsx:59–94](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedConfiguration.tsx#L59-L94); [apps/web/src/ConfigurationBuilder.tsx:49–56](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ConfigurationBuilder.tsx#L49-L56)

### F12 — 找到所有已支持输入来源，不漏掉重要来源

#### UF-SOURCE-CATALOG — Find the supported source that matches the material

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 来源 → 新增来源
- **Historical units:** C07
- **Inputs:** Source type
- **Actions:** Choose device, Coding Agent, file import, Lark docs/calendar, Gmail, Google Calendar, MCP resource service, external/NAS reference, or registered recording provider
- **Required outcomes:** Correct platform and authorization owner are explained; Unavailable/unregistered capability is not presented as usable; Recording vendor availability is registry-based
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A user has a coding session, an NAS path, and a meeting recording; each reaches its correct supported intake, without inventing Central disk scanning.
- **Source:** [apps/web/src/SourceCatalog.tsx:14–44](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/SourceCatalog.tsx#L14-L44)

#### UF-SOURCE-STATE — Manage an existing source and inspect the right history

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 来源 → 来源详情
- **Historical units:** C08
- **Inputs:** No new input fields
- **Actions:** Choose source; Pause/resume intake; Browse source materials; Open related activity; Refresh state
- **Required outcomes:** Enabled/paused/syncing/permission/error status; Pause keeps existing archive; One-time import and waiting-for-write sources are not mislabeled as folder watches
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Pause one source, open its already archived content, then resume; unrelated sources and device capture must not change.
- **Source:** [apps/web/src/Sources.tsx:72–83](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Sources.tsx#L72-L83)

#### UF-SOURCE-CONTEXT — Describe the source so the Agent understands its material

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 来源 → 来源详情 → 资料说明
- **Historical units:** C08
- **Inputs:** Optional 12,000-character description covering format, dates/timezone, authors, subject/background and ownership scope
- **Actions:** Edit; Save description; Read acknowledged saved version
- **Required outcomes:** Description applies to existing and future source material; Does not automatically retranscribe/recompute historical memory; Material-specific declaration takes precedence where applicable
- **Visible entry:** A labeled source-description entry and whether it is saved, draft, or blocked.
- **May be disclosed progressively:** The full long description may open in a focused editor.
- **Adversarial journey:** Explain that a folder contains team transcripts about Project Q, not personal diary statements; save and verify the exact source description and acknowledgment.
- **Source:** [apps/web/src/SourceContextEditor.tsx:83–97](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/SourceContextEditor.tsx#L83-L97); [apps/server/src/source-context.ts:45–76](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/server/src/source-context.ts#L45-L76); [apps/server/src/source-context-catalog.ts:14–25](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/server/src/source-context-catalog.ts#L14-L25)

#### UF-SOURCE-CONTEXT-CONFLICT — Recover a stale source description without silently losing a draft

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 来源 → 资料说明编辑器
- **Historical units:** C08
- **Inputs:** Locally edited description; Expected source version
- **Actions:** Save; Reload latest; Explicitly discard and reload
- **Required outcomes:** Conflict preserves draft; Background refresh cannot advance baseline under dirty edits; Edits made during save remain draft against acknowledged version; Read/save failures are actionable
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Edit source context in two sessions; after the second saves, the first must show conflict and retain its draft until explicit reload/discard.
- **Source:** [apps/web/src/SourceContextEditor.tsx:14–79](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/SourceContextEditor.tsx#L14-L79); [apps/web/src/SourceContextEditor.tsx:88–94](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/SourceContextEditor.tsx#L88-L94)

#### UF-SOURCE-ATTRIBUTION — Declare the relationship of a source’s content to me

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 来源 → 来源详情 → 内容归属
- **Historical units:** C08
- **Inputs:** Owner / third-party / mixed / unknown / no declaration
- **Actions:** Save source relation; Change or clear declaration
- **Required outcomes:** Source declaration affects existing/new material; Unknown attribution does not gate reading or extraction; Declaration is separate from prose context
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Set a source to mixed, add prose naming the author and quoted speakers, then clear the declaration; prose and relation remain independent.
- **Source:** [apps/web/src/AttributionContext.tsx:6–18](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/AttributionContext.tsx#L6-L18); [apps/web/src/Sources.tsx:80–80](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Sources.tsx#L80-L80)

### F13 — 接入飞书文档/日历、Google 日历、Gmail、厂商录音、MCP资料、外部/NAS引用

#### UF-EXTERNAL-REFERENCE — Preserve an external/NAS location without reading its contents

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 来源 → 添加外部引用
- **Historical units:** A04
- **Inputs:** Title; URI/location
- **Actions:** Save reference; Inspect resulting source record
- **Required outcomes:** Title/location/observation time only; No automatic remote body read; For analysis, choose accessible originals in a collector
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Save a NAS path then ask to inspect the body; the UI must explain that no body was collected and offer the collector route.
- **Source:** [apps/web/src/Sources.tsx:141–156](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Sources.tsx#L141-L156)

#### UF-GOOGLE-CONNECTION — Prepare a separate Google account connection

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 来源 → Google / Gmail
- **Historical units:** A05, A06
- **Inputs:** Connection ID; OAuth client ID; Keep/replace/clear client secret; Callback URL; Auto-sync and interval
- **Actions:** Create/edit; Authorize; Refresh authorization; Pause/enable/stop; Remove connection with confirmation
- **Required outcomes:** Per-connection isolation; Reauthorization vs connected/syncing states; Gmail API precondition; Removal/disconnection does not imply old archive deletion
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Create a Gmail connection, interrupt authorization, return and refresh; no false connected state and existing unrelated connection preserved.
- **Source:** [apps/web/src/ScopedConnectorSettings.tsx:12–39](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedConnectorSettings.tsx#L12-L39); [apps/web/src/ScopedGmail.tsx:17–53](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedGmail.tsx#L17-L53)

#### UF-GOOGLE-CALENDAR-SCOPE — Read only the calendars I choose

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 来源 → Google Calendar
- **Historical units:** A05
- **Inputs:** Selected readable calendar IDs
- **Actions:** List calendars; Save selection; Sync; Disconnect
- **Required outcomes:** Authorization alone does not imply chosen calendar collection; New vs duplicate counts; Read-only archive distinct from calendar-action writes
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Authorize Google, choose one calendar, sync, then disconnect; history persists and the UI never claims event creation.
- **Source:** [apps/web/src/ScopedGmail.tsx:30–53](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedGmail.tsx#L30-L53); [apps/web/src/SourceCatalog.tsx:29–29](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/SourceCatalog.tsx#L29-L29)

#### UF-GMAIL-PAGING — Archive Gmail mail with truthful body/attachment scope

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 来源 → Gmail
- **Historical units:** A06
- **Inputs:** No new input fields
- **Actions:** Sync now; Continue history pagination; Refresh status; Disconnect
- **Required outcomes:** Body, sender and time archived; Attachments retain names/references only; More history pending is visible; Emails are evidence, not commands
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** First Gmail sync is partial; continue pages and distinguish an attachment reference from downloaded attachment bytes.
- **Source:** [apps/web/src/Gmail.tsx:42–57](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Gmail.tsx#L42-L57); [apps/web/src/ScopedGmail.tsx:46–53](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedGmail.tsx#L46-L53)

#### UF-MCP-RESOURCE-IMPORT — Import specifically selected readable MCP resources once

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 来源 → MCP 资料服务
- **Historical units:** A07
- **Inputs:** Service URL; Optional Bearer credential; Source name; Selected resources
- **Actions:** List resources; Select; Import selected
- **Required outcomes:** No resources is an explicit state; Imported/duplicate counts; Does not migrate hidden chatbot memory or invoke external writing tools
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** An MCP endpoint exposes tools but no resources; show that no direct resource import is available rather than fabricate imported memory.
- **Source:** [apps/web/src/ScopedMcpImport.tsx:28–49](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedMcpImport.tsx#L28-L49)

#### UF-LARK-AUTH — Authorize the right Lark connection with current deployment prerequisites

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 来源 → 飞书文档与日历 → 连接
- **Historical units:** A09
- **Inputs:** Connection ID; App ID/secret; Region
- **Actions:** Create/edit connection; Create app / save existing app; Authorize or change account; Open/copy link or QR; Recheck environment; Cancel authorization
- **Required outcomes:** Deployment-managed CLI prerequisite; Scoped credentials; Required read scopes; Expired/invalid auth fallback; Documents/calendar authorization separate from recording authorization
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** CLI is missing; reach the actual deployment preparation instruction and then retry, without a fictitious browser installer.
- **Source:** [apps/web/src/LarkSettings.tsx:65–109](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/LarkSettings.tsx#L65-L109); [apps/web/src/ProviderAuthorization.tsx:10–13](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ProviderAuthorization.tsx#L10-L13)

#### UF-LARK-DOCUMENT-SCOPE — Choose document activity discovery and continuously tracked ranges

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 来源 → 飞书文档与日历 → 范围与同步
- **Historical units:** A09
- **Inputs:** Activity types; Initial lookback days; Explicit documents; Folders; Wiki branches; Excluded documents; Background sync
- **Actions:** Save selection; Preview discovered documents; Confirm archive; Sync now; Pause/resume; Retry individual failed document
- **Required outcomes:** Activity discovery vs persistent explicit tracking differ; Exclusions take precedence; Preview does not read body; Partial successes retained; Activity open is not proof of reading/endorsement
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Enable opened-document discovery but exclude one document; preview, confirm, then inspect one failed document independently from successful archives.
- **Source:** [apps/web/src/LarkSettings.tsx:112–138](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/LarkSettings.tsx#L112-L138)

#### UF-LARK-CALENDAR-SCOPE — Read selected Lark calendars with correct time interpretation

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 来源 → 飞书文档与日历 → 日历
- **Historical units:** A09
- **Inputs:** Calendar IDs; Past/future days; All-day timezone
- **Actions:** Authorize calendar scope; Load available calendars; Save selection
- **Required outcomes:** Extra authorization does not start collection; Unavailable selected calendars can be deselected; Timezone retained for all-day events
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A previously selected calendar becomes unavailable; remove it without losing the remaining calendar selection or timezone.
- **Source:** [apps/web/src/LarkSettings.tsx:123–131](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/LarkSettings.tsx#L123-L131)

#### UF-RECORDING-AUTH-SCOPE — Choose a recording vendor and preserve its source explanation

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 来源 → 厂商录音 → 范围与说明
- **Historical units:** A10
- **Inputs:** Registered vendor; Connection ID; App/authorization input; Source context description; Initial start/end; Enabled/background sync
- **Actions:** Create/edit; Authorize; Save explanation before enabling intake; Save/start sync; Pause/stop/disconnect
- **Required outcomes:** Vendor-specific prerequisites and live-account verification limits; Docs vs recordings scopes separated; History preserved on stop/disconnect; Description acknowledgment is not merely decorative
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Describe who speaks and what meetings cover, authorize recordings, choose initial range, and save; verify context is acknowledged before intake.
- **Source:** [apps/web/src/RecordingAuthorization.tsx:19–26](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/RecordingAuthorization.tsx#L19-L26); [apps/web/src/RecordingsSettings.tsx:95–148](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/RecordingsSettings.tsx#L95-L148); [apps/web/src/ScopedRecordingsSettings.tsx:45–55](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedRecordingsSettings.tsx#L45-L55)

#### UF-RECORDING-STAGES-RECOVERY — Track transcript archive and original-audio backup independently

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 来源 → 厂商录音 → 同步步骤 / 最近归档
- **Historical units:** A10
- **Inputs:** No new input fields
- **Actions:** Sync now; Retry failed steps; Page checkpoints; Open recent transcript/audio; Cancel current operation; Retry same unknown submission
- **Required outcomes:** Transcript/audio/pending/failure counts; Empty transcript vs unsupported vendor format; Automatic retry exhausted vs scheduled retry; Archived audio remains after vendor deletion
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Vendor transcript is archived while audio backup fails; open available text and retry only the failed backup path without declaring the entire recording complete.
- **Source:** [apps/web/src/RecordingsSettings.tsx:30–36](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/RecordingsSettings.tsx#L30-L36); [apps/web/src/RecordingsSettings.tsx:148–153](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/RecordingsSettings.tsx#L148-L153); [apps/web/src/ScopedRecordingsSettings.tsx:17–41](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedRecordingsSettings.tsx#L17-L41)

#### NAT-014 — Connect selected local calendar read-only

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Sources / Calendar
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Selected authorized calendar; Snapshot or reference; Initial history; Android past/future days
- **Actions:** Request calendar permission; Choose calendar; Save; Pause
- **Required outcomes:** Permission denied/empty/hidden calendar states; Selected range only; Mac window past30/future90 days; Android configurable
- **Visible entry:** Connect call to action and selected calendar visible, additional range settings disclosed
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Deny permission, retry later, then choose hidden/empty provider and show actionable state.
- **Source:** [apps/desktop/src/index.html:119–128](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L119-L128); [apps/desktop/src/ui.ts:732–750](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L732-L750); [apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt:119–139](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt#L119-L139); [apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt:164–183](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/SourcesActivity.kt#L164-L183)

### F14 — 接入 Coding Agent 会话并回看经验依据

#### UF-CODING-RECEIPTS — Distinguish received coding events from published and searchable conversations

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 活动 / 资料库 → Coding 同步状态
- **Historical units:** C19, A15
- **Inputs:** No new input fields
- **Actions:** Inspect source receipt; Open published conversation body; Page receipts; Open Mac setup guidance
- **Required outcomes:** Received events/bytes, published conversations, indexed conversations and memory progress separate; Reception does not prove complete source content; Local acquisition is Mac-only
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A source received 500 events but only one partial material; open its body and inspect gaps instead of equating event count with conversation completeness.
- **Source:** [apps/web/src/CodingUploads.tsx:33–59](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/CodingUploads.tsx#L33-L59)

#### NAT-015 — Archive supported coding-agent conversations

- **Priority / platforms:** P0 / macos
- **Canonical home:** Sources / Coding conversations
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Claude Code; Codex; Kimi Code; History and source filter rules
- **Actions:** Discover installed sessions; Choose provider; Confirm collection; Pause
- **Required outcomes:** Unavailable provider state; Conversations and tool records archived; Agent configuration never rewritten
- **Visible entry:** Provider and scope visible in dedicated flow
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** No compatible local sessions exist; report empty discovery without inventing setup success.
- **Source:** [apps/desktop/src/index.html:119–119](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L119-L119); [apps/desktop/src/ui.ts:740–746](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L740-L746)

### F15 — 浏览、纠正、删除、导出和手动提取记忆

#### UF-MEMORY-BROWSE — Read evidence-backed memories within scope

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 资料库 → 记忆
- **Historical units:** C23, A16
- **Inputs:** Text query; Selected memory/event/all type; Initial/integrated layer; Active/revalidation state; Include superseded/expired; As-of time
- **Actions:** Search; Filter; Open; Page; Return current
- **Required outcomes:** Statement, uncertainty/boundaries, evidence, version and validity; Active vs historical vs needs-revalidation; Project-scoped coding evidence remains scoped
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Search a historical as-of date and inspect a superseded memory without treating it as the current accepted conclusion.
- **Source:** [apps/web/src/Memories.tsx:178–191](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Memories.tsx#L178-L191)

#### UF-MEMORY-CORRECT-DELETE-EXPORT — Correct, remove or export a memory without destroying its supporting originals

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 记忆 → 详情 → 纠正 / 删除 / 导出
- **Historical units:** C24
- **Inputs:** Title; Corrected statement; Boundary/uncertainty; Effective/expiry dates
- **Actions:** Save correction replacing old version; Delete after scope confirmation; Download Markdown
- **Required outcomes:** User correction is preserved as evidence; Old memory/evidence remain inspectable; Deletion suppresses reuse from same old evidence; External removal uncertainty is explicit
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Correct a date-bound memory, inspect the superseded version, then export it; deleting the memory must not claim its original source was erased.
- **Source:** [apps/web/src/Memories.tsx:42–46](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Memories.tsx#L42-L46); [apps/web/src/Memories.tsx:159–165](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Memories.tsx#L159-L165); [apps/web/src/Memories.tsx:184–194](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Memories.tsx#L184-L194)

#### UF-MEMORY-MANUAL-EXTRACTION — Extract from either an explicit material or a stated range

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 记忆 → 提取记忆
- **Historical units:** C25
- **Inputs:** Exact selected evidence or date/device range; Model; Optional recipe set
- **Actions:** Inspect exact scope; Choose recipes; Start extraction; Clear selection to restore range
- **Required outcomes:** Current exact-input selection overrides broad page range visibly; Up to supported recipe count; Missing required content waits independently; No recipe means supported default
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Page is scoped to a month but one current material is selected; run extraction and verify it uses only the explicitly selected evidence.
- **Source:** [apps/web/src/Memories.tsx:111–121](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Memories.tsx#L111-L121); [apps/web/src/Memories.tsx:166–177](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Memories.tsx#L166-L177); [apps/web/src/ManualMemoryRecipes.tsx:8–19](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ManualMemoryRecipes.tsx#L8-L19)

#### UF-MEMORY-TASK-CONTROLS — Recover a known memory extraction or processing window

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 活动 / 记忆 → 提取进度
- **Historical units:** C25
- **Inputs:** No new input fields
- **Actions:** Inspect batches/results; Pause/resume/cancel/retry when offered; Open original task
- **Required outcomes:** Exact original window/range retained on retry; Unknown external outcome may require confirmation; Completed products stay readable while other work waits
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** A memory run is paused with completed batches and an unknown external call; inspect saved results, confirm uncertainty if required, and retry its original range.
- **Source:** [apps/web/src/MemoryProgress.tsx:1–79](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/MemoryProgress.tsx#L1-L79); [apps/web/src/MemoryOperations.tsx:20–33](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/MemoryOperations.tsx#L20-L33)

#### UF-MEMORY-CLARIFICATION — Answer a scope-limited question about uncertain material

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 问一问 / 相关资料 / 活动 → 需要你补充
- **Historical units:** C26
- **Inputs:** Free text or authored choice
- **Actions:** Read related originals; Answer and continue; Defer; Do not know/end; Reopen with new information
- **Required outcomes:** Answer affects only relevant material; Deferred work does not block unrelated work; Stale question cannot accept outdated answer; Answer recorded does not equal memory published
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Defer an authorship question, continue other work, return with an answer after source revision changes; show stale question and new scope.
- **Source:** [apps/web/src/OwnerQuestions.tsx:57–86](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/OwnerQuestions.tsx#L57-L86)

#### UF-MEMORY-INTEGRATE — Use one current memory as the starting point for further consolidation

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 记忆详情 → 从这条记忆开始整理
- **Historical units:** A17
- **Inputs:** Current memory; Consolidation recipe
- **Actions:** Inspect default model and scope; Start; Cancel; Explicit retry; Open result
- **Required outcomes:** Selected card is starting point, not entire retrieval boundary; Current eligible version required; Manual run does not enable automatic consolidation; Zero new memories is valid
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Start from one current memory, receive zero new memories, and show a completed valid result rather than inventing an output.
- **Source:** [apps/web/src/ScopedMemoryIntegration.tsx:25–43](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedMemoryIntegration.tsx#L25-L43); [apps/web/src/MemoryIntegration.tsx:70–82](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/MemoryIntegration.tsx#L70-L82)

#### UF-MEMORY-POLICY-RECIPES — Set future extraction recipes and historical processing cadence

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 模块与模型 → 记忆与洞察节奏
- **Historical units:** A18
- **Inputs:** Default/source/screenshot/Lark recipe combination; Lifecycle windows/thresholds/maximum wait; Working memory limits; Default timezone
- **Actions:** Save; Discard/reload; Retry stopped history window
- **Required outcomes:** New ready evidence admission separate from historical window cadence; Nonempty recipe requirements; Source override precedence; Saving does not reprocess all history; Existing windows retain starting settings
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Change screenshot recipes while a historical window runs; show new policy without claiming that running or completed historical evidence was recomputed.
- **Source:** [apps/web/src/MemoryRecipeSelection.tsx:38–49](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/MemoryRecipeSelection.tsx#L38-L49); [apps/web/src/MemorySettings.tsx:98–114](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/MemorySettings.tsx#L98-L114); [apps/web/src/ScopedConfiguration.tsx:63–77](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedConfiguration.tsx#L63-L77)

### F16 — 生成阶段洞察并回看证据

#### UF-INSIGHT-CREATE — Generate a review from an explicit source scope

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 资料库 → 洞察
- **Historical units:** C27
- **Inputs:** Optional focus question; Page time/device range or all archive; Model choice
- **Actions:** Create; Submit
- **Required outcomes:** Model-required path preserves intended review; Scope is explicit; Submission vs active run distinguished
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Create a review for only the selected week with a custom focus, encounter missing model, and return to that same draft.
- **Source:** [apps/web/src/Insights.tsx:167–175](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Insights.tsx#L167-L175)

#### UF-INSIGHT-RECOVERY — Return to a long review and recover appropriately

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 洞察 → 运行 / 历史
- **Historical units:** C27
- **Inputs:** No new input fields
- **Actions:** Leave/reopen; Reconnect progress; Cancel; Adjust range and retry; Open history
- **Required outcomes:** Actual retrieval/run stage; Server may continue after progress disconnect; Cancelled retains originals; Saved history distinguishes failed/cancelled/complete
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Disconnect the progress stream during a review, return and reconnect before deciding whether to cancel; no simulated completion.
- **Source:** [apps/web/src/InsightProgress.tsx:10–17](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/InsightProgress.tsx#L10-L17); [apps/web/src/Insights.tsx:169–175](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Insights.tsx#L169-L175)

#### UF-INSIGHT-EVIDENCE — Assess a report’s evidence coverage and historical snapshot

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 洞察 → 报告
- **Historical units:** C27
- **Inputs:** No new input fields
- **Actions:** Switch report/text; Open citations; Inspect scope/coverage/version; Inspect retrieval/generation details
- **Required outcomes:** Cutoff and source snapshot; Missing/partial/reference-only content caveat; Sampling not work time; Invalidated report requires regeneration
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Open an old report after source changes; show invalidation and coverage rather than treating the current archive as what the old report read.
- **Source:** [apps/web/src/InsightReport.tsx:45–50](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/InsightReport.tsx#L45-L50); [apps/web/src/Insights.tsx:80–87](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Insights.tsx#L80-L87)

### F17 — 管理普通待办，审核日程建议再写日历

#### UF-TODO — Track ordinary todos independently of calendar writes

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 今天 → 行动 → 待办
- **Historical units:** C29
- **Inputs:** Title; Optional due date
- **Actions:** Add; Filter open/completed/cancelled; Complete; Cancel; Reopen; Open evidence; Page
- **Required outcomes:** No due date supported; Completing todo does not create a calendar event
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Create a todo without a due date, complete it, reopen it, and verify no calendar confirmation or created event is implied.
- **Source:** [apps/web/src/Todos.tsx:8–15](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Todos.tsx#L8-L15)

#### UF-ACTION-DISCOVERY — Enable calendar suggestions with explicit review-device scope

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 今天 → 行动 → 发现设置
- **Historical units:** C30
- **Inputs:** Discovery enabled; Interpretation timezone; Authorized reviewing devices
- **Actions:** Save; Refresh devices; Retry failed analysis batches
- **Required outcomes:** Model and disclosure scope; Local-only material not sent remotely; Discovery never writes calendar directly; Revoked device setting asks for refresh
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Enable discovery with one review device, revoke it elsewhere, then inspect the stale authorization warning before saving.
- **Source:** [apps/web/src/Actions.tsx:48–56](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Actions.tsx#L48-L56)

#### UF-ACTION-REVIEW — Review exact proposed calendar content against source evidence

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 今天 → 行动 → 日程建议
- **Historical units:** C30
- **Inputs:** Title; Start/end; All-day; Timezone; Location; Notes; Existing device/calendar
- **Actions:** Filter suggestions; Open evidence; Edit; Choose real target calendar; Freeze review; Confirm / ignore
- **Required outcomes:** Create/update/cancel/mark-complete are distinct; All-day end exclusive; Fixed review binds content/evidence/device/calendar; No invitations to participants
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Correct an all-day event timezone, choose the target device/calendar, freeze review, then change source version; stale review must require recheck.
- **Source:** [apps/web/src/Actions.tsx:57–66](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Actions.tsx#L57-L66); [apps/web/src/ActionReview.tsx:63–73](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ActionReview.tsx#L63-L73)

#### UF-ACTION-EXECUTION-RECOVERY — Verify client calendar execution without duplicate events

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 行动 → 待写入 / 结果
- **Historical units:** C30
- **Inputs:** No new input fields
- **Actions:** Open target device sync; Inspect receipt; Verify uncertain existing event
- **Required outcomes:** Waiting device / running / written / uncertain / stale evidence states; Unknown result means verify existing event, not recreate; Update/cancel targets original event
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Device writes an event but its receipt is lost; recover by verifying the existing event, not creating a second event.
- **Source:** [apps/web/src/Actions.tsx:18–18](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Actions.tsx#L18-L18); [apps/web/src/Actions.tsx:60–65](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Actions.tsx#L60-L65); [apps/web/src/ActionReview.tsx:44–59](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ActionReview.tsx#L44-L59)

#### NAT-016 — Review and deliver calendar action suggestions

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Actions / Calendar suggestions
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Suggestion evidence; Calendar; Title; Date/time/timezone; All-day; Location and notes where present
- **Actions:** Connect write-capable calendar separately; Review evidence; Confirm add/update/cancel/complete; Dismiss; Deliver confirmed suggestion; Verify uncertain write
- **Required outcomes:** Only confirmed suggestions written; Original-device restrictions; Read-only source collection and write connection separate
- **Visible entry:** Review action and evidence visible, calendar editing revealed per suggestion
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Confirmed write loses response; verify saved result rather than silently creating duplicate calendar entry.
- **Source:** [apps/desktop/src/index.html:120–120](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L120-L120); [apps/desktop/src/ui.ts:747–749](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/ui.ts#L747-L749); [apps/android/app/src/main/java/dev/mote/collector/CalendarActionsActivity.kt:30–41](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/CalendarActionsActivity.kt#L30-L41); [apps/android/app/src/main/java/dev/mote/collector/CalendarActionsActivity.kt:101–179](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/CalendarActionsActivity.kt#L101-L179)

### F18 — 给其他 Chatbot/MCP 与设备授予或撤销权限

#### UF-MCP-GRANT — Grant a chatbot scoped archive access

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 来源 → 对外授权 → Chatbot
- **Historical units:** A08
- **Inputs:** Connection name; Read-only or selected-source write; Source selection
- **Actions:** Generate MCP configuration
- **Required outcomes:** Read-all-own-sources semantics when no read source selected; Write requires explicit existing source; Credential is separate from device/account login
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Create a read-only connection with no source filter, then a write connection; write generation requires explicit sources.
- **Source:** [apps/web/src/PersonalConnections.tsx:14–21](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PersonalConnections.tsx#L14-L21)

#### UF-MCP-CREDENTIAL-DELIVERY — Save a one-time displayed chatbot credential safely

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 对外授权 → 新建连接结果
- **Historical units:** A08
- **Inputs:** Generated configuration
- **Actions:** Copy/download configuration as available; Hide displayed credential
- **Required outcomes:** Credential remains valid after hiding/leaving; Lost credentials require revocation/regeneration, not reveal-existing-secret
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Generate configuration, hide it, reopen the page, and ensure hidden old secret is not presented as recoverable.
- **Source:** [apps/web/src/PersonalConnections.tsx:14–24](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PersonalConnections.tsx#L14-L24)

#### UF-CONNECTION-REVOKE — Inspect and revoke one issued connection

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 来源 → 对外授权 → 已授权连接
- **Historical units:** C06
- **Inputs:** No new input fields
- **Actions:** Refresh list; Inspect label/scope/status; Request revoke; Confirm / cancel
- **Required outcomes:** Revoked state specific to selected credential; Source archive is not deleted; Collector/account/MCP scopes are not conflated
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Revoke one chatbot credential while another device remains connected; only the chosen grant changes.
- **Source:** [apps/web/src/PersonalConnections.tsx:14–24](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PersonalConnections.tsx#L14-L24); [apps/web/src/Connections.tsx:1–123](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Connections.tsx#L1-L123)

### F19 — 自动记忆暂停、选择记忆方案、可信插件安装/启停

#### UF-AUTO-MEMORY-PAUSE — Pause new automatic memory admissions without losing archive access

- **Priority / platforms:** P0 / central-web
- **Canonical home:** 设置 → 自动记忆与插件 → 自动记忆
- **Historical units:** C33
- **Inputs:** No new input fields
- **Actions:** Pause; Resume; Inspect queued/running/checkpoint/external-unknown work; Open task detail
- **Required outcomes:** New data still archives; Already admitted work can finish; Resume handles new data, not automatic catch-up of paused history; Independent reviews follow separate settings
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Pause automatic memory during a run, import new files, then resume; show retained archives and do not claim automatic backfill of paused history.
- **Source:** [apps/web/src/PluginCenter.tsx:138–147](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L138-L147); [apps/web/src/ScopedMemoryControl.tsx:33–38](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedMemoryControl.tsx#L33-L38)

#### UF-AUTO-MEMORY-STOP — Immediately revoke old automatic-memory write authority

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 自动记忆 → 立即停止
- **Historical units:** C33
- **Inputs:** No new input fields
- **Actions:** Request immediate stop; Read scope; Confirm / cancel
- **Required outcomes:** Existing originals/memories/query retained; External work may not stop immediately; Unconfirmed outcomes remain explicit; Not equivalent to pause or deleting memory
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Stop while an external call is unresolved; display pending outcome instead of claiming instantaneous remote termination.
- **Source:** [apps/web/src/PluginCenter.tsx:145–147](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L145-L147); [apps/web/src/PluginCenter.tsx:171–171](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L171-L171); [apps/web/src/ScopedMemoryControl.tsx:38–38](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedMemoryControl.tsx#L38-L38)

#### UF-MEMORY-PLAN-MIGRATION — Prepare and separately activate a new memory implementation

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 自动记忆与插件 → 记忆方案
- **Historical units:** C34
- **Inputs:** Registered target plan; Already-authorized history scope; Cost acknowledgment
- **Actions:** Preview; Prepare; Inspect migration/index validation; Retry/cancel preparation; Set current plan
- **Required outcomes:** Preparation is not activation; Failed/cancelled prep does not switch; Old query snapshot retained during transition; Does not authorize new historical extraction
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Prepare a new plan, let validation fail, retry, then explicitly activate only after validation; current binding must remain old until final apply.
- **Source:** [apps/web/src/PluginCenter.tsx:149–157](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L149-L157); [apps/web/src/PluginCenter.tsx:169–169](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L169-L169); [apps/web/src/ScopedMemoryControl.tsx:35–43](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedMemoryControl.tsx#L35-L43)

#### UF-PLUGIN-INSTALL — Inspect and install a supported trusted plugin version

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 自动记忆与插件 → 发现
- **Historical units:** C35
- **Inputs:** Repository; Optional release tag
- **Actions:** Discover; Preview fixed release; Inspect capabilities/permissions/dependencies/hash/runtime/restart requirement; Install
- **Required outcomes:** Admin-only installation; Trusted host-code warning; Install does not configure/enable/bind; Unavailable installer is explicit
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Preview a plugin that needs restart and install it; it must not appear active or automatically bound before required separate steps.
- **Source:** [apps/web/src/PluginCenter.tsx:131–135](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L131-L135); [apps/web/src/PluginCenter.tsx:168–168](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L168-L168)

#### UF-PLUGIN-INSTANCE — Configure and validate a plugin instance before using it

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 自动记忆与插件 → 已安装 → 实例
- **Historical units:** C35
- **Inputs:** Instance name; Declared fields; Credential references; Capability/data/history scope
- **Actions:** Create; Configure; Save; Validate; Enable/disable; Open plan
- **Required outcomes:** Instance/package/current-plan distinction; Scope does not grant new data authority; Stale configuration retains draft and asks reload
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Edit an instance concurrently in two sessions; conflict must not silently overwrite the other configuration or activate it.
- **Source:** [apps/web/src/PluginCenter.tsx:44–56](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L44-L56); [apps/web/src/PluginCenter.tsx:115–128](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L115-L128); [apps/web/src/PluginCenter.tsx:161–163](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L161-L163)

#### UF-PLUGIN-UNINSTALL — Remove an eligible plugin package with explicit dependencies

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 自动记忆与插件 → 安装包详情
- **Historical units:** C35
- **Inputs:** No new input fields
- **Actions:** Request uninstall; Confirm / cancel
- **Required outcomes:** Bound/history-reader/draining packages cannot be removed; Host rechecks eligibility; Removing UI component does not change backend authorization
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Try uninstalling the currently bound memory package; show why it is blocked and route to plan management.
- **Source:** [apps/web/src/PluginCenter.tsx:118–128](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L118-L128); [apps/web/src/PluginCenter.tsx:170–170](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L170-L170)

#### UF-PLUGIN-CAPABILITY-AUDIT — Inspect actually registered capabilities and bindings

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 自动记忆与插件 → 高级
- **Historical units:** A28
- **Inputs:** No new input fields
- **Actions:** Expand registered capability list; Inspect server/web versions, states, modules and bindings
- **Required outcomes:** Registration is not proof of healthy processing; Only actually registered/verified modules shown
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Inspect a registered but unavailable UI extension; do not equate a registry entry with a usable complete user flow.
- **Source:** [apps/web/src/FeatureInventory.tsx:1–12](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FeatureInventory.tsx#L1-L12); [apps/web/src/PluginCenter.tsx:149–160](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/PluginCenter.tsx#L149-L160)

### F20 — 存储/保留/备份/导出/删除、用量、诊断、语言与外观

#### UF-ARCHIVE-PORTABLE-EXPORT — Export this account’s retained normative material

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 存储与备份
- **Historical units:** C39
- **Inputs:** Metadata or available materials/attachments export mode
- **Actions:** Start export; Cancel; Validate/download result
- **Required outcomes:** Account-scoped archive; Credentials/execution grants/instance backups excluded; Validation/receipt errors visible; Offline full-instance backup described separately
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Export as a regular account and confirm it is not described as a complete multiuser server backup.
- **Source:** [apps/web/src/ScopedVault.tsx:8–26](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedVault.tsx#L8-L26); [apps/web/src/FilesExport.tsx:5–16](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/FilesExport.tsx#L5-L16)

#### UF-ARCHIVE-PORTABLE-IMPORT — Resume importing the supported same-account portable archive

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 存储与备份 → 导入归档
- **Historical units:** C39
- **Inputs:** Mote portable3 archive from original deployment/account
- **Actions:** Select; Import; Inspect stages/scope; Cancel; Retry using same file and operation; Page receipt
- **Required outcomes:** Current settings/secrets/execution grants unchanged; Wrong origin/account rejected; Refresh requires original file for retry; Old v2 import wording is not authoritative for scoped UI
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Refresh after partial portable import, reselect the same archive, and retry original operation rather than claim cross-account restore support.
- **Source:** [apps/web/src/ScopedPortableImport.tsx:29–44](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedPortableImport.tsx#L29-L44)

#### UF-CONTENT-ENCRYPTION — Control encryption for future archived file writes

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 存储与备份 → 内容存储
- **Historical units:** C40
- **Inputs:** Encryption toggle
- **Actions:** Save supported setting; Inspect effective state
- **Required outcomes:** Only future images/originals change; Existing formats remain readable; SQLite body/index are not all encrypted by this toggle; Current account scope
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Enable encryption with existing plaintext originals; reopen old files and distinguish future-write policy from full archive conversion.
- **Source:** [apps/web/src/ContentStorage.tsx:35–44](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ContentStorage.tsx#L35-L44)

#### UF-CONTENT-DECRYPT — Convert existing encrypted files to plaintext with recoverable progress

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 内容存储 → 一次性批量解密
- **Historical units:** A31
- **Inputs:** No new input fields
- **Actions:** Disable future encryption; Start batch decrypt; Cancel; Retry original operation; Inspect failed items
- **Required outcomes:** Background continuation; Checked/converted/unchanged/failed counts; Failures preserve original files; Credentials excluded; Unknown submission and local pending removal semantics retained
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Cancel after partial decryption, then restart; completed items remain converted and failures retain their originals.
- **Source:** [apps/web/src/ContentStorage.tsx:35–51](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ContentStorage.tsx#L35-L51)

#### UF-RETENTION-CAPACITY — Review and change administrator retention/capacity policy

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 存储与备份 → 保留与容量
- **Historical units:** C40
- **Inputs:** Retention preset/custom days; Capacity preset/custom MiB
- **Actions:** Edit; Restore draft; Save/apply; Inspect current effective values
- **Required outcomes:** Positive retention causes age-based cleanup; Saved vs restart-required/effective; Validation failure; Regular user does not get administrator-only mutation
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Save a shorter retention draft after inspecting scope; distinguish requested policy from currently effective values where restart is required.
- **Source:** [apps/web/src/ScopedStorageSettings.tsx:24–32](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedStorageSettings.tsx#L24-L32); [apps/web/src/ScopedConfiguration.tsx:88–88](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedConfiguration.tsx#L88-L88)

#### UF-INDEX-MAINTENANCE — Rebuild an eligible index without pretending to modify source content

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 实例运行设置与索引维护
- **Historical units:** C39
- **Inputs:** No new input fields
- **Actions:** Inspect status; Rebuild; Cancel; Retry same operation
- **Required outcomes:** Admin instance maintenance separate from personal source content; Attempts and unknown submission visible; Authorization rechecked before results
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Lose a rebuild receipt and retry the original operation; do not enqueue duplicate rebuilds or imply originals were recreated.
- **Source:** [apps/web/src/IndexMaintenance.tsx:7–17](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/IndexMaintenance.tsx#L7-L17); [apps/web/src/InstanceControls.tsx:5–9](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/InstanceControls.tsx#L5-L9)

#### UF-STORAGE-STATISTICS — Inspect storage use with a stated scope

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 运行状态与空间
- **Historical units:** A32, C40
- **Inputs:** 7 days / 30 days / all
- **Actions:** Refresh; View types/date distribution; Open usage
- **Required outcomes:** Current account directories scope; Shared DB/index/models/external service volumes excluded where scoped; Last-modified UTC distribution is not daily growth; Unreadable files mean partial total
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Compare last 7 days to all storage and read the modified-date basis; do not interpret difference as net newly archived bytes.
- **Source:** [apps/web/src/StorageStatistics.tsx:12–17](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/StorageStatistics.tsx#L12-L17)

#### UF-USAGE-ANALYSIS — Inspect measured model use and estimated cost

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 用量与费用
- **Historical units:** C41, A33
- **Inputs:** Date range; Module; Model; Status; Agent/module/skill/model dimension; Page size
- **Actions:** Filter; Click group/day/model; Clear; Page details; Open run
- **Required outcomes:** Input/output/cache/reasoning/request counts; Unknown usage stays unknown; Currency not combined; Success/latency only finished runs; Failures can still incur cost
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Inspect a failed run with partial token reporting and missing price; totals must not treat missing data as zero cost.
- **Source:** [apps/web/src/Usage.tsx:7–35](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Usage.tsx#L7-L35); [apps/web/src/Usage.tsx:84–107](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Usage.tsx#L84-L107)

#### UF-USAGE-PRICING — Set estimation prices for future model runs

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 用量与费用 → 模型价格
- **Historical units:** A33
- **Inputs:** Provider/model IDs; Currency; Uncached input/output/cache read/cache write per-million prices
- **Actions:** Save price
- **Required outcomes:** Price pinned at run start; Historic cost preserved; Subscription actual charge not inferred
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Change a model price and reopen an earlier run; its recorded estimate remains based on the original price.
- **Source:** [apps/web/src/Usage.tsx:68–71](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Usage.tsx#L68-L71); [apps/web/src/Usage.tsx:103–105](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Usage.tsx#L103-L105)

#### UF-AGENT-VIRTUAL-CONTEXT — See the context the Agent can access without making a model call

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → Agent 视角
- **Historical units:** A26
- **Inputs:** Device; Start/end time; Question for initial context preview
- **Actions:** Browse virtual directories; Expand body/evidence; Page; Preview initial context
- **Required outcomes:** Accessible vs initially supplied vs actually read remain distinct; No host filesystem/raw coding-event package; Directory omission is not proof of absence
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Inspect a source description and long material in Agent view, then preview initial context; do not claim everything browsable was supplied to a real answer.
- **Source:** [apps/web/src/AgentInspector.tsx:14–75](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/AgentInspector.tsx#L14-L75); [apps/web/src/agent-view-input.tsx:1–56](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/agent-view-input.tsx#L1-L56)

#### UF-AGENT-ACTUAL-TRACE — Inspect retained actual model input and tool reads

- **Priority / platforms:** P1 / central-web
- **Canonical home:** Agent 视角 → 实际输入与读取轨迹
- **Historical units:** A27
- **Inputs:** Run selection or run ID
- **Actions:** Open actual trace; Inspect context/model/tool events; Read/paginate content
- **Required outcomes:** Only retained recorded input shown; Missing/truncated/historical record cannot be reconstructed from current memory; Detailed logging prerequisite clear
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Open a run recorded before detailed trace was enabled; report absent evidence rather than reconstruct a convincing but false input trace.
- **Source:** [apps/web/src/agent-view-trace.ts:1–44](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/agent-view-trace.ts#L1-L44); [apps/web/src/AgentInspector.tsx:73–75](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/AgentInspector.tsx#L73-L75)

#### UF-DIAGNOSTIC-LOGS — Read retained logs and export a bounded diagnostic bundle

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 诊断与更新
- **Historical units:** A34
- **Inputs:** Log file; Stage; Page/page size; Export hour/day/week range; Wrap; Auto-refresh
- **Actions:** Refresh; Copy/select log page; Page newest/older; Export bundle
- **Required outcomes:** Raw ordering retained; Coverage/rotation gaps explicit; Safe instance metadata scope; Native device diagnostics exported on their device
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Export a 7-day diagnostic range with only one day retained; disclose coverage instead of implying deleted logs are recovered.
- **Source:** [apps/web/src/Diagnostics.tsx:59–105](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Diagnostics.tsx#L59-L105)

#### UF-DIAGNOSTIC-PREFERENCES — Control future logging and inspect actual configuration

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 诊断偏好 / 部署与生效配置
- **Historical units:** A35
- **Inputs:** Enabled; Level; Debug; Detailed Agent trace
- **Actions:** Save; Reload/restore; Inspect saved/effective deployment configuration
- **Required outcomes:** Immediately effective settings labeled; Detailed trace can contain personal context/output; Disabling stops new capture but does not fabricate deletion; No fictitious restart button
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Disable detailed tracing, inspect old retained run and new recording preference separately, with no claim old trace was removed.
- **Source:** [apps/web/src/RuntimeSettings.tsx:24–29](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/RuntimeSettings.tsx#L24-L29); [apps/web/src/ScopedConfiguration.tsx:63–78](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedConfiguration.tsx#L63-L78); [apps/web/src/ScopedConfiguration.tsx:92–94](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/ScopedConfiguration.tsx#L92-L94)

#### UF-HELP-VERSION — Find genuine support and update information

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 帮助 / 软件版本与更新
- **Historical units:** C42
- **Inputs:** No new input fields
- **Actions:** Open feedback; Inspect web/server version; Check signed release metadata; Open manual download/update guidance
- **Required outcomes:** Version mismatch warning; Checking does not update or roll back; Current manual release boundary; Feedback opens external destination without fabricated submission
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Web and server versions differ; show mismatch and real manual next step, not a simulated successful in-app update.
- **Source:** [apps/web/src/Feedback.tsx:8–16](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/Feedback.tsx#L8-L16); [apps/web/src/SoftwareUpdate.tsx:9–21](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/SoftwareUpdate.tsx#L9-L21)

#### UF-LANGUAGE-APPEARANCE — Use the preferred interface language and appearance

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 语言 / 外观
- **Historical units:** A36
- **Inputs:** Chinese / English; Light / dark / system
- **Actions:** Switch language; Switch appearance
- **Required outcomes:** Evidence content is not translated as UI copy; Preference persistence/fallback; Draft and selected task identity retained through presentation changes
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** With unsaved source context open, switch to English and dark mode; the owner’s original prose and selected source must remain intact.
- **Source:** [apps/web/src/LanguageSelector.tsx:1–9](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/LanguageSelector.tsx#L1-L9); [apps/web/src/AppearanceSelector.tsx:1–12](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/AppearanceSelector.tsx#L1-L12)

#### UF-ACCOUNT-DELETION — Delete an account through a durable progress receipt

- **Priority / platforms:** P1 / central-web
- **Canonical home:** 设置 → 账号管理 → 删除账号
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** No new input fields
- **Actions:** Read irreversible scope; Confirm / cancel; Inspect progress; Retry
- **Required outcomes:** Access revoked immediately; Material cleanup tracked separately; External uncertainty does not show fully erased; Administrator-only account operation
- **Visible entry:** A named entry and the current outcome or next action in the canonical home.
- **May be disclosed progressively:** Rare controls and full evidence may live in a labeled detail, drawer, tab, or advanced section.
- **Adversarial journey:** Delete an account with external work outstanding; show access revoked and unresolved cleanup separately.
- **Source:** [apps/web/src/AccountDeletion.tsx:17–25](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/AccountDeletion.tsx#L17-L25); [apps/web/src/AccountSettings.tsx:33–41](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/web/src/AccountSettings.tsx#L33-L41)

#### NAT-049 — Set local capacity and uploaded-copy retention

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Settings / Local storage
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Capacity limit; Mac record count; Android retained days 0–365
- **Actions:** Save; Inspect space
- **Required outcomes:** Full capacity pauses capture; Android cleanup starts at ACK, never deletes pending/conflict; Central archive separate
- **Visible entry:** Capacity and consequence discoverable; live blocked state visible
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Set retention zero with one pending record: only confirmed copy eligible for cleanup.
- **Source:** [apps/desktop/src/index.html:217–217](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L217-L217); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:702–708](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L702-L708)

#### NAT-050 — Move local queue storage with verification

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Settings / Storage location
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Allowed location; Available capacity
- **Actions:** Choose location; Confirm migration; Restore default on Mac; Open location on Mac
- **Required outcomes:** Migration progress/failure; Old records transferred with verification; Token/draft scope explained; Media must remain connected
- **Visible entry:** Chosen location and migration outcome visible; action under storage
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Remove external medium during migration; no success message until verified, preserve recoverable original.
- **Source:** [apps/desktop/src/index.html:216–216](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L216-L216); [apps/android/app/src/main/java/dev/mote/collector/StorageActivity.kt:40–88](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/StorageActivity.kt#L40-L88)

#### NAT-051 — Inspect actual storage and numeric collection statistics

- **Priority / platforms:** P1 / macos, android
- **Canonical home:** Settings / Statistics
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Date/type grouping; Refresh
- **Actions:** Inspect totals; Open record history; Export numbers on Android; Reset statistics origin with confirmation
- **Required outcomes:** Current disk occupancy not daily growth; Shared bytes counted once; Unmeasured/unreadable not zero; Activity estimate not attention time
- **Visible entry:** Compact summary; detailed tables/history progressive
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** A statistics read fails: show unknown/incomplete, never zero or fabricated focus time.
- **Source:** [apps/desktop/src/index.html:131–131](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L131-L131); [apps/desktop/src/index.html:169–172](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L169-L172); [apps/android/app/src/main/java/dev/mote/collector/StorageStatisticsActivity.kt:14–43](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/StorageStatisticsActivity.kt#L14-L43); [apps/android/app/src/main/java/dev/mote/collector/ActivityStatsActivity.kt:33–55](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/ActivityStatsActivity.kt#L33-L55); [apps/android/app/src/main/java/dev/mote/collector/ActivityStatsActivity.kt:80–111](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/ActivityStatsActivity.kt#L80-L111)

#### NAT-052 — Review local image deduplication candidates

- **Priority / platforms:** P1 / android
- **Canonical home:** Settings / Storage / Batch image dedupe
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Dedupe mode; Selected candidates
- **Actions:** Scan all; Cancel background task; Preview candidate and retained image; Select page/all; Move to pending decision area
- **Required outcomes:** Background progress persists; Pending area still consumes space and is not synced; Central copies unchanged
- **Visible entry:** Dedicated maintenance flow; no destructive action mixed with normal browsing
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Cancel scan halfway; show incomplete result, not full archive deduped.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/BulkDedupeActivity.kt:51–81](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/BulkDedupeActivity.kt#L51-L81); [apps/android/app/src/main/java/dev/mote/collector/BulkDedupeActivity.kt:115–126](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/BulkDedupeActivity.kt#L115-L126); [apps/android/app/src/main/java/dev/mote/collector/BulkDedupeActivity.kt:156–222](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/BulkDedupeActivity.kt#L156-L222)

#### NAT-053 — Restore or permanently delete selected local duplicate images

- **Priority / platforms:** P0 / android
- **Canonical home:** Settings / Storage / Batch image dedupe
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Selected pending or candidate images
- **Actions:** Restore; Delete/purge with explicit confirmation
- **Required outcomes:** Retained reference preserved; Central copies unaffected; Restore resumes original processing/sync; Partial completed work persists on cancel
- **Visible entry:** Destructive confirmation states count and irreversibility
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Restore pending candidates while sync manual; original local processing resumes but does not ignore sync policy.
- **Source:** [apps/android/app/src/main/java/dev/mote/collector/BulkDedupeActivity.kt:74–78](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/BulkDedupeActivity.kt#L74-L78); [apps/android/app/src/main/java/dev/mote/collector/BulkDedupeActivity.kt:237–245](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/BulkDedupeActivity.kt#L237-L245)

#### NAT-054 — Export and restore local records and configuration

- **Priority / platforms:** P0 / macos, android
- **Canonical home:** Settings / Backup and transfer
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Queue/record archive; Configuration JSON Android; Optional explicit token inclusion Android
- **Actions:** Export; Import; Preview/confirm; Retry partial import
- **Required outcomes:** Existing IDs deduplicated; Android imported records switch to manual sync; Device identity/system permissions retained; Failed import keeps original
- **Visible entry:** Backup types distinct; restore consequences visible before confirm
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Import same backup twice after partial failure; original records remain and no duplicates or automatic upload.
- **Source:** [apps/desktop/src/index.html:235–236](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L235-L236); [apps/android/app/src/main/java/dev/mote/collector/BackupActivity.kt:27–44](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/BackupActivity.kt#L27-L44); [apps/android/app/src/main/java/dev/mote/collector/BackupActivity.kt:79–123](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/BackupActivity.kt#L79-L123)

#### NAT-055 — Export Central data through account access

- **Priority / platforms:** P1 / macos, android
- **Canonical home:** Settings / Data export
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Metadata-only or content+attachments
- **Actions:** Sign in to Central; Export
- **Required outcomes:** Separate from local queue export; Correct account-bound archive; Incomplete output failure explicit
- **Visible entry:** Central export named separately with scope
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Paired collector without account session requests export; request account login, not substitute device-only data.
- **Source:** [apps/desktop/src/index.html:236–236](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L236-L236); [apps/android/app/src/main/java/dev/mote/collector/BackupActivity.kt:41–44](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/BackupActivity.kt#L41-L44); [apps/android/app/src/main/java/dev/mote/collector/BackupActivity.kt:69–74](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/BackupActivity.kt#L69-L74)

#### NAT-056 — Use local diagnostics and support exports

- **Priority / platforms:** P1 / macos, android
- **Canonical home:** Settings / Diagnostics
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Enabled; Sampling interval; Export time range
- **Actions:** Refresh metrics; Open logs; Export numeric JSON; Export safe support bundle
- **Required outcomes:** Fixed events/numbers only; No screenshots/text/tokens in safe support output; App diagnostics separate from always-on operation statistics
- **Visible entry:** Advanced diagnostics entry; redacted export purpose visible
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Turn off diagnostics, perform note upload: operation statistics still present without captured content in support bundle.
- **Source:** [apps/desktop/src/index.html:227–229](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L227-L229); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:726–741](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L726-L741)

#### NAT-057 — Choose language and appearance

- **Priority / platforms:** P2 / macos, android
- **Canonical home:** Settings / Appearance
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** System/Chinese/English; Light/dark/system
- **Actions:** Select; Persist
- **Required outcomes:** Save error actionable; Translated controls accessible
- **Visible entry:** Concise preference controls
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Switch language with large font; no clipped essential labels or hidden back/save actions.
- **Source:** [apps/desktop/src/index.html:133–133](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L133-L133); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:537–551](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L537-L551)

#### NAT-058 — Inspect and manually update the native app

- **Priority / platforms:** P1 / macos, android
- **Canonical home:** Settings / About and updates
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Release channel; Available signed package; Android update repository; Android download only on unmetered network
- **Actions:** Check; Download/verify; Cancel; Read release notes; Install with system confirmation; Open verified package where applicable; Android save update settings and check; Android delete downloaded package without removing app data
- **Required outcomes:** Download/progress/error states; Version/profile shown; No silent data reset; Dev artifacts distinguished; Invalid APK package/certificate/hash rejected with specific recovery state
- **Visible entry:** Version and update action visible; installation detail progressive
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** Cancel download or reject system installation: preserve current app/data and show honest state.
- **Source:** [apps/desktop/src/index.html:238–241](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L238-L241); [apps/android/app/src/main/java/dev/mote/collector/AppUpdatesActivity.kt:29–46](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/AppUpdatesActivity.kt#L29-L46); [apps/android/app/src/main/java/dev/mote/collector/AppUpdatesActivity.kt:50–136](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/AppUpdatesActivity.kt#L50-L136)

#### NAT-059 — Report an issue with current version context

- **Priority / platforms:** P2 / macos, android
- **Canonical home:** Settings / Feedback
- **Historical units:** Newly audited semantic item beyond historical directory detail
- **Inputs:** Issue description and optional diagnostic attachment
- **Actions:** Open GitHub feedback
- **Required outcomes:** Version/platform supplied; Cannot-open-browser recovery
- **Visible entry:** Discoverable feedback item
- **May be disclosed progressively:** Detailed controls may use labeled native detail/editor/advanced section before the relevant decision; current state and task return must stay clear.
- **Adversarial journey:** No browser available; show recovery instead of silent button.
- **Source:** [apps/desktop/src/index.html:141–141](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/desktop/src/index.html#L141-L141); [apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt:577–585](https://github.com/utopiafar/mote/blob/81a73c0ec81af876d6eeef71451b75cd51684b34/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L577-L585)

## Historical directory crosswalk

| Unit | Historical title | Disposition | Semantic feature IDs |
| --- | --- | --- | --- |
| C12 | 随手记下文字 | mapped_to_semantic_features | UF-NOTE-DRAFT, UF-NOTE-OFFLINE-QUEUE |
| C13 | 上传已有图片或音频附件 | mapped_to_semantic_features | UF-NOTE-ATTACHMENTS |
| C09 | 导入已有文档、文件夹和媒体 | mapped_to_semantic_features | UF-IMPORT-SELECTION, UF-IMPORT-CONTEXT |
| C10 | 查看并处理导入进度 | mapped_to_semantic_features | UF-IMPORT-CONTEXT-RECOVERY, UF-IMPORT-UPLOAD-QUEUE, UF-IMPORT-PREVIEW-CONFIRM, UF-IMPORT-DISPOSITIONS, UF-IMPORT-RECOVERY, UF-IMPORT-STAGES, UF-IMPORT-ORIGINALS |
| C11 | 删除整次导入 | mapped_to_semantic_features | UF-IMPORT-DELETE |
| A01 | 从中央机器的目录导入 | superseded_by_owner_correction |  |
| A02 | 选择导入解析器和图片处理方案 | mapped_to_semantic_features | UF-IMPORT-PARSER, UF-IMPORT-IMAGE-PLAN |
| A03 | 恢复被中断的本地上传 | mapped_to_semantic_features | UF-IMPORT-UPLOAD-QUEUE |
| C07 | 选择要加入的来源 | mapped_to_semantic_features | UF-SOURCE-CATALOG |
| C08 | 管理来源接收与内容关系 | mapped_to_semantic_features | UF-SOURCE-STATE, UF-SOURCE-CONTEXT, UF-SOURCE-CONTEXT-CONFLICT, UF-SOURCE-ATTRIBUTION |
| A04 | 保存外部或 NAS 引用 | mapped_to_semantic_features | UF-EXTERNAL-REFERENCE |
| A05 | 只读归档 Google 日历 | mapped_to_semantic_features | UF-GOOGLE-CONNECTION, UF-GOOGLE-CALENDAR-SCOPE |
| A06 | 只读归档 Gmail 邮件 | mapped_to_semantic_features | UF-GOOGLE-CONNECTION, UF-GMAIL-PAGING |
| A07 | 从远程 MCP 选择资源导入 | mapped_to_semantic_features | UF-MCP-RESOURCE-IMPORT |
| A09 | 连接飞书文档和日历 | mapped_to_semantic_features | UF-LARK-AUTH, UF-LARK-DOCUMENT-SCOPE, UF-LARK-CALENDAR-SCOPE |
| A10 | 归档厂商录音和转写 | mapped_to_semantic_features | UF-RECORDING-AUTH-SCOPE, UF-RECORDING-STAGES-RECOVERY |
| A11 | 查看来源版本和原位置 | mapped_to_semantic_features | UF-MATERIAL-PROVENANCE, UF-ORIGINAL-METADATA, UF-SOURCE-VERSIONS |
| C03 | 从今天开始整理资料 | mapped_to_semantic_features | UF-PRODUCT-BOUNDARIES |
| C04 | 查看设备上报的采集与同步状态 | mapped_to_semantic_features | UF-DEVICE-REPORTED-STATE |
| C05 | 连接或重新授权设备 | mapped_to_semantic_features | UF-DEVICE-INVITATION, UF-DEVICE-INVITATION-DELIVERY |
| C06 | 检查和撤销已发出的连接权限 | mapped_to_semantic_features | UF-CONNECTION-REVOKE |
| A08 | 让其他 Chatbot 使用 Mote MCP | mapped_to_semantic_features | UF-MCP-GRANT, UF-MCP-CREDENTIAL-DELIVERY |
| C14 | 浏览已经发布的资料正文 | mapped_to_semantic_features | UF-LIBRARY-FILTERS |
| C15 | 核对资料正文、来源与处理状态 | mapped_to_semantic_features | UF-MATERIAL-BODY-REVISION, UF-MATERIAL-PROVENANCE, UF-MATERIAL-INDEX-RECOVERY |
| C16 | 说明单份资料关系并提取记忆 | mapped_to_semantic_features | UF-MATERIAL-ATTRIBUTION, UF-MATERIAL-EXACT-MEMORY |
| C17 | 查看原始采集证据 | mapped_to_semantic_features | UF-ORIGINAL-RECORDS, UF-ORIGINAL-METADATA |
| C18 | 删除一条原始记录 | mapped_to_semantic_features | UF-ORIGINAL-DELETE |
| C20 | 围绕归档资料提问 | mapped_to_semantic_features | UF-ASK-COMPOSE, UF-ASK-RUN-RECOVERY |
| C21 | 回看和管理对话历史 | mapped_to_semantic_features | UF-ASK-EVIDENCE-HISTORY, UF-ASK-DELETE |
| C22 | 随问题提交图片 | mapped_to_semantic_features | UF-ASK-IMAGES |
| C23 | 浏览有证据的记忆 | mapped_to_semantic_features | UF-MEMORY-BROWSE |
| C24 | 纠正、删除或导出一条记忆 | mapped_to_semantic_features | UF-MEMORY-CORRECT-DELETE-EXPORT |
| C25 | 手动提取记忆 | mapped_to_semantic_features | UF-MEMORY-MANUAL-EXTRACTION, UF-MEMORY-TASK-CONTROLS |
| C26 | 回答需要你澄清的问题 | mapped_to_semantic_features | UF-MEMORY-CLARIFICATION |
| A16 | 核对记忆的历史和有效时间 | mapped_to_semantic_features | UF-MEMORY-BROWSE |
| A17 | 从一条当前记忆继续整理 | mapped_to_semantic_features | UF-MEMORY-INTEGRATE |
| A18 | 调整记忆策略和回顾节奏 | mapped_to_semantic_features | UF-MEMORY-POLICY-RECIPES |
| C27 | 生成并回看有证据的洞察 | mapped_to_semantic_features | UF-INSIGHT-CREATE, UF-INSIGHT-RECOVERY, UF-INSIGHT-EVIDENCE |
| C28 | 查看正在做的工作和结果 | mapped_to_semantic_features | UF-WORK-LIST, UF-WORK-DETAIL, UF-WORK-CAUSE-RECOVERY |
| A25 | 检查技术步骤并恢复可重试工作 | mapped_to_semantic_features | UF-WORK-CAUSE-RECOVERY, UF-WORK-TECHNICAL-STEPS |
| C29 | 记录和完成普通待办 | mapped_to_semantic_features | UF-TODO |
| C30 | 审核日程建议并交给设备执行 | mapped_to_semantic_features | UF-ACTION-DISCOVERY, UF-ACTION-REVIEW, UF-ACTION-EXECUTION-RECOVERY |
| C19 | 按内容类型查看资料库 | mapped_to_semantic_features | UF-CAPTURE-GROUPS, UF-ACTIVITY-TIME, UF-MEDIA-OBSERVATIONS, UF-CODING-RECEIPTS |
| A12 | 按截图片段或应用相册回看 | mapped_to_semantic_features | UF-CAPTURE-GROUPS |
| A13 | 查看测得的应用活动时间 | mapped_to_semantic_features | UF-ACTIVITY-TIME |
| A14 | 查看媒体播放观测 | mapped_to_semantic_features | UF-MEDIA-OBSERVATIONS |
| A15 | 查看 Coding 会话接收与同步状态 | mapped_to_semantic_features | UF-CODING-RECEIPTS |
| C39 | 导入导出归档并找到完整备份 | mapped_to_semantic_features | UF-ARCHIVE-PORTABLE-EXPORT, UF-ARCHIVE-PORTABLE-IMPORT, UF-INDEX-MAINTENANCE |
| C40 | 查看保留、容量和内容存储政策 | mapped_to_semantic_features | UF-CONTENT-ENCRYPTION, UF-RETENTION-CAPACITY, UF-STORAGE-STATISTICS |
| C41 | 核对模型用量和估算费用 | mapped_to_semantic_features | UF-USAGE-ANALYSIS |
| A31 | 把已有加密文件转为明文 | mapped_to_semantic_features | UF-CONTENT-DECRYPT |
| A32 | 查看运行状态与空间 | mapped_to_semantic_features | UF-STORAGE-STATISTICS |
| A33 | 维护估价并追查用量明细 | mapped_to_semantic_features | UF-USAGE-ANALYSIS, UF-USAGE-PRICING |
| C31 | 配置或检查模型连接（Provider） | mapped_to_semantic_features | UF-MODEL-PROVIDER, UF-MODEL-CREDENTIALS, UF-MODEL-TEST-DRAFT |
| C32 | 检查或分配功能使用的模型 | mapped_to_semantic_features | UF-MODEL-ASSIGNMENTS |
| C36 | 控制新图片识别与原图授权 | mapped_to_semantic_features | UF-IMAGE-DEFAULTS-AUTH |
| C37 | 查看文件或录音的内容提取和恢复 | mapped_to_semantic_features | UF-FILES-FIND-ORIGINAL, UF-FILES-PROCESSING-STAGES, UF-FILES-RECOVERY, UF-FILES-SPEAKER-CONFIG |
| C38 | 配置文件与语音处理 | mapped_to_semantic_features | UF-MEDIA-MODEL-INSTALL, UF-FILE-PROCESSING-DEFAULTS |
| A19 | 调整模型性能和协议细节 | mapped_to_semantic_features | UF-MODEL-CREDENTIALS, UF-MODEL-PERFORMANCE |
| A20 | 复制或删除模型预设 | mapped_to_semantic_features | UF-MODEL-COPY-DELETE |
| A21 | 补处理或重算历史图片 | mapped_to_semantic_features | UF-IMAGE-HISTORY |
| A22 | 配置文件规则、方案和处理服务 | mapped_to_semantic_features | UF-FILE-TYPE-RULES, UF-FILE-PLAN-EDITOR, UF-FILE-SOURCE-OVERRIDE, UF-FILE-SERVICES |
| A23 | 预览文件规则并重新处理已有原件 | mapped_to_semantic_features | UF-FILE-RULE-PREVIEW-REPROCESS |
| A24 | 纠正转写并确认说话人 | mapped_to_semantic_features | UF-FILES-SPEAKER-CONFIG, UF-FILES-MANUAL-CORRECTION, UF-FILES-SPEAKER-NAME, UF-FILES-MODEL-REVIEW, UF-FILES-EXPORT |
| A29 | 设置执行并发和查看等待名额 | mapped_to_semantic_features | UF-EXECUTION-CAPACITY |
| A30 | 配置检索和外部连接的部署草稿 | mapped_to_semantic_features | UF-RETRIEVAL-CONNECTOR-CONFIG |
| C33 | 暂停或立即停止自动记忆 | mapped_to_semantic_features | UF-AUTO-MEMORY-PAUSE, UF-AUTO-MEMORY-STOP |
| C34 | 核对和替换整套记忆方案 | mapped_to_semantic_features | UF-MEMORY-PLAN-MIGRATION |
| C35 | 管理可信记忆插件 | mapped_to_semantic_features | UF-PLUGIN-INSTALL, UF-PLUGIN-INSTANCE, UF-PLUGIN-UNINSTALL |
| C01 | 登录并管理当前会话 | mapped_to_semantic_features | UF-ACCOUNT-LOGIN, UF-ACCOUNT-SESSION |
| C02 | 找到常用页面和所属工具 | mapped_to_semantic_features | UF-PRODUCT-BOUNDARIES, UF-NAVIGATION-STATE |
| C42 | 找到帮助、版本和维护方式 | mapped_to_semantic_features | UF-HELP-VERSION |
| A26 | 查看 Agent 当前能读取的上下文 | mapped_to_semantic_features | UF-AGENT-VIRTUAL-CONTEXT |
| A27 | 查看已记录的实际模型输入和工具读取 | mapped_to_semantic_features | UF-AGENT-ACTUAL-TRACE |
| A28 | 核对实际注册的插件能力 | mapped_to_semantic_features | UF-PLUGIN-CAPABILITY-AUDIT |
| A34 | 查阅运行日志并导出支持包 | mapped_to_semantic_features | UF-DIAGNOSTIC-LOGS |
| A35 | 设置诊断记录并查看部署生效值 | mapped_to_semantic_features | UF-DIAGNOSTIC-PREFERENCES |
| A36 | 切换界面语言 | mapped_to_semantic_features | UF-LANGUAGE-APPEARANCE |
