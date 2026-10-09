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
| 独立安装的真实模型 | 源码包独立安装、构建后，经实际HTTP和生产后台导入9条，形成8+1两包；2提取+3审核，注入coverage错误只重跑对应审核。直接问答2arm各1片段、0worker；目录查询2arm无worker；显式研究1child、3片段，重启无重放、删除引用失效通过。全部原件的原文、时间、角色和修订在删除前核验。 |
| 独立安装的真实语义正例 | `test-system-refactor-memory-quality-live.ts`：带所有者控制平面声明的个人经历与第三方访谈同包；1提取+1独立审核，最终复验生成2个人Memory和1计划observation。交叉审查确认表达的家庭聚会困扰与情绪支持偏好均保留适用条件，已完成姊妹散步与未发生父亲谈话分离；Mira未变为所有者偏好；8个引句offset/length与当前原文和授权范围逐一相符。 |
| 真实Coding合同复用与计量 | `test-coding-memory-refactor-codex-live.ts`：实际认证HTTP及生产后台处理3个生成事件，原始tool正文不进入正式对话。1,541字符的完整未饱和v2合同直接复用，1理解+1独立审核、0重复提取，发布1 Coding Memory；2次实际调用对应2条独立完成回执，共25,977 reported tokens。模型为本地Codex gpt-6.1-sol/high，持续149.582秒，不能推导一般时延或成本保证。 |

## 发现与修正

- 每次普通Material发布重复扫描无关积压输入。保留版本/附件父依赖 fence，内置来源按身份收窄，通用插件仍保守校验。固定生成基准中200次发布/1,000积压的selector调用从641,200降至1,200；这是同机探索值，不是生产延迟承诺。
- 全量检查最初固定要求126包，实际并发到达形成129包；断言改为完整唯一覆盖、包上限与实际调用数，保留显式首批和尾批验收，不修改生产凑批策略。
- split后已提交成员被整job失败状态覆盖，现按授权范围的完整checkpoint并集投影。
- 正常委派yield的Harness计时误标失败、独立审核诊断重复归到draft；已按实际阶段/运行身份修正。
- 正向个人Memory试验最初使用了技术经验，个人recipe正确未收录；换用预先声明的个人经历rubric，未放宽产品准入规则。缺少所有者声明的另一生成样本真实进入有限feedback后`waiting_for_input / memory_context_required`，该结果保留为需要上下文案例，不能算9条处理完成。
- Coding真实链路发现理解阶段的producer与Agent包装器重复记账。保留producer唯一计量归属，host内部接线跳过包装器计量，所有授权/并发/超时/诊断继续执行；成功、provider失败、解析失败和取消回归通过。既有provider有限重试仍产生4次真实尝试，回归按每次尝试1条失败回执断言，不把它误报为1次调用。最终实模复验确认2次调用、2条回执。

## 实际模型结果的解释

安装代码 `4ae41ce` 的主链路报告为 `mote-system-refactor-live-ScnoXB/report.json`，正例为 `mote-refactor-memory-quality-6U8NSV/report.json`。报告存放系统临时目录，内容为生成资料。主链路在删除前两次断言全部9条完成；最终快照在故意删除第1条之后读取，8成员包因依赖失效而撤销，其余1成员包仍完成，不能把最终快照解读为导入处理失败或仍有9条有效Memory覆盖。

计量修复的固定代码为 `9b985c4`；仅纠正测试重试断言的提交为 `f15440f`，没有继续改动运行代码。Coding复验报告为 `mote-coding-refactor-live-tKQoDA/report.json`；修复前的3回执/2调用失败报告 `mote-coding-refactor-live-86qd8T/report.json` 保留。此版主链路报告将删除前完成里程碑与删除后的 `finalState` 分开保存，并保存实际用量回执。

固定代码正例复验报告为 `mote-refactor-memory-quality-VN2NW1/report.json`：生成2 Memory、1 observation，共8个精确支持片段；三张卡片都有匹配的独立审核回执。其数量与上一次正例不同，验收依据是提前声明的语义rubric、原文支持、归属及独立审核，不要求模型每次生成固定卡片数量。

固定代码主链路复验报告为 `mote-system-refactor-live-TqI4Yh/report.json`，状态passed：删除前9/9 completed；删除后状态独立记录，重启无重放与引用失效均通过。共12个实际Agent片段、13条用量回执（另含导入理解），与当前ledger逐一匹配；12条token样本完整，1条委派yield样本未完整，保留已报告用量。provider内部请求数不可见，requests=0不能理解为没有真实请求。直接问答目录/全原生分别24.690/24.345秒；来源目录查询分别30.199/23.353秒；显式研究1子任务、3片段、71.519秒。延迟结论仍仅限这次生成资料下的观察。

能力目录在本次观测中将声明工具schema从28,198减至18,709个UTF-16字符。直接问答目录/全原生分别28.333/24.775秒；目录查询分别25.257/18.705秒；显式委派84.872秒。目录在这两次小样本中更慢，本轮不声称延迟或P95改善，也不由schema缩减推导固定token节省。

## 最终门槛与发布

最终 `npm run check:local` 退出0，2,371项通过、2项既有跳过项；i18n、库构建、全workspace和scripts类型检查通过。跳过项为平台/opt-in限定的macOS sandbox测试和installed-Codex synthetic Responses测试，不能视为执行过系统sandbox验收。本轮另行执行了上述真实Codex链路。

Android `testDebugUnitTest assembleDebug lintDebug` 已通过，产物版本0.0.83/code94。固定代码 `9b985c4` 经独立源码包 `npm ci --ignore-scripts`、`build:central` 和正式入口生命周期复验通过；核验1,831个Git跟踪文件，按仓库 `.gitattributes` 还原唯一的Windows脚本CRLF后全部内容匹配。主链路实模复验已通过。最后全仓检查的1,000条真实HTTP/后台fixture回归持续140.947秒，覆盖全部目标，没有规划模型调用；该时间包含本机并发测试负载，不能视作真实模型吞吐。

发布采用PR合并后同一main提交上的 `central-v0.0.85` 与 `android-v0.0.83`，由既有组件workflow构建和核验发布资产；发布状态、实际资产SHA和安装核验在本轮最终交付中报告。GitHub的可选pre-release全组件检查开关仍维持仓库配置，不能以其跳过结果替代上述本地门槛。

## 未执行与限制

没有物理Android/macOS设备安装、权限或后台采集测试；没有私人语料、真实媒体识别质量、完整持留集召回或生产P95统计。小样本不能证明所有问题60秒内完成或固定token节省比例。provider内部请求数不可见，报告的是可观测Agent/Harness片段和provider用量。当前DEV发布保留手动部署流程；本轮不会自动升级本机私人vault，也不将epoch3资料转换到epoch4。
