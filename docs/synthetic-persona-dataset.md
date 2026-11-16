# 合成验证资料

按[验证规范](testing.zh-CN.md)选择所需案例。两套资料均由固定代码创作，不读取个人资料；数据、脚本和评判标准保留，普通开发不默认运行整套回放或真实模型。

| 案例 | 规模与用途 | 源码 |
| --- | --- | --- |
| 林照／折光书签 | 7天，12项直接接收、8篇日记、4条录音、10次文件版本上传、16个问题；生成包43个文件 | [生成器](../apps/server/scripts/persona-fixture.mjs)、[故事与素材](../apps/server/test/fixtures/persona) |
| 林舟／ORBIT | 45天、1080条原件，其中45篇日记；验证范围、迟到时间、检查点及独立语义评审 | [资料](../scripts/fixtures/persona.ts)、[确定性检查](../apps/server/test/persona-memory.test.ts)、[评审标准](../scripts/judge-persona-luna-live.ts) |

## 林照：生成与离线回放

需要Node 24+、npm依赖、shared/Agent构建及匹配Node ABI的SQLite。目标目录必须是新目录。

```sh
node apps/server/scripts/persona-fixture.mjs generate --output .mote/fixtures/linzhao-v1
node --import tsx apps/server/scripts/persona-fixture.mjs replay \
  --dataset .mote/fixtures/linzhao-v1 --run .mote/fixtures/linzhao-v1-offline
```

省略`--run`使用新建临时目录。回放不接受已有Central或profile，使用真实HTTP、SQLite、导入器与录音解析器，检查授权、ACK/重传冲突、原件字节、Unicode、事件时间、版本与重启。离线导入使用预构造的模型结果：`transport:passed`不表示语义通过。

只按生成包的`manifest.json`选择输入。`evaluation/`是答案与评分规则，不导入或提供给待测模型；ZIP与其解压目录也不重复导入。包内README说明入口、格式和边界。默认音频是测试音/静音；macOS可显式加`--speech --voice <已安装voice>`生成语音，不下载或回退语音，也不证明多真人说话人识别。

需要查看隔离网页时，构建Web后为回放加`--serve`。服务监听随机loopback端口；连接信息和token只写运行目录。结束时Ctrl-C。

## 显式选择真实模型

仅在要求实际模型验证时运行。林照回放固定本机Codex的`gpt-6.1-terra`、`high`、普通速度：

```sh
node --import tsx apps/server/scripts/persona-fixture.mjs replay \
  --dataset .mote/fixtures/linzhao-v1 --live-model --memory \
  --questions current-arrangement,local-midnight,specific-lesson,visual-original,source-scope
```

`--memory`只为所选直接接收内容和日记创建任务；题目按实际可用证据选择，缺失项记为`not-tested`。图像题使用参考资料入口和真实像素；严格证据入口不冒充图像工具。模型输出、引用和用量保存到运行报告，语义仍需评审。`MOTE_CODEX_BIN`、`MOTE_CODEX_HOME`可选择本机运行时及凭据位置，凭据不进入数据包或prompt。

林舟的确定性检查处理全部1080条、54批；fixture模型返回空记忆，只证明执行正确性。真实评估提取45篇日记，并查询完整归档，不对1035条被动观察作实时提取：

```sh
MOTE_PERSONA_REPORT=/tmp/mote-persona-report.json node --import tsx scripts/test-persona-luna-live.ts
node --import tsx scripts/judge-persona-luna-live.ts /tmp/mote-persona-report.json
```

此脚本固定`gpt-5.6-luna`、`max`，独立评审无工具；初次失败和非零退出状态保留。`MOTE_PERSONA_ALLOW_PARTIAL=1`允许失败后的部分评估，整体仍为部分结果。高级恢复参数`MOTE_PERSONA_RECOVERY_VAULT`、`MOTE_PERSONA_RETRY_JOB_ID`、`MOTE_PERSONA_PRIOR_REPORT`只用于生成资料的隔离副本；历史恢复不冒充新的默认通过。

## 评判与边界

| 关注点 | 例子 |
| --- | --- |
| 主体与来源 | 同事的经历、第三方文章不写成所有者经历；保留原文引用及推断性质。 |
| 时间与变化 | 内容日期与上传时间分开；改期保留旧决定和当前有效安排。 |
| 具体用途与结果 | ORBIT的outbox/幂等、原件14天／统计60天、120条／7次重试及周三15:00修订，不能缩成泛泛的效率建议。计划、提议和完成分清。 |
| 图像与观察 | 需要像素时实际读图；采集时长按观测计算，不从截图间隔推导注意力。 |
| 权限 | 原件中的指令不执行；范围隔离和撤权真实生效，测试不外发真实消息。 |
| 结论 | 区分`pass`、`fail`、`not-tested`及成功空结果；不以记忆条数、逐字答案或模型自评代替质量。 |

林照的详细问题和评分表随数据包生成；林舟的完整准则保存在评审脚本。原生权限、真机后台行为、第三方登录、ASR/OCR质量和真实MCP接入另按需要验证，离线回放不能替代。

生成包、数据库、token与模型报告留在忽略目录或私有临时目录；分享生成方法或纯合成输入。故事或输入契约改变时使用新fixture ID，不用个人材料改名充当合成数据。
