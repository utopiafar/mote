# 系统改造验收记录 · 2026-10-10

本轮按已批准的 [方案](../design/system-refactor-2026-10-10.md) 和 [ADR](../adr-system-refactor.md) 实施。查询、Memory、执行三个实现 subagent 均为 gpt-6.1-sol/high，随后交叉审查。Central 目标 0.0.85，Android 目标 0.0.83/code94；epoch4、wire1、Ingress2 保持不变。

## 环境与证据边界

macOS，Node24.15.0/npm11.12.1，Codex CLI0.159.3；模型使用本地 Codex App Server gpt-6.1-sol/high。全部输入、媒体、模型 fixture 与 vault 为隔离的生成资料，没有读取私人截图或生产库。模型报告和原始输出存放 Git 外的临时目录；这里记录结论和复现命令。

## 已执行

| 验证 | 实际结果与边界 |
| --- | --- |
| 查询工具和恢复 | Agent 240通过、1既有 live-provider skip；查询服务52通过、Unicode/Material10通过。涵盖两个适配器原生图片、严格目录/version/schema、隐藏端点拒绝、范围/预算、私有 workspace、恢复后新交付和引用失效。 |
| Memory 模块 | 定向46+38测试及阶段/策略回归通过。完整未饱和合同复用、旧v1保守提取、审核阶段恢复、空结果独立审核、多配方取消与覆盖、逐成员时间/归属。 |
| 大导入 | `memory-import-background.test.ts` 经真实认证路由及生产5秒后台 workers处理1,000原件；首7条在导入未结束时审核，最后1条独立尾包处理；所有目标唯一覆盖，规划0，生成/审核按实际包数各一次。包数随就绪到达顺序变化，不等待凑满。生成回复证明链路，不证明模型吞吐。 |
| 执行与混合负载 | 同一 ExecutionEngine 的可信 lane、父子继承、背景满载时交互准入、租约/重启/跨连接测试通过；不存在本轮新加的 provider 全局并发上限。 |
| 导入状态 | 真实 split/checkpoint 路径验证部分成员成功、失败/缺上下文、取消/撤销、修订和长范围；成功成员不会随失败 sibling 错报失败。每次投影仅解析各job一次，批量查询checkpoint，无全局状态缓存。 |
| Harness E2E | `npm run test:e2e`、`npm run test:media-e2e` 通过。实际工具适配器使用生成provider，含加密/去重/图片、精确原文、目录媒体统计、范围和便携归档。 |
| Web/Electron | `test:settings-ui`、`test:activity-ui`、`electron scripts/test-import-memory-ui.cjs` 通过。实际上传/确认，归档完成后Memory继续运行，失败/重试/完成，中英、窄屏与既有导航；没有浏览器控制台错误或页面溢出。 |
| 进程生命周期 | `node scripts/test-central-process-lifecycle.mjs` 通过。构建后的正式入口经实际 supervisor 启动，HTTP接收生成笔记，SIGTERM停止并释放PID锁，同vault重启；便携归档恢复至新vault并删除原件。 |
| 真实模型预验收 | 本地Codex真实导入9条、两包自动提取与独立审核，注入coverage错误只重跑对应审核；直接问答2arm无worker、目录查询2arm、显式研究1child、重启无重放和删除引用失效通过。首次续跑报告只作为预验收，不代表最终提交。 |
| 真实语义正例 | `test-system-refactor-memory-quality-live.ts`：带所有者控制平面声明的个人经历与第三方访谈同包；1提取+1独立审核，生成1个人Memory和1计划observation。交叉审查确认情绪支持偏好保留适用条件，已完成姊妹散步与未发生父亲谈话分离；Mira未变为所有者偏好；5个引句offset/length与原文逐一相符。 |

## 发现与修正

- 每次普通Material发布重复扫描无关积压输入。保留版本/附件父依赖 fence，内置来源按身份收窄，通用插件仍保守校验。固定生成基准中200次发布/1,000积压的selector调用从641,200降至1,200；这是同机探索值，不是生产延迟承诺。
- 全量检查最初固定要求126包，实际并发到达形成129包；断言改为完整唯一覆盖、包上限与实际调用数，保留显式首批和尾批验收，不修改生产凑批策略。
- split后已提交成员被整job失败状态覆盖，现按授权范围的完整checkpoint并集投影。
- 正常委派yield的Harness计时误标失败、独立审核诊断重复归到draft；已按实际阶段/运行身份修正。
- 正向个人Memory试验最初使用了技术经验，个人recipe正确未收录；换用预先声明的个人经历rubric，未放宽产品准入规则。缺少所有者声明的另一生成样本真实进入有限feedback后`waiting_for_input / memory_context_required`，该结果保留为需要上下文案例，不能算9条处理完成。

## 最终门槛与发布

最终 `check:local`、版本化Android检查、固定代码的独立源码安装和真实Codex复验正在执行；结果将于发布前更新。已通过的单模块/预验收不能代替该门槛。

## 未执行与限制

没有物理Android/macOS设备安装、权限或后台采集测试；没有私人语料、真实媒体识别质量、完整持留集召回或生产P95统计。小样本不能证明所有问题60秒内完成或固定token节省比例。provider内部请求数不可见，报告的是可观测Agent/Harness片段和provider用量。当前DEV发布保留手动部署流程；本轮不会自动升级本机私人vault，也不将epoch3资料转换到epoch4。
