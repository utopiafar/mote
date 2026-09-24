# Slate UI 与开发版发布

本次以 Design v1 的 Slate 方案落地现有能力，未引入 iOS、插件商店、外部 MCP 持续挂载或新的权限模型。讨论文档中的成本估计、性能目标和演示数字不作为产品运行数据。

中央一级入口为今天、资料库、问一问、行动、连接。系统管理集中运行统计、上下文任务、处理器、模型、费用、存储和诊断；用户设置保留会话与语言。所有旧 hash 入口由 `apps/web/src/navigation.ts` 映射至同一业务页。资料筛选在证据打开期间保留；浏览器返回/前进恢复证据，关闭后恢复焦点。原图需要主动展开。

Mac 本机窗口保留本机采集、记录、来源和独立的隐私/连接设置。Android 复用原生 Activity 与受限中央 WebView，底部为今天、资料、问一问、本机。设备配对不授予中央所有者权限。Android 后台切换不丢弃配置草稿，离开编辑页会询问；草稿不写入系统 Bundle。

共享配色源在 `packages/shared/design-tokens.json`。运行 `node scripts/generate-design-tokens.mjs` 生成 Web/Electron CSS 与 Kotlin token。平台导航、系统权限与文件选择器仍用原生实现。

处理任务页使用 owner-only `/api/operations` 分页读取 Operation 及步骤状态；原 `/api/processing` 上下文任务入口仍保留。截图感知、文件、Memory、导入、问答、洞察、生命周期、日程分析和 embedding 已接入共享执行器，各领域保留自己的配置与进度入口。支持的操作由服务端状态确定，不返回私人步骤输入，见 [Operations](operations.md)。结果不明的日程仍走原有核实流程。

开发期发布策略：一条 DEV prerelease，只附 Mac DEV ZIP 和 Android DEV APK。CI 校验包身份、签名/证书、平台兼容性与上传完整性；`.asset.json` 等构建元数据不对外发布。已发布版本不可覆盖，失败时仅重试草稿发布。历史签名更新实现仍保留，不允许降级绕过校验。DEV 客户端使用 GitHub 手动安装入口。

测试区分：TypeScript/Kotlin 编译、单元与生成资料的 Electron 测试可以自动执行；真实设备的采集权限、后台行为、实际模型费用和质量需要独立实机验收。
