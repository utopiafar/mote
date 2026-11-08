# Monorepo 内独立发布

2026-10-01：源码继续保留在一个 npm Monorepo，版本对应用户实际独立升级的产品。一次协议修改仍能在同一个 PR 中原子调整所有端，但每个发布标签只构建和分发一个产品。

| 发布边界 | 内容 | 何时发版 |
| --- | --- | --- |
| Central | server、web、编入该部署的 agent runtime 与中央插件 | 中央行为、网页或部署依赖变化 |
| Desktop | Electron collector、原生助手和本地依赖 | macOS 客户端需要升级 |
| Android | Kotlin collector、原生库和打包资源 | Android 客户端需要升级 |
| Protocol | 跨平台传输契约及生成 fixture | 契约变化，验证受影响产品 |

首发正式支持 Central、macOS 与 Android。iOS 是实验客户端，不属于正式支持矩阵，也不是独立发布边界；中央源码发布包是否包含 `apps/ios` 由 owner 发布时决定。

Central 的网页由中央部署提供，保留 server/web 的同版本构建检查。桌面与 Android 的已安装版本则可以长期落后或领先中央，不能以三者产品版本相同作为兼容条件。根 package.json 没有产品版本，共享内部 workspace 包保持私有，构建时由产品带入对应提交的实现。

```mermaid
flowchart LR
  Repo[一个 Monorepo] --> Central[central-vX.Y.Z]
  Repo --> Desktop[desktop-vX.Y.Z]
  Repo --> Android[android-vX.Y.Z]
  Central --> Source[中央源码包]
  Desktop --> ZIP[Mac Prod ZIP]
  Android --> APK[Android Prod APK]
  Contract[Protocol v1] --- Central
  Contract --- Desktop
  Contract --- Android
```

兼容范围由 [protocol/contract.json](../protocol/contract.json) 声明，当前为 `{min:1,max:1}`。Central 的公开健康接口声明协议范围；新客户端在连接自检时主动请求协议元数据，校验范围交集，缺失或错误的元数据会拒绝连接。原有 ingest/ownSources/archiveRead 能力继续反映当前凭据的实际授权，ingressVersion 保留已有的批量接收子协议约束。任何资料内容都不能改变客户端、Agent 或发布器的权限。

当前只接受声明的 wire 1 / Ingress 2 契约，不保留旧字段读写或迁移期接口。破坏契约的修改应同步调整受影响消费者与 fixture。平台 feature inventory 与来源 capability registry 继续描述实际安装能力；产品版本号不能用来猜测设备能做什么。TS、Kotlin 与连接链路共用生成的协议 fixture，真机和真实模型验证另行记录。

Dev 分支构建保存 Actions Artifact；Android / Desktop Dev 从可信 main 手动构建后另发独立且不可变的 Pre-release，直接下载 APK / Mac ZIP。Android 强制 Development 单测；Desktop 强制组件检查和打包后 smoke。Central Dev 仍仅保存 Artifact。Beta / 正式组件版本标签使用 Prod 身份并强制组件测试。三个工作流分别匹配三个组件版本标签前缀。版本脚本只递增选中的产品；Android Prod versionCode 随 Android 升级单调递增，CI Dev 使用独立的 workflow run number 版本码。CI 根据 workspace 依赖图和非 npm 构建输入选择检查范围：共享协议检查全部端，中央插件只检查 Central。根配置、lockfile 或未知构建输入采取保守的全消费者检查。各端发布 workflow 只检查对应组件与发布工具；纯文档（含 AGENTS.md 和各语言 README）不触发应用构建。本地 `npm run check:affected` 与 CI 共用选择规则，额外用户流程验证见[开发指南](testing.md#early-integration-and-candidate-checks)。测试范围和发布范围分开，CI 检查通过不会替任何端自动发版。

历史统一标签仍可作为发布记录阅读。当前更新器只读取所属组件标签和明确声明组件的签名清单，拒绝统一旧流及缺失组件。当前发布不附签名清单，仍由用户手动安装。签名验证与安装身份校验是当前功能，不能用旧清单兜底。

中央源码发布包含构建所需工作区及锁文件，在独立目录安装依赖、构建 server/web 后，沿用现有 profile 的备份、切换和回退流程。它不把用户配置、密钥、模型权重或归档数据编入产物，不创建新的镜像发布通道。

未来若将 iOS 转为正式产品，或出现新硬件实现，需要新增产品组、安装身份和对应平台的协议测试。中央插件沿用现有 manifest、权限与宿主 capability 契约，在可独立加载升级之前仍随 Central 构建；本次不引入插件市场或承诺插件热更新。外部社区设备、SDK 或插件有独立维护与授权需求时，再考虑单独仓库。

默认插件组合的候选产物由手选脚本验证，不进入普通测试或现有发布 workflow：

```sh
node scripts/plugin-distribution.mjs all --package-mac
```

脚本把 Central、Web、Mac、Android 的构建结果和 `plugin-distribution.json` 写到被忽略的 `artifacts/plugin-distribution/`，检查各端默认包/feature/依赖与内置 owner，故意用不匹配的插件契约版本确认返回具体 `version_mismatch` 而不是假成功；随后把 Central 产物复制到临时干净目录启动，验证完整默认 feature、生成笔记读回，并从打包 SDK 创建、构建、安装样例。Android 需要 JDK 17–24 与 SDK 36，Mac 打包需要 macOS。产物只作构建/阶段验收证据，不签名、不发布，实际发布仍走上表 workflow。

实际操作见 [发布流程](releasing.md)，保留本地配置的升级步骤见 [更新说明](updating.md)。
