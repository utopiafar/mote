# Agent运行时的手选真实模型检查

[运行器](../scripts/agent-runtime-live-acceptance.mjs)仅用于明确选择的真实模型/网络检查，使用生成资料，不进入普通test glob。fixture矩阵由[agent-extension-matrix](../scripts/agent-extension-matrix.mjs)验证，两类证据分开。

## 选择与命令

需要已构建的Agent、可用Provider及明确模型。脚本没有默认provider、模型或预算；缺少参数返回非零，不猜路由或更换模型。

```sh
node scripts/agent-runtime-live-acceptance.mjs --list
node scripts/agent-runtime-live-acceptance.mjs \
  --provider codex --model your-model-id --budget-ms 180000 --reasoning low
node scripts/agent-runtime-live-acceptance.mjs \
  --provider dsh --protocol deepseek --model your-model-id --budget-ms 300000
```

Codex使用当前系统用户的CLI文件登录，`MOTE_CODEX_BIN`、`MOTE_CODEX_HOME`可指定已有运行时。HTTP密钥从`MOTE_MODEL_API_KEY`读取，deepseek也接受`DEEPSEEK_API_KEY`，不接收命令行明文密钥。其他HTTP provider显式给出protocol；远程HTTPS，本机免密还需`--allow-unauthenticated-local`。

默认只跑`query-evidence`。`--only`可重复或逗号分隔，`all`只选择已实现项；`--report`指定忽略目录报告，`--json`只打印JSON，另给report时仍写文件。

| 项目 | 入口与范围 |
| --- | --- |
| query-evidence | 生成资料检索、实际工具、时间与引用 |
| working-context | 工作记忆压缩，不读归档、不产生引用 |
| restart | 关闭host后以新profile重复查询，区分run身份 |
| budget-deadline、cancel、image、import、host-delegation | 本短运行器不实现，选择即拒绝；使用对应fixture或专用检查，不伪装成已运行 |

`--budget-ms`（别名`--budget`）是每个选中项的实际Agent执行预算，不是账单或等待时间；冲突值被拒绝。`--max-tokens`仅约束DSH，Codex自行管理输出；`--max-tool-calls`提供本次额外循环上限。

## 报告

默认写`.mote/agent-runtime-live/<timestamp>-<provider>-<model>.json`。状态为passed、failed或unverified；选中项失败退出1，参数/凭据错误退出2，选中项全部成功才退出0。报告保留模型、协议、预算、生成内容与实际引用，不记录密钥或登录文件。

一次成功只证明该输入上的Provider协议、工具及宿主校验，不代表一般语义质量、召回率、费用或真机行为。检查选择与结果复用见[验证规范](testing.zh-CN.md)。
