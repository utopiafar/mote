# Agent 运行时的真实模型手选验收

本页说明 A16③ 的手选入口 [`scripts/agent-runtime-live-acceptance.mjs`](../scripts/agent-runtime-live-acceptance.mjs)。它只用于显式手选的真实模型与网络验收，不进入普通 `test` glob，也不替代 [testing](testing.md) 中的 fixture、真实 SQLite/HTTP、物理设备或语义质量证据。

## 与 fixture 矩阵的关系

- [`scripts/agent-extension-matrix.mjs`](../scripts/agent-extension-matrix.mjs) 使用生成 fixture 验证插件、Hook、factory、重启和 Host 委派等结构闭合，不调用真实模型。
- 本脚本使用真实 provider 调用，只验证当前选择下的查询、工具、引用、工作任务或重启路径。两者可以相互补充，但 fixture 通过不能推出 live-model 通过。
- 未选择、未实现或未覆盖的项目在报告中逐项标记为 **未验证**，不能写成通过。

## 前置

1. 构建 Agent 产物；本脚本直接加载 `packages/agent/dist`，不通过 `tsx` 读取源码。
2. Codex 需要当前系统用户已安装并登录 Codex CLI。Mote 使用 `codex app-server` 的独立临时 home，只链接登录文件。
3. DSH/HTTP 需要显式提供模型服务凭据。脚本只从环境变量读取密钥，不接受命令行明文密钥。
4. 所有资料均为脚本内生成的虚构记录；不要指向个人资料库、生产节点或真实截图。

```sh
npm run build -w @mote/agent
```

## 命令

脚本没有默认 provider、默认模型或默认预算。缺少 `--provider` 或 `--budget-ms` 时以非零状态拒绝运行；`--model` 也必须显式给出，避免静默替换真实模型。`--provider codex` 选择 Codex App Server；`--provider dsh`/`deepseek` 选择 DSH HTTP。其他 HTTP provider 名称（如 `openai`、`anthropic`）必须同时给出 `--protocol`，不会被猜成某个路由。

### Codex App Server

```sh
node scripts/agent-runtime-live-acceptance.mjs \
  --provider codex \
  --model gpt-6.1-terra \
  --budget-ms 180000 \
  --reasoning low
```

`--model` 必须是本机 `codex app-server` 目录中的准确模型 ID。可用 `MOTE_CODEX_BIN`、`MOTE_CODEX_HOME` 指定已有的可信可执行文件和文件登录目录；报告不会读取或输出登录内容。

### DSH HTTP

```sh
MOTE_MODEL_API_KEY='...' node scripts/agent-runtime-live-acceptance.mjs \
  --provider dsh \
  --protocol deepseek \
  --model <provider-model-id> \
  --budget-ms 300000 \
  --reasoning high
```

对于 `deepseek` 协议，也接受 `DEEPSEEK_API_KEY`。其他协议使用 `--protocol` 显式选择，并用 `--base-url` 指定服务基址；provider 名称本身也可以是具名 HTTP provider（例如 `--provider openai --protocol openai-completions`）。远程地址必须是 HTTPS；只有 `localhost`、`127.0.0.1` 和 `[::1]` 允许 HTTP。需要免密 loopback 模型时，必须显式加 `--allow-unauthenticated-local`，不能依赖“本机地址”自动放行。

### 常用选项

```sh
# 查看矩阵，不调用模型
node scripts/agent-runtime-live-acceptance.mjs --list

# 同时运行所有已实现的项
node scripts/agent-runtime-live-acceptance.mjs \
  --provider codex --model gpt-6.1-terra --budget-ms 180000 \
  --only all

# 只运行工作任务，并把 JSON 报告写入手选路径
node scripts/agent-runtime-live-acceptance.mjs \
  --provider codex --model gpt-6.1-terra --budget-ms 180000 \
  --only working-context \
  --report .mote/agent-runtime-live/working.json

# 只打印 JSON，不写默认报告文件
node scripts/agent-runtime-live-acceptance.mjs \
  --provider codex --model gpt-6.1-terra --budget-ms 180000 --json
```

`--budget` 可作为 `--budget-ms` 的别名；两者同时出现且值不同会被拒绝。`--budget-ms` 是每个选中项的 Agent 总执行预算，传给 `agentTimeoutMs`，不是 provider 账单上限，也不是排队时间。`--max-tokens` 只约束 DSH 的输出预算；Codex 的输出由 Codex 管理。`--max-tool-calls` 为本次手选运行提供额外的工具循环上限。

## 验收项

| ID | 默认 | 说明 |
| --- | --- | --- |
| `query-evidence` | 是 | 真实模型在生成资料中检索，调用只读 `search_context`/`timeline` 与 `evidence`，返回当前记录的时间并引用该记录。 |
| `working-context` | 否 | 真实模型执行 `working-memory` 压缩，不读取归档、不产生引用，并保留已拒绝的云端部署决定。 |
| `restart` | 否 | 关闭后以新的 Agent host/profile 重复查询，两次运行都通过且 run ID 不同。 |
| `budget-deadline` | 否 | 本短运行器不执行真实 provider 的超时故障注入；确定性预算契约见 `packages/agent/test/active-budget.test.mjs`，真实超时另做手选故障运行。 |
| `cancel` | 否 | 现有 fixture 覆盖取消；真实 provider 的取消仍是独立手选旅程。 |
| `image` | 否 | 需要生成图片和图片披露证据；本运行器不发送图片。 |
| `import` | 否 | Import workspace、预览和最终 manifest 使用独立入口，例如 `scripts/test-codex-provider-live.ts` 和 Agent import host fixtures。 |
| `host-delegation` | 否 | 委派子循环与重启恢复使用现有委派 fixture 或 `scripts/agent-extension-matrix.mjs`。 |

默认只运行 `query-evidence`。`--only <id>` 可以重复或使用逗号分隔；`--only all` 只运行当前已实现的项。选择本短运行器不实现的项会直接拒绝，而不是伪装成已运行。

## 报告与状态

- 默认报告写入 Git 忽略的 `.mote/agent-runtime-live/<timestamp>-<provider>-<model>.json`；`--report` 可改路径，`--json` 只输出标准输出（同时提供 `--report` 时仍写文件）。
- 每项状态为 `passed`、`failed` 或 `unverified`。`unverified` 在报告和终端中标记为 **未验证**，并写明“未选择”、“本运行器不执行”或“前一项失败后未运行”等原因。
- 任一选中项失败时退出码为 1；参数、provider、预算或凭据前置错误时退出码为 2；只有选中项全部通过且没有失败时退出码为 0。未验证本身不伪装成失败或通过。
- 报告只包含生成资料、模型/协议/预算、工具名、引用 ID 和生成回答；不包含 API key、登录文件、真实 archive 路径或环境变量值。

## 证据边界

真实模型通过一次工具循环、返回合法引用，只证明这次 provider 协议、Host 校验和生成资料链路通过；不证明语义质量、召回率、长期稳定性或费用。一次手选运行是固定生成输入上的样本，不是基准。物理设备、外部账号、个人 archive、图片质量和 Import 语义仍需分别记录。

未执行的项必须保留为 **未验证**。修复后只重跑被代码、fixture、provider 或环境变化失效的项，并记录实际命令、模型、预算、耗时和适用范围；不要用 fixture 结果替代 live-model 证据，也不要把历史通过写成当前版本的结果。
