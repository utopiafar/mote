# 第一阶段执行记录：来源审计与原生实验准备

日期：2026-10-20。目标基线：`cc5d30f8e84bff9276b4487ffd7254c594b154df`。
状态：**进行中；第一阶段验收未结束**。生产代码、配置、依赖与部署均未修改。

## 已交付

- 固定 12 个候选：10 个上游组件、2 个社区 Bundle；保存版本/来源及摘要。
- 审计程序核对整个 lockfile Git blob 及每个 npm 条目的版本、来源、integrity。
- 原生 SDK smoke 程序：只使用生成算式、loopback 模型和原样社区计算器文件；
  先核验源码与依赖身份，再检查真实工具返回、SDK 事件与清理。
- 21 项离线测试：固定身份、来源漂移、重复样本、路径与 symlink、缺失运行依赖，
  以及“元数据通过不得提升为运行通过”的分类。
- [四阶段计划与产品边界](../../design/dsh-ecosystem-compatibility-2026-10-20.md)。

## 本次实际执行

| 检查 | 结果 |
| --- | --- |
| native-smoke.mjs 的 Node 语法检查 | PASS |
| 新增审计单测 | 21 PASS，0 FAIL，0 SKIP |
| 真实 lockfile 元数据审计 | 12 条记录完成；10 条 npm pin 与 lockfile 匹配 |
| 原生 smoke 的环境预检 | BLOCKED，exit 2：Node 22.16.0，缺少 DSH 运行依赖及已安装固定插件目录 |
| 原生插件安装/加载/调用 | NOT RUN |
| Mote 产品入口集成、跨用户、原生 UI | NOT RUN |
| 独立 Reviewer / Evaluator | NOT RUN |
| 完整 npm run check:affected | NOT RUN：当前容器缺少 Node 24 和锁定依赖，无法联网安装 |

运行环境为 Linux x64 / Node 22.16.0。离线单测只使用 Node 内置模块和生成文件。
真实模型调用为 0。没有使用个人截图、日记、账单、凭据或真实外部账号。

普通 Git clone 的 DNS 请求失败。通过 GitHub connector 下载的 Central 0.0.90
发布 artifact（12112648298）包含源码、不含 node_modules。其 package-lock.json 的
Git blob 为 `32f16233f65c47bec845bd859dc238c2a9a48d12`，与当前基线通过 GitHub
读取的 blob 相同，因此只复用其确切 lockfile 字节做元数据审计。没有把旧源码包
视作当前源码的完整运行环境。其他受影响组件测试没有借用旧发布的结果。

审计结果中的 `runtimeExecuted` 为 0，`compatibilityRate` 为 null。
附带的结果文件只记录本次实际执行，后续成功运行应另存新收据。

## 复现

在当前仓库执行离线审计与新增单测：

```sh
node --test scripts/release/dsh-compatibility.test.mjs
node scripts/dsh-compatibility/audit.mjs
```

完成项目原有 Node 24 + 锁定依赖准备后，在独立受信测试目录使用上游流程安装固定
calculator Git 版本，核对 package、peer 依赖、安装器日志与生成依赖树。两个
community 包为 private，不能假设存在同名公开 npm 发布。插件与本仓库的
`@deepseek-ai/dsh-tools` 必须解析到同一份固定实现，禁止复制实现或伪造服务来通过。
然后运行：

```sh
node scripts/dsh-compatibility/native-smoke.mjs --plugin-dir /absolute/pinned/calculator
```

该脚本不运行安装脚本、不修改原包，不访问 Mote 数据；环境不满足时退出 2。
成功输出也只覆盖 `upstream-sdk-only`。安装器验证、上游 Bundle 加载与 Mote
用户流程继续分别执行和归档。

## 第一阶段剩余退出项

1. 获取用户指定市场的真实索引，固定原始字节及 SHA-256，补充独立社区/held-out 样本。
2. 实际运行 calculator、Skill、MCP 探针，依据结果修正诊断脚本的真实 API 偏差。
3. 审完其余候选的运行服务依赖，核验 Leaf Plugin 与可安装 Bundle 的区别。
4. 具体生产接线方案通过独立评审后，在真正 Mote 入口完成未修改社区插件调用，
   同时验证授权、只读查询、销毁与原有回归。
5. 运行当前候选的受影响检查，独立验收后将第一阶段 PR 转为可合并状态。

后续三阶段尚未开始；本次没有为它们建立空壳 PR，也不提前合并或发布。
