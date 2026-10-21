# Fresh first-use review: Mac R23

## Outcome

The first screen gave me a usable understanding of Mote: save personal notes, files and selected device records, then search or ask questions and return to the original. The prominent **写下第一条记录** action made the first step obvious. I saved a note, used the displayed **⌘ K** shortcut to find it, opened its original content, checked menu-bar collection status, and connected an example folder through the rendered interface.

The recurring-folder destination was clear from the first screen. Its **同步文件夹** card explicitly says it continuously saves new content from a chosen folder. The main friction appeared inside folder setup: the screen instructs the user to choose a folder in Finder, but the available control is a blank path text field without a picker action or a supplied example.

## Evaluation boundary

- Candidate: `ten-rounds/rounds/r23/mac.html`.
- Fresh browser context, empty account, 1280 × 900 viewport.
- I read only the permitted browser helper before the first look. I did not read candidate source, earlier reviews, or a feature inventory.
- First interpretation was saved before any interaction in `first-look.json`, with `00-first-screen.png` and the rendered-DOM observation in `00-first-screen.json`.
- All subsequent actions used visible, named controls or the displayed keyboard shortcut. No internal application state was read or manipulated.
- Findings concern this rendered HTML simulation. They do not verify Finder integration, real storage, real capture, or backend collection.

## Untouched first impression

I understood the app as a personal, searchable library. The explanation connects saving with later retrieval and checking originals; the example question makes the purpose concrete. Writing the first record is visually primary, with importing existing files beside it as another starting point. The sidebar and first-screen card both make folder sync discoverable.

The title-bar search affordance displays **⌘ K**. The top menu bar explicitly names **收集状态**, so neither depended on guessing an icon. The initial uncertainties were the meaning of **工作台在线**, the broad phrase **设备记录**, and the distinction between **今天** and **活动**. These did not prevent the requested tasks. My initial inference that **来源** means incoming collection and **资料库** means saved content was later confirmed by the visible explanation on the sources page.

## Task results

| Goal | Observed path and result | Evidence |
|---|---|---|
| Save a short note | **写下第一条记录** → entered “项目会议：周五前整理读书会提纲，并把参考资料放进读书会文件夹。” → **保存笔记**. A green **已保存到资料库** message appeared with actions to open the note or ask about it. | `01-note-editor.png`, `02-note-draft.png`, `03-note-saved.png` |
| Use Mac quick search | Pressed the displayed **⌘ K** shortcut. It navigated to the library and visibly focused the search field. Searching **读书会** produced the saved note, a **正文命中** indicator, and the matching excerpt. | `04-command-k-search.png`, `05-search-result.png` |
| Find the original | Opened the search result, then selected **查看原始内容**. The original-content dialog showed the exact saved text and **我写的记录**. | `06-note-original.png`, `07-original-content.png` |
| Inspect menu-bar collection status | Selected **收集状态**. The panel separately showed **屏幕记录：尚未开启** and **文件夹同步：尚未连接**, with an explicit statement that they are controlled separately. | `09-menu-bar-status-empty.png` |
| Find where recurring folder content belongs | From the panel, **管理本机来源** opened the sources page. Its local-device section offered **连接一个文件夹** and described saving later changes. The screen also explicitly says saved content enters the library. | `10-manage-local-sources.png`, `11-folder-setup.png` |
| Finish an example folder connection | Entered the invented example path `/Users/lin/Documents/读书会` and source name **读书会参考资料**; kept continuous sync checked and chose **本机与中央都保留**; selected **连接并保存**. The resulting page showed the named source and **当前状态：正在同步**. | `12-folder-path.png`–`15-folder-connected.png` |
| Recheck status after connection | Opened **收集状态** again. Folder sync changed to **1 个正在接收** while screen recording remained **尚未开启**. | `16-menu-bar-folder-connected.png` |

## Concrete newcomer friction

### Folder-selection instructions do not match the available action

At **连接新的文件夹**, the banner says **通过 Finder 选择一个文件夹**. Below it is an empty **文件夹位置** text field and the note **此原型使用示例文件夹**. There is no visible button that chooses a folder and no example path supplied. I had to invent and type a path to continue. The route to folder sync is understandable; the immediate input step is not fully explained.

Evidence: `11-folder-setup.png` and `11-folder-setup.json`. The rendered control inventory contains the path field, continuous-sync checkbox, source-name field, retention select, and save/cancel actions, but no picker action.

Suggested correction: either provide a visible simulated folder chooser with a reviewable selected path, or explicitly ask the user to enter an example path and supply one. Match the instruction to the action this prototype actually supports.

### The default retention choice leaves a meaningful question unanswered

The default **中央保留原件，本机按需清理** is accompanied by a useful definition of “中央” and “本机”. It still does not explain what **本机按需清理** would clear: Mote-managed local copies or files in the selected folder, and under whose control. This uncertainty matters while connecting a folder of reference material. I chose **本机与中央都保留**, whose immediate meaning was easier to understand.

Evidence: `11-folder-setup.png`, `14-folder-retention-choice.png`.

Suggested correction: explain the affected copy and the cleanup trigger beside the selected option. This is a question raised by the interface wording; the review makes no claim about actual deletion behavior.

### First-folder copy assumes another folder already exists

The empty-account menu and sources page correctly showed that no folder was connected. The next screen nevertheless said **为另一个文件夹建立独立来源，现有来源保持原样**. “另一个” briefly suggests an earlier folder that I have not connected. This did not block completion, but it is unnecessary uncertainty during first use.

Evidence: `09-menu-bar-status-empty.png`, `10-manage-local-sources.png`, `11-folder-setup.png`.

Suggested correction: use first-connection wording when there is no existing folder; reserve “另一个” for later additions.

### Original-content dialog promises time metadata that it does not display

The dialog says **保留内容的来源、时间与原始记录**. For the saved note, it displayed the note text twice and **我写的记录**, but no visible timestamp in the dialog. I could verify the original wording, so the task succeeded. I could not verify the stated time metadata there.

Evidence: `07-original-content.png`, `07-original-content.json`.

Suggested correction: display the available saved/captured time with a precise label, or narrow the explanatory sentence to the metadata actually shown for this item.

## What worked well

The opening screen links the purpose, a concrete example, and an immediate action. Saving gives a clear confirmation and useful next actions. Search visibly focuses on the shortcut and identifies the matched text. The detail view explicitly labels the original-content action. The sources page explains the division between incoming sources and saved library content. The menu-bar panel gives separate, understandable screen and folder states and reflects the folder connection afterwards.

No task-blocking interaction failure occurred in this path. The strongest improvement opportunity is the folder-selection step, followed by clarifying the retention option. No numeric usability score is assigned.

## Evidence bundle

- `first-look.json`: interpretation captured before interaction.
- `00-first-screen.png` / `00-first-screen.json`: untouched first screen.
- `01-…` through `16-…`: screenshots and rendered-DOM observations for the action path.
- `action-log.json`: ordered actions, exact note/path inputs, and completion record.
- `raw-trace.zip`: Playwright trace with screenshots and snapshots, without source capture.

