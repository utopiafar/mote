# 插件中心

插件中心管理包、配置实例和实际运行状态；资料来源管理账号、读取范围与同步；模型设置管理Memory当前方案及自动处理。这些入口共用现有宿主，不各建一套授权或任务系统。

当前随Central分发的Gmail、Google Calendar、飞书与录音连接器可以独立启停。关闭停止路由、定时和新增读取，保留账号、位置与归档；重启先读取持久选择，恢复沿原范围继续。当前UI不为归档/鉴权等必需组件提供关闭按钮，这不限制MVP继续拆分、替换或重构组件。原生能力仍随客户端构建，主题与布局采用[设计](design.md)中的可信展示边界。

## 安装、配置和启用

| 状态 | 含义 |
| --- | --- |
| 预览/安装 | 固定release、commit、制品散列及访问/依赖声明，登记经过校验的包；不创建默认实例、不扫描历史、不调模型。 |
| 配置实例 | 按schema填写地址、模型预设与已有凭据引用；保存不等于连接核验。 |
| 核验/启用 | 实际能力检查通过后才可选择方案；期望启用与实际ready/blocked/failed分开。检查本身可能启动服务或调用所选模型。 |
| Memory准备/应用 | 明确历史范围及实际费用，迁移核验后另行应用；启用不自动接管正文权威。 |

worker和native共享build/instance控制投影。操作带`operationId`和`expectedRevision`；断线重试保留原身份与body，冲突先读取当前事实，不能把旧请求改成新授权。只有owner可以管理，collector、MCP与只读查询Agent无此权限。页面刷新不代表服务重启或任务完成。

当前支持内置、受控外部正文/检索模块和固定适配的完整引擎；具体可安装版本以目录和实际核验为准，不靠包名推断兼容。通用source/processor仓库外开发使用[插件SDK与plugin-dev](plugin-development.md)，不与Memory worker ABI混用。通用生产安装能力仍按实际宿主支持判断。

## 制品与worker合同

固定GitHub兼容release使用`mote-plugin.json`：schemaVersion、包身份/version、`runtime: "worker"`、相对entry、同release ZIP与SHA-256、capabilities、无代码configuration、dependencies和access。解析器检查来源、路径与资源边界；安装不执行任意bootstrap、npm lifecycle或shell。兼容适配器和所需依赖须实际分发。schema见[plugin-release.ts](../apps/server/src/plugin-release.ts)。

当前通用Memory worker导出`createMemoryProvider(configuration)`，通过JSON-lines子进程完成health、put、read、remove、search、export及close。精确namespace为owner/instance/bindingRevision，键为memory/version/fingerprint。实现需持久不可变正文、限定键读取和幂等恢复；声明engine不等于实现完整引擎。`GET /api/plugins/host-capabilities`报告当前宿主能力，release声明与实际实例核验分开。

每个调用有独立取消信号。宿主停止等待并隔离迟到结果，但已发远端写入不一定回滚；按同一操作日志对账后重试。可信worker和服务不是恶意代码沙箱，声明不构成强制网络/文件隔离。动态包不注入任意远端UI代码。

## Memory权威与切换

宿主拥有原件、Material、权限、有效性和发布事务；绑定repository提供正式正文。读取、导出、问答固定binding和精确版本，并核验当前隐私/删除。provider不可用或正文被改写时明确失败，不用旧SQL副本掩盖。

更换repository迁移Mote保留的正文、修订、更正/替代和删除意图，验证后通过CAS另行应用；失败保留旧binding，无自动fallback。外部原生审计历史/图不承诺跨引擎迁移。原始绑定仍被查询、准备、排空或未知写入引用时不能卸载，数据删除是独立操作。

外部完整引擎的原生输出是提案，不直接成为生效Memory。当前实现仍要求共享独立审核；已确认方向由模型或所选记忆方案判断是否额外复核，不把现行强制双调用写成长期插件规则。正常发布仍校验精确原件、当前权限、版本与删除意图，见[Memory](memory.md)。

当前全暂停停止新自动准入并排空已有授权工作；立即停止另行撤销未完成发布权。现行恢复generation不自动补授暂停期间输入，与已确认补处理积存的方向存在差距。独立手工任务/洞察保留各自授权，原件保存和查询不因暂停Memory停止。

来源删除立即撤回可见性和再生产，清理相关宿主暂存正文，未知外部写仅留精确对账/清除身份，不重新put。逻辑不可见、endpoint接受和物理擦除完成分别报告；外部history、数据库/WAL可能仍留字节。原生临时空间清理有独立持久任务，不因清理重试重做已合法审核的输出。

## 控制入口

`/api/plugins`负责包/实例/目录，`/api/plugin-builds`负责统一build选择与停用，`/api/plugin-instances`负责配置、check与enable/disable。`/api/memory-spaces/default/binding`提供当前方案及pause/resume/stop/prepare/activate/retry/cancel。准确参数由当前路由和shared schema定义；安装、配置、绑定分别核对revision。

生成SDK/worker/HTTP/UI合同测试验证宿主边界；真实GitHub制品、供应方/模型、renderer、原生UI与物理设备各自需要证据。验证按[测试规范](testing.zh-CN.md)选受影响路径，不把本页变成每次开发的固定流程。
