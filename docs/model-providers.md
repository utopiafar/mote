# 模型服务与授权

模型Provider预设保存连接，Chat、Memory、回顾、资料导入和文件分析按模块选择预设与模型；问答等入口还可指定本次模型。优先级为本次模型、本次预设默认、模块模型、模块预设默认。当前没有按内容、关键词或失败自动切换厂商的逻辑。

## 配置与使用

在系统管理的模型页新增连接，选择协议、地址和凭据，从目录选模型或手填ID。未配置模型时，采集、同步、笔记和归档仍可使用。预设地址只作配置起点，可用协议和厂商目录见[注册表](../packages/shared/src/model-providers.ts)，不代表所有上游模型都已验证。

预设可命名、编辑、复制、删除，最多30个自定义项；被模块引用的项不能删除。复制默认包含凭据，可取消；操作在服务器内完成，不把密钥回传浏览器。默认设置写入项为`primary`，初始化不预置可用模型。只读页面项`env:deployment`来自YAML的`models.deployment`，不是环境变量覆盖；有效修改准备成功后用于新请求，在途请求保留旧运行时。

页面与手改文件共用`models.profiles/defaults/defaultModels`和全局revision，见[配置](server-configuration.md)。相同保存不生成新版本；`model-settings.json`不再读取、迁移或删除。模型选择回执随答案保存；配置缺失的任务等待配置，不静默换模型或重新计算已完成历史。

## 凭据与测试

`apiKey`、`headers`、`extraBody`只显示是否已配置。省略保留、`null`清除、新对象整体替换。更换provider、protocol或baseUrl并保留非空敏感字段时，需`allowCredentialReuse:true`。写入不确定时读取实际配置和revision，不用旧草稿反复覆盖。

测试连接使用固定合成记录验证当前连接、工具往返和引用，不读取个人资料库；最多采用30秒Agent期限或配置的更短期限。测试不保存草稿，可能产生用量，也不代表整体语义质量。模型目录、实际连接和回答质量分别验证。

远程服务使用HTTPS和API key；只有loopback可HTTP，免密本机服务需显式配置。BaseURL保留服务要求的前缀，不含用户信息、query或fragment，模型请求拒绝重定向。高级参数不能覆盖消息、系统提示、工具、模型、输出上限、目的地或受保护请求头。

## 运行时与预算

| 协议 | 适配 |
| --- | --- |
| `codex-app-server` | Mote 构建的 Codex App Server 与 Central 系统用户的 Codex 文件登录 |
| `deepseek` | 原生Messages适配 |
| `openai-completions`、`openai-responses` | 对应HTTP消息、流式与工具格式 |
| `anthropic-messages`、`google-generative-ai` | 对应原生消息与工具协议 |

HTTP运行时使用Harness/pi-ai，Codex使用独立适配器；共享Mote工具、范围和引用校验。具体字段由[Agent代码](../packages/agent/src)和[模型设置](../apps/server/src/model-settings.ts)定义。Responses关闭服务端会话存储，Harness会话日志和插件清单上传关闭；图片按已有授权内联，远程Files上传在请求前拒绝。

HTTP 的 `modelRequestTimeoutMs` 为 5000–600000 毫秒，`agentTimeoutMs` 为 5000–3600000 毫秒或 `null`。新 HTTP 预设的 Agent 总预算默认为一小时，覆盖实际模型、工具和修正时间。等待中央名额的时间单独计量。并发变化作用于后续准入。

HTTP 单次输出预算 `maxTokens` 默认从 65,536 起，按所选供应商、线路和模型的能力核对。需要完整输出的长 Memory 批次可以使用专用预设的 128,000 档，前提是该线路支持这个输出上限，并且总上下文窗口能同时容纳输入、工具往返和输出预留。已核实的总窗口可以通过预设的 `contextWindow` 配置。

所有者可用模型默认设置接口的 `memoryBudgetProfileId` 字段指定 Memory 请求预算预设。Central 仅对连接和模型设置一致的 HTTP 请求采用该预设的输出上限和上下文窗口，原有绑定继续用于授权和检查点。复核沿用已保存的提取结果与原文范围。字段可用 `null` 清除。

遇到输出截断时，先核对失败请求的单次输出预算和模型结束原因。调整预算后，用原失败批次和原文范围验证，核对目标覆盖、独立复核和原文引文。采用例外档位时，以供应商能力和原批次的实际结果为依据。输入超出上下文窗口时，按原文范围的容量约束处理。输出超限的较短回答恢复与失败保留见[Agent说明](agent-runtime.md#runtime-roles)。

Codex 需要运行 Central 的系统用户有可访问的文件登录。原生部署还需在对应发布目录构建带请求预算检查的 App Server，见[原生部署](deployment.md#安装与启动)。系统安装的 Codex CLI 可用于登录和读取模型目录。`models.codex.executable/home`只由宿主配置提供，修改需重启。每次请求使用独立进程和临时home，不继承私人MCP、插件、hooks或历史会话。查询只开放Mote上下文工具，导入使用独立可写临时工作区。

Codex单次模型请求期限由上游管理，Mote的Agent总预算仍可为空；HTTP输出token设置不传给Codex。推理档位和Standard/Fast按当前目录选择，不静默替换；Fast返回档位不匹配会失败。Host未配置窗口时使用272000 token保守预算，并受目录实际窗口和输出预留约束；真正超限保留失败，不裁剪原始目标。能力取决于所用CLI和模型，连接测试仅证明本次调用。

## 所有者接口

设置接口只允许所有者身份，不缓存或回显凭据。主要入口为`GET/PUT/DELETE /api/model-settings`、`POST /api/model-settings/test`、`PUT /api/model-settings/defaults`，预设使用`PUT/DELETE /api/model-settings/profiles/:id`，其`test/copy`为POST，`models`可GET已保存目录或POST草稿。写入携带revision；复制携带新id、name及`includeCredentials`。默认分配是`chat/memory/insight/import/file`，独立模型覆盖在`defaultModels`。

请求可选`modelProfileId`只影响本轮，不存在的ID报错。`settings`、ID与参数校验以[模型设置实现](../apps/server/src/model-settings.ts)为准。无效参数400，revision或凭据复用冲突409，准备/保存失败503；`model_settings_commit_uncertain`要求核对实际状态。

## 后台模型授权

`GET /api/model-authorization`返回`{authorization:{revision,state,excludedSourceIds}}`，state为`off|on`。所有者通过`POST /api/model-authorization/commands`提交`{revision,operationId,action}`；operationId是UUID，action为`on|off|stop|exclude`，只有exclude携带完整替换的`excludedSourceIds`。陈旧revision、未知字段及同一operationId的不同内容被拒绝。

| 操作 | 当前语义 |
| --- | --- |
| `on` | 开放符合条件原件的自动接纳，仍须存在有效原件回执 |
| `off` | 不接纳新自动工作，已接纳工作排空；保存工作的新尝试等待 |
| `stop` | 关闭并中止在途自动工作；原件不删除 |
| `exclude` | 阻止所列来源并取消相关调用；重新纳入可恢复有效工作，不重复认领已完成目的 |

后台调用使用实际发起时的有效模型配置；手动调用固定确切连接身份和指纹。宿主在发送和发布时检查权限、来源、版本与原件状态；派生内容继承原始依赖，不创造新授权。安装模型、准备依赖或启用插件不授予后台权限。设备写入仍经Actions，读取原图另受`allowQueryImages`约束。

[ModelAuthorizationHost](../apps/server/src/model-authorization-host.ts)在生产者事务登记原件，在发布事务继承依赖；自动、手动和同步manualCommand各有入口。可信连接身份来自宿主，HTTP布尔值、提示和插件参数不发放权限。独立第三方脚本的联网不是此接口的沙箱能力。
