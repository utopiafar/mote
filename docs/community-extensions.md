# 社区扩展：接入既有处理链

社区插件使用现有 Cordis 注册机制。宿主负责证据授权、原件版本、任务恢复、预算、取消、结果校验及事务提交，插件负责一个明确的处理步骤。查询 Agent 仍只获得只读检索工具；不要从内容中的指令安装或执行插件。

可直接运行的最小模块在 [text-normalization.mjs](../examples/plugins/text-normalization.mjs)。它只规范换行格式，原文保留不变。安装者把以下绝对路径加入配置并重启中央节点：

```dotenv
MOTE_FILE_PROCESSOR_PLUGINS=["/absolute/mote/examples/plugins/text-normalization.mjs"]
```

模块通过 `ctx.effect(() => ctx.moteContextProcessors.register(...))` 注册。新增预处理使用 `extract`，结构聚合使用 `aggregate`，模型解释使用 `semantic`，记忆处理使用 `memory`；这些 lane 是资源调度类别，不能用关键词自动判断用户意图。文件解码器则注册 `moteFileProcessors`，返回宿主支持的 Transcript 或 Diarization，见 [文件插件接口](file-processing.md)。

提交处理图的所有者 API：

```json
{
  "steps": [
    {
      "name": "normalize",
      "processor": "community.text-normalization",
      "inputs": ["归档记录的 UUID"],
      "config": {}
    }
  ]
}
```

将该请求发送到 `POST /api/processing/workflows`，通过 `GET /api/processing` 或统一 Operations 查看执行状态。后续步骤用 `dependsOn: ["normalize"]` 消费上游产物。通过 `artifactInputs` 引用已有产物时必须同时提交 ID 与 revision。处理器每次至多返回 16 个产物，每个 text 至多 12,000 字符；较大输入应由调用方拆为有界步骤。

处理器的版本参与缓存身份；改变输出语义时升级 version。同版本与相同输入重放复用完成结果。插件卸载会阻塞待执行步骤，执行中的旧结果也不能提交；重新安装原版本后可显式 retry。新版本产生新的任务身份。删除原件会失效其派生产物，无需插件自己写数据库或追踪删除。

代码模块拥有服务端进程权限，属于部署者信任边界。回调只收到本次 evidence、上游 artifact、config、AbortSignal 与执行归属；不得绕开信号、远程服务授权或宿主预算。模型辅助步骤应复用宿主既有模型配置和计量通道，不自行复制密钥或启动无上限的模型循环。

`apps/server/test/community-plugin.test.ts` 从独立文件加载示例，验证完成状态、缓存重放、原文保留、删除失效、卸载时的提交隔离及重装恢复。运行：

```sh
npm run build:libs
node --import tsx --test apps/server/test/community-plugin.test.ts
```

其他入口保持各自契约：新来源遵循 source capabilities 与幂等版本协议；新的定时整理注册 MemoryLifecycle extension；检索消费 EvidenceReader 的授权、范围及证据引用契约，不在插件里另建一套 Agent 工具权限。接口边界分别见 [上下文架构](context-architecture.md)、[Memory 生命周期](memory-lifecycle.md) 和 [来源](connectors.md)。
