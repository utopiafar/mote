# Test layers and validation triggers

This is the single source for test layers and when to run them. App `AGENTS.md` files provide commands and platform limits; [CI](ci.md) describes workflow entrypoints. Choose checks by the behavior and boundaries changed, not by a test filename.

## Test layers

| Layer | What it establishes | When to run |
| --- | --- | --- |
| Local unit | A function or module rule, using real domain values and controlled dependencies | Focused feedback for the affected behavior |
| Module integration with real SQLite / HTTP | Storage, transactions, authenticated routes and module lifecycle against generated data | When those module behaviors change; keep focused cases in ordinary checks |
| Light cross-module contract | A producer's real serialized output is accepted and used by its actual consumer, including relevant errors | When an interface or its producer/consumer behavior changes; include affected contracts in ordinary checks |
| Heavy cross-client E2E | An assembled journey across processes, clients, UI, native runtime or containers, including relevant recovery | Explicit manual selection at a meaningful stage or before release; never automatically on each push |
| Scale correctness | Completeness, ordering, isolation, cancellation, deletion or recovery at a required input size | Keep the required scale and assertions; manually select expensive cases when the affected risk or relevant acceptance needs them |
| Pure performance benchmark | Latency, throughput, resource use or a comparison against a measured baseline | Explicit manual run for a performance investigation, a major performance-sensitive change or a measured severe regression |
| Real external model | Actual provider behavior and semantic quality with fixed generated inputs and declared model settings | Explicit manual selection when the change needs live-provider or quality evidence |

A module test using real SQLite or HTTP is not automatically heavy E2E. A large fixture that checks every record or cancellation is correctness coverage, even if its file contains `performance` or `migration`. Retain that coverage when splitting suites; keeping it does not require running it on every PR. A test that measures time and asserts correctness may need separate entrypoints, with its meaningful assertions, input size, lifecycle states and timeouts preserved. Do not delete or weaken valid tests to hide an existing failure.

## Daily feedback

Run the narrow command that exercises changed behavior after a coherent batch of edits. Ordinary changes need affected unit/module checks; interface changes also need a light contract against the real consumer. A small fix involving permissions, deletion or restoration still needs the corresponding risk regression, without expanding to unrelated repository suites.

Use the affected app's focused examples: [server](../apps/server/AGENTS.md), [web](../apps/web/AGENTS.md), [desktop](../apps/desktop/AGENTS.md), [Android](../apps/android/AGENTS.md). For Agent tests, build changed or missing shared/Agent inputs, then select an existing file, for example `node --test packages/agent/test/task-context.test.mjs` from the root. Do not append a filename to an npm script that already includes a full glob. Use Node `--test-name-pattern` before the filename for a single diagnostic case and report that selection.

Build shared inputs only when changed or absent; coordinate shared output with other owners. SQLite must match the active Node ABI. A report, handoff, turn ending or Draft PR update does not trigger wider checks.

## Early integration and candidate checks

For a large requirement, connect one shortest real journey early: actual entrypoint/startup, authenticated action, producer output and consumer result. A light contract can catch an interface mismatch quickly; it does not replace the assembled journey. Add relevant restart, cancellation or partial-failure states as the modules converge. A manually composed internal object does not prove actual startup.

At a meaningful stage completion and before release, one owner completes the full relevant acceptance scope for the converged candidate. Select heavy E2E, expensive scale correctness and live-model checks explicitly and manually when relevant. Stage/release acceptance is not a reason to run heavy suites on every push, every small PR or every handoff. Performance benchmarks follow their own triggers in the table above; historical performance targets do not automatically become current gates.

On a revision containing the balanced CI scripts, inspect the affected light plan before selecting execution:

```sh
npm run check:affected -- --dry-run
# Explicit committed comparison for a recovery branch:
npm run check:affected -- --base origin/main --head HEAD --dry-run
# Run the selected light plan when relevant:
npm run check:affected -- --base origin/main --head HEAD
```

The dry-run describes the commands in the checked-out revision; it is not runtime evidence. `check:affected` selects light checks only; `--all` expands to all light scopes, never heavy suites. Without `--head`, it also includes working changes. Broad component commands and `check:local` remain manual integration tools. Exact task commands, manual `suite/scope/revision` inputs and the distinction between workflow and local specialist entrypoints are in [CI](ci.md). A local light plan does not replace the relevant manually selected acceptance.

After a fix rerun checks invalidated by source, dependency, fixture, configuration or environment changes. Reuse unchanged successful results without another run. Never reuse failed, interrupted or uncertain-cleanup results. Diagnose repeated failures rather than endlessly replaying the same test. A known failure remains a failure until repaired and verified; moving it to a manual suite does not resolve it.

Document-only changes receive formatting, grammar, link and rendering review. Report fixture, physical-device and live-model evidence separately; historical results are not current evidence. In the PR record only: behavior changes, checks actually run, and untested risks. Use Git, CI and existing ignored logs; do not create a separate evidence ledger or receipt process.

## Logs

Keep verbose logs in ignored files; print a short result and inspect failure excerpts. Preserve exit status, for example:

```sh
mkdir -p .mote/checks
npm run typecheck -w @mote/server > .mote/checks/server-types.log 2>&1
check_status=$?
if [ "$check_status" -ne 0 ]; then tail -60 .mote/checks/server-types.log; fi
exit "$check_status"
```

## Risk-based review

Independent review before implementation applies to a changed product boundary or architectural decision: for example who may access data, what deletion/restoration promises, a persistence or cross-client contract, or lifecycle responsibilities across modules. State the old/new decision, affected consumers, risks and real-boundary validation briefly. Bind review to that scope and assumptions; review again only when the decision boundary changes. New product policies still belong to the human owner.

Module features and bug fixes within an established boundary need focused validation, not new design approval. A permission, deletion or recovery fix that restores the existing contract needs the corresponding regression. It does not automatically require an independent approval or full-repository run.

Product decisions can supersede obsolete assertions. Explain the changed behavior and review the decision when it changes a product or architectural boundary; do not relax valid assertions, timeouts, scale or tested entrypoints just to make a failure pass. KEEP/CHANGE/REMOVE/EXCEPTION/UNKNOWN is useful for superseded architectural responsibilities, not a mandatory form for every edit.

[Coordination](agent-development-workflow.md) applies when work needs multiple owners. The [2026-10-10 system-refactor validation plan](design/system-refactor-validation-2026-10-10.md) is a historical project-specific plan, not today's default workflow, approval process or performance gate.

<a id="background-testing"></a>

### 本地后台测试

本地自动化测试默认不显示窗口、不激活应用、不抢占当前焦点。单测、类型检查、构建及 Gradle JVM 测试直接在终端运行，不需要启动客户端或模拟器。需要 UI 验证时仍运行真实渲染器、preload/IPC 和应用生命周期，使用生成素材与独立测试 profile。

中央网页的首次加载、同范围后台刷新、空状态、滚动时间范围、分页及撤权回归见 [Web 后台刷新稳定性](testing-web-background-refresh.md)。

Electron UI/桌面 fixture 入口必须在导入 `electron` 或产品模块之前加载 `scripts/fixture-background.cjs`（桌面脚本使用对应相对路径）。该测试专用入口强制隐藏窗口、禁止原生窗口获取焦点，并关闭后台渲染节流，使动画帧、DOM 焦点、键盘/滚轮输入及生成页面截图仍可验证。macOS 使用 accessory 激活策略避免 Dock 图标；不使用禁止创建窗口的 prohibited 策略。新建、重建窗口及后续 `show()` / `focus()` 调用均遵守同一规则。产品正常启动行为不变。

```sh
# 后台窗口、真实输入、动画帧、截图和窗口重建的生成 fixture 回归
npm run test:background-ui
# 构建客户端后运行真实桌面 UI 与 profile 重启流程
npm run test:ui -w @mote/desktop
npm run test:profiles -w @mote/desktop
```

隐藏窗口不会自动隐藏系统原生文件选择、消息提示或外部浏览器。因此后台 fixture 遇到未预期的原生 dialog 或 `shell.openExternal` 会报错；未捕获异常（包括 ready 前的启动失败）输出错误并以非零状态退出，避免 Electron 自身显示错误窗口。需要这些操作的测试应在加载入口后提供明确的生成响应或记录目标 URL。原生 Chrome 登录 fixture 已拦截 `/usr/bin/open`；不要为了让测试通过而静默选择取消或绕过授权。资料测试的 `interactive-400` 表示数据和交互场景，默认也隐藏窗口。

确实需要查看界面时，明确设置 `MOTE_TEST_SHOW_UI=1`，例如：

```sh
MOTE_TEST_SHOW_UI=1 npm run test:ui -w @mote/desktop
```

此开关只用于测试进程，会显示 fixture 窗口并允许原生提示；已有生成 dialog/browser 响应仍按各测试原有逻辑处理。自动化 agent 在需要前台 UI、系统授权或人工操作时，应先说明原因和影响；用户明确要求展示时直接按要求执行。隐藏模式不能代替原生焦点、菜单、系统授权等必须前台验证的行为，未执行的检查应单独报告。

Android instrumentation 和 ADB UI 验证优先连接专用、无窗口的 `mote_fixture_api35` 模拟器。以下命令在另一个终端启动它（SDK 路径按本机配置调整）：

```sh
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
  "${ANDROID_HOME:-$HOME/Library/Android/sdk}/emulator/emulator" \
  -avd mote_fixture_api35 -port 5580 -no-window -no-audio -read-only -no-snapshot-save
adb -s emulator-5580 wait-for-device
adb -s emulator-5580 shell getprop sys.boot_completed
```

确认 `sys.boot_completed` 返回 `1` 后，再执行 [Android 说明](android.md) 中带明确 serial 的安装、instrumentation 或页面采集命令。`-no-window` 隐藏的是主机上的模拟器窗口，Android Activity 仍可在虚拟设备内部前台运行；不要把 Activity 压到后台，否则不能验证实际页面。`-no-audio` 禁止声音，`-read-only` 和 `-no-snapshot-save` 避免写回 AVD/快照。端口占用时选另一空闲偶数端口并同步更新 serial；不要停止不属于本轮测试的模拟器。

模拟器会自动读取启动进程的 `http_proxy`，并可在虚拟网络层重定向 TCP；Android 全局代理显示为空也不能排除这一点。上面的命令仅为生成 fixture 的模拟器移除继承的代理变量，避免本机 Central 请求被送往代理；不修改宿主机代理设置。

现有 Android E2E 脚本连接已启动的模拟器，不负责启动或隐藏已有窗口。不要对正在使用的真机直接执行会切换页面的测试；需要真机或系统权限交互时，单独安排和报告该验证。本轮结束后只清理本轮创建的测试进程和临时目录。

