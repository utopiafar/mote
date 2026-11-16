# 录音服务接入

当前接入飞书妙记、钉钉AI听记中已上传的云端记录，复用厂商转写并独立备份音频。它不接管录音笔蓝牙、不重复ASR，也不能凭云样本证明硬件按键录音和全历史覆盖。飞书与钉钉的真实账号/设备证据分别判断。

## 使用

部署先运行`npm run connectors:prepare`；Native已有profile可用`node scripts/mote.mjs connectors-prepare --profile <name>`。固定CLI及完整性由仓库的[运行时准备器](../scripts/connector-runtime.mjs)管理。凭据留在厂商CLI原有存储，不从个人Agent会话复制，也不在argv/日志暴露Secret。

在录音来源中检测环境、授权账号，选择历史起止、选填背景说明，再启用。当前初始日期默认过去30天，终点空则持续同步；更广的首次历史方向见[来源](connectors.md)。连接本身不启用采集。当前范围是账号创建的云记录，不能保证只含指定硬件型号；厂商创建时间也不等于实际录制时间。

转写先归档成完整Material，音频后台单独备份。音频失败不阻塞正文/Memory；补齐音频不再提取相同正文。查看/回听使用Central已归档原件，不把短期厂商URL当永久备份。暂停、断开或厂商删除保留Mote历史，列表漏项不作为删除。

来源说明是可修改的版本化背景，作用于已有及未来资料；单份纠正优先。匿名说话人不是账号本人，不按说明中的关键词把整份录音归主。模型保留主体、事件时间、计划/事实和不确定性；只在确有需要时问用户，不逐条强制打标签或推送。

## 同步与恢复

账号哈希、厂商条目ID、适配版本和授权epoch固定工作身份。每次远端读取与发布均复核账号/范围；更换账号须重新连接，暂停或范围变化撤销旧运行工作，迟到结果不能复活。

历史按27天窗口和完整分页推进，检查游标环并在完整发现后提交水位。日常轮询约5分钟，回退7天捕获迟到，每天及手动同步有界重查所选历史。平台没有已验证的更新/删除事件，不能承诺实时修订通知。执行检查点和媒体下载独立恢复，资源等待不耗失败次数；可重放失败超过当前重试预算后等待显式重试。

原始封包、规范段落和稳定字段参与版本身份。观察时间、重试和后到音频不生成新正文。厂商重复结构不复制为重复发言，真实重复段落仍保留。每段保留原说话人标签与可靠时间；推导的结束时间标不确定，缺少可靠媒体位置时保持untimed。来源时间不为正文回忆的每件事确定日期。

音频、转写封包和Material分别有大小/覆盖上限，以当前schema为准。超限明确部分或失败，不能假称完整输入后自动Memory。临时媒体下载尚不具备厂商流下载过程中的实时磁盘配额监控。

## 插件与证据

公共RecordingConnector负责发现、信息、转写、媒体、关闭；平台适配器负责固定只读命令、响应与账号核验。它复用ConnectorRegistry、SourceStore、Asset/FileStore、ExecutionEngine、Material与Memory，不另建任务引擎或模型权限。新Provider通过manifest贡献接入；查询Agent不获得厂商CLI或授权写工具。

实现入口：[recordings.ts](../apps/server/src/connectors/recordings.ts)、[lark-recordings.ts](../apps/server/src/connectors/lark-recordings.ts)、[dingtalk-recordings.ts](../apps/server/src/connectors/dingtalk-recordings.ts)。具体适配版本由代码和固定二进制决定；解码失败不视为空库。生成夹具、真实账号、物理录音笔、长期令牌刷新和模型质量分别提供证据，见[测试规范](testing.zh-CN.md)。
