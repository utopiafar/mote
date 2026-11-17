# 开发入口

[English](development.md) · **简体中文**

按要修改的模块选择入口。[架构](architecture.zh-CN.md)提供代码地图，各 app 的 AGENTS 提供简短的平台约定与定向命令。

## 选择开发目标

| 目标 | 必要准备与入口 |
| --- | --- |
| Central / Web | Node.js 24 和 npm；按下方步骤启动中央与网页热重载。 |
| 采集端 | 只准备所选平台的原生工具和独立开发 App，平台命令和限制见 [Mac](../apps/desktop/AGENTS.md)、[Android](../apps/android/AGENTS.md)。 |
| 插件与来源接入 | 使用现有 SDK 和示例，按 [插件开发](plugin-development.md) 准备；需要原生能力时才进入对应采集端路径。 |

## Central / Web 本地开始

使用 Node.js 24 和 npm。在仓库根目录执行：

```sh
npm ci
node scripts/mote.mjs init --profile dev
npm run dev
```

`npm run dev` 构建共享库，再启动 Central 与 Web 热重载。dev 中央默认 47842，Web 默认 5173。已有 dev 后台中央时先停止，避免争用同一 profile。重复 init 会拒绝覆盖已有环境。

初始化不选择可用模型，也不继承模型 key；需要 AI 时明确配置所用模型。采集、浏览和普通界面开发可以先不接真实模型。本地开发不以 Tunnel、Android SDK 或 Mac 采集权限为默认前置。

已构建中央并配置命名 Tunnel 时，`npm run up` 可运行中央和隧道；它不构建、不启动采集，也不创建域名路由。Mac 的独立开发 App 使用 `npm run desktop:dev`；构建和权限条件见[Mac指南](desktop.md)。

## TypeScript 检查与构建

`npm ci` 后直接运行 `npm run typecheck`，或选择 workspace，例如 `npm run typecheck -w @mote/server`，无需先运行 `build:libs`。根 solution 与 workspace 命令使用 [TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references.html)，先生成缺失或变更的库声明，再检查消费者；依赖出错会停止下游项目。根检查和 Web 检查也运行现有 architecture 守护，包括 `browser-no-node`。

引用关系对应实际包导入：

| 项目 | 直接引用的库 |
| --- | --- |
| plugin-api | 无 |
| plugin-host | plugin-api |
| plugin-sdk | plugin-api、plugin-host |
| shared | plugin-api |
| agent | shared、plugin-api、plugin-host |
| diagnostics | shared |
| Server | agent、plugin-api、plugin-host、shared |
| Web | shared |
| Desktop | diagnostics、shared |
| scripts | agent、shared；原有相对路径 app/fixture 导入仍由脚本检查覆盖 |

消费者读取引用库刚生成的声明。Server 与 Desktop 使用独立的 `noEmit` 检查配置，构建配置分别保留 NodeNext 与 CommonJS 输出；Web 保留 Bundler 解析和 `noEmit`。solution 还检查 plugin-api 原有的公共类型 fixture。库产物及其构建信息放在 `dist`，检查缓存放在 `node_modules/.cache`；Agent 的 `.mjs` 插件入口纳入项目输入，依赖构建也会生成该运行资产。

`npm run build:libs` 保留为同一引用图的便捷入口。普通 workspace 构建仍执行原有资产复制和打包；并行构建应使用独立 checkout 与依赖目录。

## 宿主配置登记

Server现有 `ConfigurationPlatform.registerDomain` 和 `ConfigService.registerPlugin` 要求用 `updatePaths` 显式声明插件配置的原始输入路径。可用点路径、现有 `*` 通配符，或按原始候选分支选择路径的纯函数；这是Server Host登记合同，不是新的公共SDK导出。值与完整候选继续由现有schema和事务验证，不再遍历Zod `_def` 推断输入成员。

未知路径在resolve、raw验证和preprocess之前拒绝，文件重载同样受检。可选 `rawInputSchema` 保留独立输入验证与类型作用，它的变换／默认值结果被丢弃，只保存插件原始输入。通配开放范围、分支替换和当前显式声明要求见[配置参考](server-configuration.md#宿主登记的插件领域输入)。

Server可信领域代码可将登记时的 `{id, schema}` 引用传给 `ConfigService.current(reference)` 和 `setHandler(reference, prepare)`。两者都核对已登记id和同一个schema实例，TypeScript从该schema推导已验证输出和handler参数。读取返回独立副本的effective值，不重新解析输入或展开凭据。Activity已通过此合同读取前瞻接纳策略。引用本身不授予配置访问权，普通插件仍使用原有的领域配置端口；其他字符串消费者与剩余扁平Config／YAML双向投影仍待收敛。

## 环境与资料

dev、test、prod 使用独立配置、令牌、数据库和 App profile。测试中央默认 47852；prod 默认 47832。CLI 的 `--home /absolute/private/profiles` 可选择另一套隔离环境。测试只用程序生成的资料与私有临时环境；不用正式资料、实际屏幕或日常设备作为自动化素材。

私有配置和凭据不入 Git。开发中的 Mote 凭据保存在私有 profile；正式环境使用系统保护；第三方 CLI 管理自己的凭据。跨设备部署使用 HTTPS 和强令牌。

## 格式与升级的阶段

当前MVP只维护一个线协议和存储格式；未明确要求时不增加迁移、旧格式读取或双写。不兼容时拒绝打开并保留旧数据，不自动清空。未来面向长期使用，需要提供保留资料的升级办法；不能把MVP例外写成永久产品承诺。

## 修改与协作

- 自行决定实现细节，复用现有术语、组件、SDK 和任务基础，按实际需求迭代接口与实现。
- 类型检查自动构建引用库；只需要库运行产物时可运行 `npm run build:libs`，共用输出目录的构建应串行安排。
- 新增 `moteText` 源文案时补齐六份目标语言目录，再运行 `node scripts/sync-i18n.mjs` 与 `npm run check:i18n`。
- 跨模块工作尽早接通一条最短真实路径，使用真实入口和生产者／消费者；独立模块才适合分工，同一模块不并行重复实现。
- 对外行为、接口、开发命令或有效约束变化时，同次更新现行文档及中英文版本；内部重构不额外制造文档任务。

## 验证与交付

在已有授权范围内自行决定实现与交付方式，不设置统一的任务阶段。

按[验证规范](testing.zh-CN.md)选择最小有效检查。PR 说明行为变化、实际运行或复用的检查、未验证范围；完整日志保存在 CI 或忽略目录。不新增每任务报告、验收台账或重复说明。

操作参考：[测试规则](testing.zh-CN.md)、[CI](ci.md)、[后台UI与模拟器](testing-runbook.md)、[插件](plugin-development.md)、[多语言](internationalization.md)、[发布](releasing.md)。

配置与操作：[服务端配置](server-configuration.md)、[CLI文件导入](files.md#cli-import)、[诊断](troubleshooting.md)。
