# 服务端配置

Central的系统配置保存在私有`mote.yaml`。网页与文件编辑共用[ConfigService](../apps/server/src/config-service.ts)的校验、revision、资源准备、原子保存和生效状态；各领域注册自己的schema和应用方式。

## 文件与运行环境

CLI命名环境读取`<home>/<profile>/mote.yaml`；直接启动读取`MOTE_CONFIG_FILE`指定文件，未指定时读取当前目录的`mote.yaml`。相对路径以YAML所在目录为基准。Docker挂载profile目录为`/config`，使用明确的容器数据路径。

```sh
node scripts/mote.mjs config --profile dev
MOTE_CONFIG_FILE=/absolute/private/mote.yaml npm start
```

CLI默认选择dev。`config`离线读取并隐藏敏感字段，不启动服务或迁移。`profile.json`只保存发行与进程生命周期选择。安装和profile创建见[开发入口](development.zh-CN.md)、[部署](deployment.md)。

```yaml
version: 1
revision: 0
server:
  profile: dev
  host: 127.0.0.1
  port: 47842
storage:
  dataDir: ./data
```

未自定义的领域可省略。普通环境变量和根`.env`不覆盖YAML；只有声明的敏感字段解析`${NAME}`，缺失引用会报错。旧`MOTE_ENV_FILE`不是配置来源。普通字段不展开shell、`~`或命令替换。私有配置默认目录0700、文件0600，可能含明文凭据，不进入Git或支持包。

## 保存与生效

编辑时携带当前全局`revision`；陈旧草稿与并发修改返回冲突。相同内容不增加revision或生成任务。运行中无效文件保留最后有效值，错误不回显配置内容。

配置视图区分已保存值、当前有效值与`applied`、`restart-required`、`invalid`。准备失败保留旧配置；应用失败回滚有效投影，已保存候选可保留为失败状态。`config_commit_uncertain`表示写入结果未知，应读取实际状态处理，不能假定未保存。

| 领域 | 生效方式 |
| --- | --- |
| `models.deployment/profiles/defaults/defaultModels` | 准备成功后用于新请求；在途请求使用旧运行时 |
| `execution.*Concurrency` | 后续准入；降低名额不终止在途任务 |
| `diagnostics.enabled/debug/traceEnabled/level` | 立即应用；日志目录及容量参数需重启 |
| `connectors.syncIntervalMs` | 调整同步调度，不授予来源权限 |
| `processing.settings/policy`、`perception`、`workflows` | 按领域指纹和撤权策略应用；停用阻止不再有效的在途结果发布 |
| `actions.enabled/timeZone` | 运行时应用；设备授权仍在领域数据库 |
| `memory` | 新接纳窗口使用新设置；在途窗口保留快照，历史授权不扩大 |
| `server`、`updates`、`media`、`models.embedding/codex`、模块/OAuth/MCP配置 | 需要重启；保存不自动重启或部署Worker |
| `storage.dataDir/dataKey` | 需要明确的数据搬迁或密钥处理；保存不移动数据、不转换密文 |
| `storage.contentEncryptionEnabled` | 改变后续内容写入；旧对象保持原格式并可读 |
| 其他`storage`启动参数 | 容量、保留周期及导出预算需重启 |

完整字段、默认值和生效元数据以[配置注册](../apps/server/src/config.ts)和已认证配置视图为准。

## 任务快照与权限

revision是编辑版本，不是所有任务的内容版本。文件处理依实际服务、参数、处理器及输入生成指纹；相关变化拒绝旧结果，无关预设变化不使任务失效。已完成结果不因改设置自动重做，需显式重处理。

Memory策略、不可变版本、输入授权和检查点保留在领域数据库。提取与审核固定相关配置，变化可阻塞为`configuration_changed`；显式重试采用新配置并保留成功阶段。普通问答保留实际模型回执。修改模型或并发不能扩大既有读取范围。

资源准备期间不发布候选权限；各领域同步切换运行快照与SQL有效投影。不可逆取消、重新排队和运行时退休在事务提交后执行。SQL有效配置由YAML重建，不是另一份配置来源；客户端隐私、队列与本机偏好由设备维护。

## 常用边界

| 配置 | 当前默认与含义 |
| --- | --- |
| `server.host/port` | 直接启动为`127.0.0.1:47832`；CLI dev/test为47842/47852 |
| `storage.maxExportBytes` | 64 MiB，最高256 MiB；HTTP导出不替代全库备份 |
| `execution.interactiveConcurrency/agentConcurrency/llmConcurrency/memoryConcurrency` | 2／8／4／3 |
| `connectors.syncIntervalMs` | 900000，范围60000–86400000 |

Central 不设资料总量配额，也不按天自动删除原件或资料。新文件来源默认归档原件，已有明确保存选择保持不变；仅保留解析内容与仅引用在来源高级设置中选择。实际磁盘、文件系统或 SQLite 无法写入时，写入失败会保留诊断原因；容量耗尽返回 `507/storage_full`，已有资料和待传内容不会因此自动淘汰。单次传输、导出、处理输入及插件状态的资源边界继续按各自用途生效，诊断日志仍使用独立的保留设置。

模型设置见[模型服务](model-providers.md)。文件策略使用`processing.policy.services/profiles/rules`；插件参数受已安装处理器schema校验。模型目录与测试连接通过设置操作发起，连接测试只用合成输入，可能产生模型费用。

受管媒体依赖按`ocr`、`dialogue`、`local-image`分别准备。本地识图页面在 Native macOS Apple Silicon 上通过同一媒体准备生命周期校验和修复 Python/MLX 依赖与模型资产，完成后仅表示已准备；现有插件启用或重试操作才启动 worker，不改变后台处理授权。Central 重启后保留模型已安装的事实，依赖需再次验证时会明确显示；未启用的 worker 停止属于正常状态。默认音频页准备完整 FunASR/CAM++ 安装，不提供无内置消费者的 WeSpeaker 安装入口。`media-runtime --profile NAME --role ROLE`仍可只准备环境，不代表 Worker 就绪；权重离线导入使用`media-import --role ocr|dialogue|speaker-wespeaker|local-image --from DIRECTORY`。安装、服务就绪和插件启用分别表达，见[媒体配置](media-setup.md)。

## 日志与调试

普通诊断默认开启，debug与详细trace默认关闭；日志分段16 MiB，总预算2 GiB。显式保存的设置保持有效。详细记录含私有内容且有到期时间，支持包不包含trace正文。级别保留、接口与设备日志见[诊断](troubleshooting.md)。

## 存储、秘密与升级

SQLite/WAL、原件和业务记录在数据目录；模型与运行配置在YAML，账户、插件实例、配对和撤销状态归各领域。Tunnel凭据保存在profile私有文件，仅交给Tunnel进程。在线配置API仅限所有者，包含私有路径，不作为可分享的支持包。

旧`mote.env`、`model-settings.json`、`file-processing.json`及SQLite运行配置不再作为权威来源，不自动删除或转换。配置升级不重置资料库。数据目录、密钥或同代恢复按[备份与部署](deployment.md)处理；SQLite活动WAL使用本地块存储。Docker的宿主profile和容器数据卷分别识别，挂载配置父目录以支持原子替换；权限检查失败不放宽保护。
