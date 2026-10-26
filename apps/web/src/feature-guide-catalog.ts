import type {FeatureRequirement} from '@mote/shared';
export type GuideTarget = {pageId:string;href:string;collectionId?:string|null;categoryId?:string|null;label:string;path:string;where:string;requires?:FeatureRequirement[];requiredCollectionIds?:string[]};
export type GuideUnit = {id:string;priority:string;title:string;purpose:string;actions:string[];target:GuideTarget;otherTargets:GuideTarget[];setup:string|null;setupTargets:GuideTarget[];caveats:string[];condition:string|null};
export type GuideGroup = {id:string;title:string;purpose:string;setting:string;links:GuideTarget[];units:GuideUnit[]};
export type GuideSection = {id:string;title:string;description:string;groups:GuideGroup[]};
/** Authored UI keys only. Render through moteText; evidence never enters this catalog. */
export const guideSections:GuideSection[] = [
  {
    "id": "capture",
    "title": "接入与记录",
    "description": "从新的想法到已有资料，选择你想汇集的内容。",
    "groups": [
      {
        "id": "G05",
        "title": "随手记与已有附件",
        "purpose": "立即记下文字，保留草稿和待同步笔记，上传已有图片或音频附件。",
        "setting": "草稿保存在当前浏览器；已有附件的识字与转写在模型与服务中设置。",
        "links": [
          {
            "pageId": "notes",
            "href": "#/library/notes",
            "collectionId": null,
            "categoryId": null,
            "label": "随手记",
            "path": "资料库工具 → 随手记",
            "where": "笔记编辑器下方查看草稿、待同步队列和历史。"
          }
        ],
        "units": [
          {
            "id": "C12",
            "priority": "core",
            "title": "随手记下文字",
            "purpose": "保存快速笔记，保留本地草稿，并查看离线待同步或已经保存的记录。",
            "actions": [
              "写入并保存笔记",
              "继续本地草稿",
              "离线加入待同步队列",
              "重试同步",
              "丢弃本地待同步副本",
              "打开笔记历史"
            ],
            "target": {
              "pageId": "notes",
              "href": "#/library/notes",
              "collectionId": null,
              "categoryId": null,
              "label": "随手记",
              "path": "资料库工具 → 随手记",
              "where": "笔记编辑器下方查看草稿、待同步队列和历史。"
            },
            "otherTargets": [],
            "setup": "草稿和待同步笔记按中央地址保存在当前浏览器；联网后才能同步到中央。",
            "setupTargets": [],
            "caveats": [
              "丢弃本地副本不证明中央已保存的内容被删除。",
              "文字目前最多 100000 字符。"
            ],
            "condition": null
          },
          {
            "id": "C13",
            "priority": "core",
            "title": "上传已有图片或音频附件",
            "purpose": "随文字上传已有图片或音频文件，也可以只保存附件。",
            "actions": [
              "选择并上传已有图片或音频文件",
              "保存只有附件的笔记",
              "在资料库查看处理状态",
              "打开附件证据"
            ],
            "target": {
              "pageId": "notes",
              "href": "#/library/notes",
              "collectionId": null,
              "categoryId": null,
              "label": "随手记",
              "path": "资料库工具 → 随手记 → 图片与语音附件",
              "where": "在编辑器附件入口选择已有图片或音频文件；保存后从历史或资料库打开证据。"
            },
            "otherTargets": [],
            "setup": "附件先归档再提交笔记；识字、转写依赖中央图片或文件与语音设置。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=images",
                "collectionId": null,
                "categoryId": "images",
                "label": "图片",
                "path": "设置 → 模型与服务 → 图片",
                "where": "在「图片」查看统一处理与授权，历史任务位于「处理已有图片」。"
              },
              {
                "pageId": "settings",
                "href": "#/system/models?category=file-processing",
                "collectionId": null,
                "categoryId": "file-processing",
                "label": "文件与语音",
                "path": "设置 → 模型与服务 → 文件与语音",
                "where": "在「文件与语音」查看模型安装、规则、方案与服务，具体操作在对应区域。"
              }
            ],
            "caveats": [
              "目前最多 10 个附件，每个 50 MiB。",
              "保存附件与识字、转写完成是不同阶段。",
              "随手记附件入口用于上传已有文件。"
            ],
            "condition": null
          }
        ]
      },
      {
        "id": "G04",
        "title": "导入文档、文件夹和媒体",
        "purpose": "把已有资料加入归档，核对解析预览，继续或恢复导入。",
        "setting": "导入页选择文件或目录；所缺的模型、处理配置和确认会在详情提示。",
        "links": [
          {
            "pageId": "imports",
            "href": "#/library/import",
            "collectionId": null,
            "categoryId": null,
            "label": "导入",
            "path": "资料库 → 导入资料；资料库工具 → 导入",
            "where": "选择文件、文件夹或拖入；填写资料说明后加入队列。"
          }
        ],
        "units": [
          {
            "id": "C09",
            "priority": "core",
            "title": "导入已有文档、文件夹和媒体",
            "purpose": "把已有聊天导出、文档、笔记和附件提交到独立导入队列，并补充背景。",
            "actions": [
              "选择多个文件或文件夹",
              "拖入文件或文件夹",
              "提交 ZIP",
              "分别加入导入队列",
              "说明格式、日期、作者和内容关系"
            ],
            "target": {
              "pageId": "imports",
              "href": "#/library/import",
              "collectionId": null,
              "categoryId": null,
              "label": "导入",
              "path": "资料库 → 导入资料；资料库工具 → 导入",
              "where": "选择文件、文件夹或拖入；填写资料说明后加入队列。"
            },
            "otherTargets": [],
            "setup": "需要主动选择本地文件；上传完成前保持当前浏览器会话。媒体和含糊格式的进一步处理可能需要对应模型或文件设置。",
            "setupTargets": [],
            "caveats": [
              "目前每文件 64 MiB、单次总量 256 MiB、最多 4000 文件；压缩包展开总量 512 MiB。",
              "无法解析的输入仍保留原件；已归档不等于正文已发布或记忆已生成。"
            ],
            "condition": null
          },
          {
            "id": "C10",
            "priority": "core",
            "title": "查看并处理导入进度",
            "purpose": "分清原件归档、解析预览、记录发布和记忆整理，处理需要确认或重试的步骤。",
            "actions": [
              "查看归档、解析、记录与记忆阶段",
              "查看预览和排除、无法解析的说明",
              "确认含糊解释",
              "补充说明并重新生成预览",
              "在提供入口时重试或取消处理",
              "查看导入记录、原件和媒体"
            ],
            "target": {
              "pageId": "imports",
              "href": "#/library/import",
              "collectionId": null,
              "categoryId": null,
              "label": "导入",
              "path": "资料库工具 → 导入 → 导入详情",
              "where": "选择一条本地队列或中央导入记录，查看详情与状态对应的操作。"
            },
            "otherTargets": [],
            "setup": "先提交导入；页面会指出所缺的模型、处理配置或你的确认。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models",
                "collectionId": null,
                "categoryId": null,
                "label": "模型与服务",
                "path": "设置 → 模型与服务",
                "where": "进入后按页面中的名称操作。"
              }
            ],
            "caveats": [
              "可靠且无歧义的解析会自动保存；其他情况需要确认。",
              "中央处理可在离开页面后继续；本地尚未上传的字节仍依赖浏览器会话。",
              "取消处理保留已归档原件和记录；媒体接收、内容可查、记忆准备是不同状态。"
            ],
            "condition": "操作随所选导入的状态出现；没有导入记录时先提交文件。"
          },
          {
            "id": "C11",
            "priority": "core",
            "title": "删除整次导入",
            "purpose": "确认移除一次导入及不再被其他资料使用的依赖内容。",
            "actions": [
              "在导入详情找到删除入口",
              "核对共享内容保留说明",
              "确认删除整次导入"
            ],
            "target": {
              "pageId": "imports",
              "href": "#/library/import",
              "collectionId": null,
              "categoryId": null,
              "label": "导入",
              "path": "资料库工具 → 导入 → 导入详情 → 删除这次导入",
              "where": "选中中央导入记录后，在详情底部查看「删除这次导入」。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "删除不可撤销；仍在接收的导入需要先完成或取消。",
              "其他导入或证据仍引用的共享资料、原件会保留。"
            ],
            "condition": "只有已有中央导入记录才有此操作；进行中的接收会禁用删除。"
          },
          {
            "id": "A01",
            "priority": "advanced",
            "title": "从中央机器的目录导入",
            "purpose": "让中央节点复制其机器上可读取的目录内容进入归档。",
            "actions": [
              "填写中央机器可读取的路径",
              "提交并复制到归档"
            ],
            "target": {
              "pageId": "imports",
              "href": "#/library/import",
              "collectionId": null,
              "categoryId": null,
              "label": "导入",
              "path": "资料库工具 → 导入 → 服务器目录",
              "where": "切换到服务器目录方式，填写「中央服务器上的目录」。"
            },
            "otherTargets": [],
            "setup": "目录必须存在于运行中央节点的机器，并允许中央进程读取。",
            "setupTargets": [],
            "caveats": [
              "这是中央机器路径，不是浏览器电脑的路径。",
              "一次提交导入不会开启自动文件夹同步。"
            ],
            "condition": null
          },
          {
            "id": "A02",
            "priority": "advanced",
            "title": "选择导入解析器和图片处理方案",
            "purpose": "为当前导入选择已安装的来源解析器，或调整其图片处理方案。",
            "actions": [
              "选择已安装的 Source Pack",
              "选择默认、仅归档或自定义图片方案"
            ],
            "target": {
              "pageId": "imports",
              "href": "#/library/import",
              "collectionId": null,
              "categoryId": null,
              "label": "导入",
              "path": "资料库工具 → 导入 → 解析方式 / 修改图片处理",
              "where": "提交表单中的解析方式，以及导入详情里的图片处理方案。"
            },
            "otherTargets": [],
            "setup": "可选项来自已注册的 Source Pack 和图片处理器；需先安装对应可信组件。",
            "setupTargets": [
              {
                "pageId": "extensions",
                "href": "#/system/plugins",
                "collectionId": null,
                "categoryId": null,
                "label": "自动记忆与插件",
                "path": "设置 → 自动记忆与插件",
                "where": "进入后按页面中的名称操作。"
              }
            ],
            "caveats": [
              "已选固定版本的组件不可用或发生变化时，准备过程会阻止继续。",
              "不提供任意 Python 脚本表单。"
            ],
            "condition": null
          },
          {
            "id": "A03",
            "priority": "advanced",
            "title": "恢复被中断的本地上传",
            "purpose": "在上传队列继续、重试或丢弃尚未完成的本地提交。",
            "actions": [
              "暂停或继续上传",
              "重试失败提交",
              "丢弃本地队列项",
              "按提示重新选择文件或更换目录后新提交"
            ],
            "target": {
              "pageId": "imports",
              "href": "#/library/import",
              "collectionId": null,
              "categoryId": null,
              "label": "导入",
              "path": "资料库工具 → 导入 → 本地上传队列",
              "where": "查看本地队列卡片；控制按钮随上传状态出现。"
            },
            "otherTargets": [],
            "setup": "本地未上传字节需要原浏览器会话；按页面提示重新选择丢失的文件。",
            "setupTargets": [],
            "caveats": [
              "重试使用同一份冻结请求；修改内容会创建新请求。",
              "丢弃本地队列项不代表删除已进入中央节点的归档。"
            ],
            "condition": "需要未完成或失败的本地上传队列项。"
          }
        ]
      },
      {
        "id": "G03",
        "title": "接入来源、飞书与录音",
        "purpose": "选择想归档的文档、邮件、日历或录音，分别授权与限定同步范围。",
        "setting": "先在新增数据源选择卡片；已有来源在来源页管理。飞书文档/日历与录音的授权范围分开。",
        "links": [
          {
            "pageId": "sourceCatalog",
            "href": "#/connections/add",
            "collectionId": null,
            "categoryId": null,
            "label": "新增数据源",
            "path": "采集与设备 → 新增数据源",
            "where": "先选择录音、设备、导入文件或在线资料卡片；管理已有来源使用「管理已接入来源」。"
          },
          {
            "pageId": "lark",
            "href": "#/connections/lark",
            "collectionId": null,
            "categoryId": null,
            "label": "飞书",
            "path": "新增数据源 → 飞书文档与日历",
            "where": "选择「飞书文档与日历」卡片，再按 CLI、应用、账号授权和内容选择的步骤设置。"
          },
          {
            "pageId": "recordings",
            "href": "#/connections/recordings",
            "collectionId": null,
            "categoryId": null,
            "label": "录音归档",
            "path": "新增数据源 → 录音与转写 → 录音厂商",
            "where": "先选择飞书录音 / 妙记或钉钉录音 / 闪记卡片，再查看该厂商的首次授权、历史范围和同步设置。"
          }
        ],
        "units": [
          {
            "id": "C07",
            "priority": "core",
            "title": "选择要加入的来源",
            "purpose": "按需加入文件、引用或外部服务，找到每种来源的授权和选择范围。",
            "actions": [
              "找到文件导入",
              "找到外部引用",
              "找到 Google 日历、Gmail 和 MCP 导入",
              "找到飞书和录音归档"
            ],
            "target": {
              "pageId": "sourceCatalog",
              "href": "#/connections/add",
              "collectionId": null,
              "categoryId": null,
              "label": "新增数据源",
              "path": "采集与设备 → 新增数据源",
              "where": "先选择录音、设备、导入文件或在线资料卡片；管理已有来源使用「管理已接入来源」。"
            },
            "otherTargets": [
              {
                "pageId": "imports",
                "href": "#/library/import",
                "collectionId": null,
                "categoryId": null,
                "label": "导入",
                "path": "来源 → 添加来源 → 导入",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "lark",
                "href": "#/connections/lark",
                "collectionId": null,
                "categoryId": null,
                "label": "飞书",
                "path": "采集与设备 → 来源与连接 → 飞书",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "recordings",
                "href": "#/connections/recordings",
                "collectionId": null,
                "categoryId": null,
                "label": "录音归档",
                "path": "采集与设备 → 来源与连接 → 录音归档",
                "where": "进入后按页面中的名称操作。"
              }
            ],
            "setup": "文件、引用和不同外部服务各有自己的设置；外部服务授权与 Mote 管理登录分开。",
            "setupTargets": [],
            "caveats": [
              "这是中央节点的来源管理；本地文件夹发现或设备采集仍在原生客户端。"
            ],
            "condition": null
          },
          {
            "id": "C08",
            "priority": "core",
            "title": "管理来源接收与内容关系",
            "purpose": "暂停或恢复一个来源的接收，查看同步情况，并说明内容与你的关系。",
            "actions": [
              "暂停或恢复接收",
              "查看启用、同步和错误状态",
              "声明本人、第三方、混合或未知关系",
              "浏览该来源归档"
            ],
            "target": {
              "pageId": "sources",
              "href": "#/connections",
              "collectionId": null,
              "categoryId": null,
              "label": "来源",
              "path": "采集与设备 → 来源与连接 → 来源 → 已连接来源",
              "where": "选择已连接来源，查看状态、内容关系和归档入口。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "暂停接收会保留已有归档。",
              "未知关系的内容仍可查询；来源声明适用于已有和新内容，单份资料的声明优先。"
            ],
            "condition": "需要已有来源；部分服务的同步控制随连接状态出现。"
          },
          {
            "id": "A04",
            "priority": "advanced",
            "title": "保存外部或 NAS 引用",
            "purpose": "记录资料名称和位置，便于以后从能读取它的客户端提交正文快照。",
            "actions": [
              "保存标题和 URI",
              "查看引用层、版本和位置"
            ],
            "target": {
              "pageId": "sources",
              "href": "#/connections?setup=reference",
              "collectionId": null,
              "categoryId": null,
              "label": "来源",
              "path": "新增数据源 → 外部文件 / NAS 引用",
              "where": "从「新增数据源」选择「外部文件 / NAS 引用」，在来源设置中完成该服务的配置。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "保存引用不会读取远程地址或收集正文。",
              "要让正文进入归档，需要可访问该内容的客户端选择并提交快照。"
            ],
            "condition": null
          },
          {
            "id": "A05",
            "priority": "advanced",
            "title": "只读归档 Google 日历",
            "purpose": "授权 Google 后选择日历，把选中的日程同步到资料库供回顾。",
            "actions": [
              "查看 OAuth 前置配置",
              "开始授权并刷新状态",
              "选择日历并保存",
              "同步",
              "断开连接"
            ],
            "target": {
              "pageId": "sources",
              "href": "#/connections?setup=google",
              "collectionId": null,
              "categoryId": null,
              "label": "来源",
              "path": "新增数据源 → Google Calendar",
              "where": "从「新增数据源」选择「Google Calendar」，在来源设置中完成该服务的配置。"
            },
            "otherTargets": [],
            "setup": "先在部署机器配置 Google Cloud、API 凭据和回调地址并重启，再完成独立 Google OAuth 授权。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=connectors",
                "collectionId": null,
                "categoryId": "connectors",
                "label": "来源与外部应用",
                "path": "设置 → 模型与服务 → 来源与外部应用",
                "where": "在「来源与外部应用」编辑并校验部署草稿，核对当前生效值。"
              }
            ],
            "caveats": [
              "中央节点的 Google 日历来源是只读同步。",
              "日程记录只说明计划，不能证明实际参加。"
            ],
            "condition": null
          },
          {
            "id": "A06",
            "priority": "advanced",
            "title": "只读归档 Gmail 邮件",
            "purpose": "授权 Google 后归档邮件正文、发件人和时间，持续同步或继续分页。",
            "actions": [
              "查看 Gmail API 与 OAuth 前置配置",
              "开始授权并刷新状态",
              "同步或继续分页",
              "断开连接"
            ],
            "target": {
              "pageId": "sources",
              "href": "#/connections?setup=gmail",
              "collectionId": null,
              "categoryId": null,
              "label": "来源",
              "path": "新增数据源 → Gmail 邮件",
              "where": "从「新增数据源」选择「Gmail 邮件」，在来源设置中完成该服务的配置。"
            },
            "otherTargets": [],
            "setup": "部署端需启用 Gmail API 并配置 Google OAuth，合并配置后重启；再对 Gmail 完成外部授权。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=connectors",
                "collectionId": null,
                "categoryId": "connectors",
                "label": "来源与外部应用",
                "path": "设置 → 模型与服务 → 来源与外部应用",
                "where": "在「来源与外部应用」编辑并校验部署草稿，核对当前生效值。"
              }
            ],
            "caveats": [
              "邮件附件仅归档名称和引用，不表示已读取附件正文。",
              "断开连接停止读取，已有归档保留。"
            ],
            "condition": null
          },
          {
            "id": "A07",
            "priority": "advanced",
            "title": "从远程 MCP 选择资源导入",
            "purpose": "查看远程 MCP 服务公开的资源列表，选择资源一次性加入归档。",
            "actions": [
              "填写远程 URL 和 Bearer 凭据",
              "发现资源列表",
              "选择资源并导入一次"
            ],
            "target": {
              "pageId": "sources",
              "href": "#/connections?setup=mcp",
              "collectionId": null,
              "categoryId": null,
              "label": "来源",
              "path": "新增数据源 → MCP 资料服务",
              "where": "从「新增数据源」选择「MCP 资料服务」，在来源设置中完成该服务的配置。"
            },
            "otherTargets": [],
            "setup": "需要远程 MCP 地址、所需 Bearer 凭据，以及该服务实际公开的可读资源。",
            "setupTargets": [],
            "caveats": [
              "只能导入服务提供的资源；不会迁移隐藏的 Chatbot 记忆。",
              "此入口不调用外部写入工具，也不提供 OAuth 授权服务器。"
            ],
            "condition": null
          },
          {
            "id": "A09",
            "priority": "advanced",
            "title": "连接飞书文档和日历",
            "purpose": "在中央节点授权飞书，归档你创建、编辑或打开的文档及活动线索，也可持续跟踪指定范围和日历。",
            "actions": [
              "检测或安装 Lark CLI",
              "创建应用或配置 App ID、Secret 和区域",
              "登录或重新授权，打开二维码或链接",
              "查看所需只读权限并取消授权任务",
              "选择文档活动、首次回溯、指定范围和排除项",
              "保存范围、预览实际发现的文档并确认归档",
              "查看失败项并逐篇重试，暂停或恢复来源",
              "选择日历、日期和时区"
            ],
            "target": {
              "pageId": "lark",
              "href": "#/connections/lark",
              "collectionId": null,
              "categoryId": null,
              "label": "飞书",
              "path": "新增数据源 → 飞书文档与日历",
              "where": "选择「飞书文档与日历」卡片，再按 CLI、应用、账号授权和内容选择的步骤设置。"
            },
            "otherTargets": [],
            "setup": "操作使用中央机器的私有 Lark CLI；需应用配置、账号授权和页面列出的只读权限。",
            "setupTargets": [],
            "caveats": [
              "飞书文档/日历与「录音归档」是不同的选择与授权范围，录音还需妙记读取和导出权限。",
              "正文与活动线索分别归档；打开不代表读完或认同。图片、附件和嵌入表格保留引用；日历范围最多 180 天。",
              "断开 Mote 来源与撤销外部 CLI 授权是两个操作。"
            ],
            "condition": null
          },
          {
            "id": "A10",
            "priority": "advanced",
            "title": "归档厂商录音和转写",
            "purpose": "连接中央节点已授权的录音账号，选择首次历史范围及是否继续后台同步。",
            "actions": [
              "查看可用录音厂商",
              "连接已授权账号",
              "选择首次历史起止时间",
              "启用录音同步并选择后台同步",
              "保存开始、立即同步或重试失败步骤",
              "断开连接",
              "查看归档计数、最近转写和音频"
            ],
            "target": {
              "pageId": "recordings",
              "href": "#/connections/recordings",
              "collectionId": null,
              "categoryId": null,
              "label": "录音归档",
              "path": "新增数据源 → 录音与转写 → 录音厂商",
              "where": "先选择飞书录音 / 妙记或钉钉录音 / 闪记卡片，再查看该厂商的首次授权、历史范围和同步设置。"
            },
            "otherTargets": [
              {
                "pageId": "recordings",
                "href": "#/connections/recordings?provider=feishu",
                "collectionId": null,
                "categoryId": null,
                "label": "飞书录音 / 妙记",
                "path": "新增数据源 → 飞书录音 / 妙记",
                "where": "查看此厂商的首次授权、历史范围和同步。"
              },
              {
                "pageId": "recordings",
                "href": "#/connections/recordings?provider=dingtalk",
                "collectionId": null,
                "categoryId": null,
                "label": "钉钉录音 / 闪记",
                "path": "新增数据源 → 钉钉录音 / 闪记",
                "where": "查看此厂商的首次授权、历史范围和同步。"
              }
            ],
            "setup": "飞书录音需中央机器安装、登录 Lark CLI 并授予妙记搜索、信息、产物读取和媒体导出权限；钉钉需安装、登录 DWS CLI 且组织开启 CLI 接入。",
            "setupTargets": [],
            "caveats": [
              "飞书录音 / 妙记、钉钉录音 / 闪记及已注册厂商各自连接；钉钉适配器尚未完成真实账号验证。",
              "后台同步是可选项；厂商删除、停止同步或断开连接不会删除 Mote 已有归档。",
              "音频已收到、正文可查和记忆生成是不同阶段。"
            ],
            "condition": null
          },
          {
            "id": "A11",
            "priority": "advanced",
            "title": "查看来源版本和原位置",
            "purpose": "查看一个来源的当前或历史版本，以及原位置和元数据。",
            "actions": [
              "筛选来源",
              "展开证据",
              "查看全部版本、当前和删除状态",
              "检查 URI 与元数据"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=sources",
              "collectionId": "sources",
              "categoryId": null,
              "label": "来源资料",
              "path": "资料库 → 来源资料",
              "where": "选中来源后展开版本和证据。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "显示 URI 不会自动读取地址。",
              "日历的计划时间不等于实际出席时间。"
            ],
            "condition": "需要已归档的来源版本；版本详情随所选来源显示。"
          }
        ]
      },
      {
        "id": "G02",
        "title": "连接设备与查看采集",
        "purpose": "配对 Mac 或 Android，查看设备最后上报、同步队列和授权连接。",
        "setting": "中央页面查看和连接；采集开关、隐私过滤和系统权限在对应设备设置。",
        "links": [
          {
            "pageId": "devices",
            "href": "#/connections/devices",
            "collectionId": null,
            "categoryId": null,
            "label": "采集与设备",
            "path": "采集与设备 → 设备",
            "where": "查看设备卡片，展开详细信息。"
          },
          {
            "pageId": "deviceConnections",
            "href": "#/connections/pair",
            "collectionId": null,
            "categoryId": null,
            "label": "连接设备",
            "path": "数据来源 → 连接设备",
            "where": "选择「连接设备」，填写地址、名称和设备身份。"
          }
        ],
        "units": [
          {
            "id": "C03",
            "priority": "core",
            "title": "从今天开始整理资料",
            "purpose": "查看已有资料和最近洞察，找到连接设备、导入资料或配置问答的第一步。",
            "actions": [
              "打开资料库和最近证据",
              "连接第一台设备",
              "导入第一批文件",
              "找到问一问和模型设置",
              "查看最近洞察"
            ],
            "target": {
              "pageId": "overview",
              "href": "#/today",
              "collectionId": null,
              "categoryId": null,
              "label": "今天",
              "path": "今天",
              "where": "初次使用指引、最近资料和最近洞察；具体入口随资料库状态显示。"
            },
            "otherTargets": [
              {
                "pageId": "devices",
                "href": "#/connections/devices",
                "collectionId": null,
                "categoryId": null,
                "label": "采集与设备",
                "path": "今天 → 连接设备",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "imports",
                "href": "#/library/import",
                "collectionId": null,
                "categoryId": null,
                "label": "导入",
                "path": "今天 → 导入资料",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "settings",
                "href": "#/system/models?category=providers",
                "collectionId": null,
                "categoryId": "providers",
                "label": "模型连接（Provider）",
                "path": "设置 → 模型与服务 → 模型连接（Provider）",
                "where": "在「模型连接（Provider）」创建或选择预设，选中后查看编辑器与高级设置。"
              },
              {
                "pageId": "insights",
                "href": "#/library/insights",
                "collectionId": null,
                "categoryId": null,
                "label": "洞察",
                "path": "今天 → 最近洞察",
                "where": "进入后按页面中的名称操作。"
              }
            ],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "空资料库会减少次要概览入口。",
              "开始采集、采集权限和隐私规则在设备端设置。"
            ],
            "condition": null
          },
          {
            "id": "C04",
            "priority": "core",
            "title": "查看设备上报的采集与同步状态",
            "purpose": "了解每台设备最后联系、最后采集以及待上传、受阻和已保留的内容。",
            "actions": [
              "查看最后联系和采集时间",
              "查看设备上报的采集状态",
              "查看同步策略、条件及队列计数",
              "展开设备和媒体信息"
            ],
            "target": {
              "pageId": "devices",
              "href": "#/connections/devices",
              "collectionId": null,
              "categoryId": null,
              "label": "采集与设备",
              "path": "采集与设备 → 设备",
              "where": "查看设备卡片，展开详细信息。"
            },
            "otherTargets": [],
            "setup": "需要设备端连接并上报；采集、同步、隐私规则和系统权限都在 Mac / Android 客户端设置。",
            "setupTargets": [],
            "caveats": [
              "最后心跳是一次上报记录，不能证明设备此刻在线。",
              "中央页面查看上报，不能远程启动本地采集。"
            ],
            "condition": null
          },
          {
            "id": "C05",
            "priority": "core",
            "title": "连接或重新授权设备",
            "purpose": "生成一次性邀请，让原生客户端确认中央节点地址后连接。",
            "actions": [
              "填写设备可访问的中央地址和连接名称",
              "选择新设备或原设备身份",
              "生成二维码邀请",
              "复制或下载邀请、二维码",
              "取消或重新生成邀请"
            ],
            "target": {
              "pageId": "deviceConnections",
              "href": "#/connections/pair",
              "collectionId": null,
              "categoryId": null,
              "label": "连接设备",
              "path": "数据来源 → 连接设备",
              "where": "选择「连接设备」，填写地址、名称和设备身份。"
            },
            "otherTargets": [],
            "setup": "跨设备使用可访问的 HTTPS 中央地址；在原生客户端「设置 → 连接」扫码、粘贴或导入后确认。",
            "setupTargets": [],
            "caveats": [
              "邀请只能使用一次，10 分钟后失效；关闭页面不会取消邀请。",
              "二维码不会打通网络；跨设备使用时，本机地址会指向接收设备自身。",
              "重新配对选择原设备身份；成功后替换该设备旧凭据。"
            ],
            "condition": null
          },
          {
            "id": "C06",
            "priority": "core",
            "title": "检查和撤销已发出的连接权限",
            "purpose": "查看每个连接的名称、权限和状态，撤销不再使用的访问。",
            "actions": [
              "查看连接标签、权限和状态",
              "刷新授权列表",
              "确认后撤销连接"
            ],
            "target": {
              "pageId": "deviceConnections",
              "href": "#/connections/pair",
              "collectionId": null,
              "categoryId": null,
              "label": "连接设备",
              "path": "数据来源 → 连接设备",
              "where": "页面下方「已授权连接」列表。"
            },
            "otherTargets": [{
              "pageId": "connections", "href": "#/connections/access", "collectionId": null, "categoryId": null,
              "label": "AI 接入", "path": "AI 接入", "where": "页面下方「已授权连接」列表。"
            }],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "完整客户端、MCP 只读和 MCP 指定来源写入的权限不同。",
              "撤销连接保留中央归档和客户端队列；专用密钥只在首次生成时显示。"
            ],
            "condition": "已有授权连接时才能选择一条连接并撤销。"
          },
          {
            "id": "A08",
            "priority": "advanced",
            "title": "让其他 Chatbot 使用 Mote MCP",
            "purpose": "为支持 HTTP MCP 的客户端生成独立的只读或指定来源写入配置。",
            "actions": [
              "选择只读资料或指定来源写入",
              "生成、复制或下载连接 JSON",
              "隐藏一次性显示的凭据"
            ],
            "target": {
              "pageId": "connections",
              "href": "#/connections/access",
              "collectionId": null,
              "categoryId": null,
              "label": "AI 接入",
              "path": "AI 接入",
              "where": "生成标准 HTTP MCP 连接 JSON，粘贴到支持 URL 与 Bearer 请求头的客户端。"
            },
            "otherTargets": [],
            "setup": "先在部署配置中启用 MCP、独立令牌；写入还需单独启用及来源允许列表，合并配置后重启。客户端需支持 Streamable HTTP、URL 和 Bearer 请求头。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=connectors",
                "collectionId": null,
                "categoryId": "connectors",
                "label": "来源与外部应用",
                "path": "设置 → 模型与服务 → 来源与外部应用",
                "where": "在「来源与外部应用」编辑并校验部署草稿，核对当前生效值。"
              }
            ],
            "caveats": [
              "只读和写入凭据分别授予；写入凭据没有读取工具。",
              "只接受 OAuth 的客户端不能直接使用这份 JSON。"
            ],
            "condition": null
          }
        ]
      }
    ]
  },
  {
    "id": "use",
    "title": "阅读与使用",
    "description": "读正文、核对证据，再提问、回顾和整理记忆。",
    "groups": [
      {
        "id": "G06",
        "title": "阅读正文与原始证据",
        "purpose": "查看已发布资料、原件和修订，追溯来源并核对处理状态。",
        "setting": "已收到原件、正文可读、索引就绪和记忆生成是不同阶段。",
        "links": [
          {
            "pageId": "archive",
            "href": "#/library?view=materials",
            "collectionId": "materials",
            "categoryId": null,
            "label": "全部资料",
            "path": "资料库 → 全部资料",
            "where": "默认分类为「全部资料」；使用筛选后选中资料。"
          },
          {
            "pageId": "archive",
            "href": "#/library?view=records",
            "collectionId": "records",
            "categoryId": null,
            "label": "原始采集记录",
            "path": "资料库 → 原始采集记录 → 记录 → 完整详情",
            "where": "选中记录后打开完整证据详情。"
          }
        ],
        "units": [
          {
            "id": "C14",
            "priority": "core",
            "title": "浏览已经发布的资料正文",
            "purpose": "按来源、类型、设备和日期筛选正式资料，打开可读正文。",
            "actions": [
              "浏览来源与类型标签",
              "筛选来源、设备和日期",
              "清空筛选",
              "翻页",
              "选中并阅读正式资料"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=materials",
              "collectionId": "materials",
              "categoryId": null,
              "label": "全部资料",
              "path": "资料库 → 全部资料",
              "where": "默认分类为「全部资料」；使用筛选后选中资料。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "此视图展示已发布内容；上传回执不能证明内容已经在此列出、可检索或进入记忆。",
              "当前「全部资料」没有全局自由文字搜索框。"
            ],
            "condition": null
          },
          {
            "id": "C15",
            "priority": "core",
            "title": "核对资料正文、来源与处理状态",
            "purpose": "阅读当前或获准查看的历史正文，追溯原件，并了解哪些派生产物还在处理。",
            "actions": [
              "阅读或继续加载正文",
              "打开来源与处理页签",
              "查看原件引用并使用可用的原件链接",
              "查看当前和历史修订",
              "核对各产物、可读和索引状态",
              "重试失败索引"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=materials",
              "collectionId": "materials",
              "categoryId": null,
              "label": "全部资料",
              "path": "资料库 → 全部资料 → 资料详情",
              "where": "选中一份资料，查看正文及「来源与处理」。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "正文可读不必等待所有派生产物或记忆完成。",
              "当前精确版本与授权历史读取是不同边界；原件链接仅在正文渲染器提供时可用。"
            ],
            "condition": "需要已发布资料；索引重试只在失败状态并提供控制时出现。"
          },
          {
            "id": "C16",
            "priority": "core",
            "title": "说明单份资料关系并提取记忆",
            "purpose": "为一份资料覆盖来源的内容关系，并从它当前可用的正文提取记忆。",
            "actions": [
              "查看内容关系和上下文",
              "保存单份资料的关系声明",
              "从当前精确正文开始记忆提取"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=materials",
              "collectionId": "materials",
              "categoryId": null,
              "label": "全部资料",
              "path": "资料库 → 全部资料 → 资料详情 → 来源与处理 / 记忆入口",
              "where": "先选中资料，在「来源与处理」中声明关系；符合条件时使用记忆提取入口。"
            },
            "otherTargets": [],
            "setup": "单份提取需要当前正式资料的记忆输入已准备好，并配置可用的记忆提取模型。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=model",
                "collectionId": null,
                "categoryId": "model",
                "label": "模块与模型",
                "path": "设置 → 模型与服务 → 模块与模型",
                "where": "在「模块与模型」查看模型分配，向下查找执行并发、记忆节奏与配方。"
              }
            ],
            "caveats": [
              "单份资料的关系声明优先于来源声明。",
              "已变更的旧选择不能继续作为当前提取依据。"
            ],
            "condition": "记忆入口仅对当前、输入已就绪的正式资料提供。"
          },
          {
            "id": "C17",
            "priority": "core",
            "title": "查看原始采集证据",
            "purpose": "按日期、设备或内容类型查找原始记录，打开图像、文本和附件核对。",
            "actions": [
              "筛选日期、设备、来源、内容或活动及 OCR 状态",
              "切换列表或网格",
              "翻页",
              "打开图片、文字、元数据和附件",
              "理解隐私与索引标签"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=records",
              "collectionId": "records",
              "categoryId": null,
              "label": "原始采集记录",
              "path": "资料库 → 原始采集记录 → 记录 → 完整详情",
              "where": "选中记录后打开完整证据详情。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "活动记录没有正文或 OCR；原始记录还可能包含其他来源类型。",
              "所有者查看原图与允许模型读取原图是两项不同授权。"
            ],
            "condition": null
          },
          {
            "id": "C18",
            "priority": "core",
            "title": "删除一条原始记录",
            "purpose": "核对影响后移除原始记录，让依赖它的证据失效。",
            "actions": [
              "打开完整详情里的删除入口",
              "阅读确认说明",
              "确认删除记录"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=records",
              "collectionId": "records",
              "categoryId": null,
              "label": "原始采集记录",
              "path": "资料库 → 原始采集记录 → 完整详情 → 删除这条记录",
              "where": "打开一条记录的完整详情，在删除操作前核对依赖影响。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "删除原始内容会传播证据失效。",
              "历史内容可供核对，但不能作为当前记忆的重新生成依据。"
            ],
            "condition": "需要先打开一条可删除的原始记录。"
          }
        ]
      },
      {
        "id": "G08",
        "title": "提问与回看对话",
        "purpose": "围绕归档证据提问，随问题提交图片，打开引用和历史回答。",
        "setting": "先在模型连接（Provider） 保存连接，再在模块与模型为问答分配模型。",
        "links": [
          {
            "pageId": "ask",
            "href": "#/ask",
            "collectionId": null,
            "categoryId": null,
            "label": "问一问",
            "path": "问一问",
            "where": "在对话输入区提问；答案中的引用可打开证据。"
          }
        ],
        "units": [
          {
            "id": "C20",
            "priority": "core",
            "title": "围绕归档资料提问",
            "purpose": "开始或继续对话，让问答模型检索已归档证据，阅读答案并打开引用。",
            "actions": [
              "开始或继续对话",
              "发送问题",
              "为当前请求选择模型预设或模型",
              "阅读答案和打开引用",
              "停止正在生成的回答",
              "重试失败轮次"
            ],
            "target": {
              "pageId": "ask",
              "href": "#/ask",
              "collectionId": null,
              "categoryId": null,
              "label": "问一问",
              "path": "问一问",
              "where": "在对话输入区提问；答案中的引用可打开证据。"
            },
            "otherTargets": [],
            "setup": "需要可用问答模型；先建立 Provider，再在模块中分配。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=providers",
                "collectionId": null,
                "categoryId": "providers",
                "label": "模型连接（Provider）",
                "path": "设置 → 模型与服务 → 模型连接（Provider）",
                "where": "在「模型连接（Provider）」创建或选择预设，选中后查看编辑器与高级设置。"
              },
              {
                "pageId": "settings",
                "href": "#/system/models?category=model",
                "collectionId": null,
                "categoryId": "model",
                "label": "模块与模型",
                "path": "设置 → 模型与服务 → 模块与模型",
                "where": "在「模块与模型」查看模型分配，向下查找执行并发、记忆节奏与配方。"
              }
            ],
            "caveats": [
              "问答 Agent 只有只读检索权限，由模型选择检索工具。",
              "当前对话没有设备或日期范围选择；其他页面的日期控件不会通过界面限定这次问答。"
            ],
            "condition": null
          },
          {
            "id": "C21",
            "priority": "core",
            "title": "回看和管理对话历史",
            "purpose": "继续过去对话，查看更多轮次，核对引用、用量和读取记录，或删除整段对话。",
            "actions": [
              "打开过去对话",
              "加载更早对话和轮次",
              "删除整段对话",
              "查看证据已删除的历史答案",
              "查看请求用量与检索轨迹"
            ],
            "target": {
              "pageId": "ask",
              "href": "#/ask",
              "collectionId": null,
              "categoryId": null,
              "label": "问一问",
              "path": "问一问 → 对话历史",
              "where": "在对话历史选中记录；具体轮次的用量和轨迹在该轮详情。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "原始证据删除后，历史答案不能继续保留被删除的证据正文。",
              "对话图片按请求或对话范围保存。"
            ],
            "condition": "删除和轮次详情需要已有对话；读取轨迹依记录存在情况显示。"
          },
          {
            "id": "C22",
            "priority": "core",
            "title": "随问题提交图片",
            "purpose": "直接为当前问题选择图片，并在发送前移除不需要的附件。",
            "actions": [
              "添加图片",
              "移除附件",
              "随问题发送",
              "查看该轮附件信息"
            ],
            "target": {
              "pageId": "ask",
              "href": "#/ask",
              "collectionId": null,
              "categoryId": null,
              "label": "问一问",
              "path": "问一问 → 输入区 → 添加图片",
              "where": "使用对话输入区的图片入口，发送后在该轮查看附件信息。"
            },
            "otherTargets": [],
            "setup": "需要支持这次图片请求的问答模型；提交图片是当前请求授权。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=providers",
                "collectionId": null,
                "categoryId": "providers",
                "label": "模型连接（Provider）",
                "path": "设置 → 模型与服务 → 模型连接（Provider）",
                "where": "在「模型连接（Provider）」创建或选择预设，选中后查看编辑器与高级设置。"
              }
            ],
            "caveats": [
              "支持 PNG、JPEG、WebP，最多 4 张，每张 8 MiB。",
              "当前问题的图片授权与允许模型读取归档截图原图分开。"
            ],
            "condition": null
          }
        ]
      },
      {
        "id": "G09",
        "title": "查看、纠正与整理记忆",
        "purpose": "核对结论和依据，纠正或删除记忆，也能手动提取和继续整理。",
        "setting": "配方决定整理什么、生成何种记忆；配方与节奏在模块与模型。全局暂停和当前整体方案在自动记忆与插件。",
        "links": [
          {
            "pageId": "archive",
            "href": "#/library?view=memories",
            "collectionId": "memories",
            "categoryId": null,
            "label": "记忆",
            "path": "资料库 → 记忆",
            "where": "在「记忆」视图筛选并打开卡片。"
          },
          {
            "pageId": "extensions",
            "href": "#/system/plugins?tab=memory",
            "collectionId": null,
            "categoryId": null,
            "label": "自动记忆控制",
            "path": "设置 → 自动记忆与插件 → 记忆方案 → 自动记忆",
            "where": "在当前记忆方案中查看「自动记忆」的状态和控制。"
          },
          {
            "pageId": "settings",
            "href": "#/system/models?category=model",
            "collectionId": null,
            "categoryId": "model",
            "label": "记忆与回顾节奏",
            "path": "设置 → 模型与服务 → 模块与模型 → 记忆与洞察节奏",
            "where": "在「模块与模型」查看模型分配，向下查找执行并发、记忆节奏与配方。"
          }
        ],
        "units": [
          {
            "id": "C23",
            "priority": "core",
            "title": "浏览有证据的记忆",
            "purpose": "搜索已保存的记忆，核对结论、适用边界、状态和支持它的原始资料。",
            "actions": [
              "按文字搜索",
              "切换整理记忆与事件资料",
              "筛选初始、整合和状态",
              "打开记忆卡片",
              "阅读内容、边界和证据",
              "跟随原始证据"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=memories",
              "collectionId": "memories",
              "categoryId": null,
              "label": "记忆",
              "path": "资料库 → 记忆",
              "where": "在「记忆」视图筛选并打开卡片。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "记忆有个人、Coding 和上下文事件等表示。",
              "已发布、失效、被替代、过期和将来生效的状态不同。"
            ],
            "condition": null
          },
          {
            "id": "C24",
            "priority": "core",
            "title": "纠正、删除或导出一条记忆",
            "purpose": "把自己的纠正保存为替代版本，或删除结论、下载文本。",
            "actions": [
              "纠正标题、内容、边界和有效时间",
              "保存纠正并替代旧版本",
              "删除记忆",
              "下载 Markdown 文本"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=memories",
              "collectionId": "memories",
              "categoryId": null,
              "label": "记忆",
              "path": "资料库 → 记忆 → 记忆详情",
              "where": "选中记忆，在详情使用「纠正记忆」「删除记忆」或「下载文本」。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "纠正保留你的说明、旧版本及证据。",
              "删除保留原始资料，并阻止用同一批旧证据再次生成该结论；新证据可重新判断。",
              "外部逻辑移除、当前记录移除与物理擦除并不等价。"
            ],
            "condition": "需要已有记忆；被替代版本不提供当前纠正操作。"
          },
          {
            "id": "C25",
            "priority": "core",
            "title": "手动提取记忆",
            "purpose": "从当前范围或明确选中的资料启动提取，选择模型与配方并跟踪结果。",
            "actions": [
              "区分范围提取与精确选中输入",
              "选择模型及可选配方",
              "启动提取",
              "查看队列、批次进度和结果",
              "在任务提供入口时暂停、恢复、取消或重试"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=memories",
              "collectionId": "memories",
              "categoryId": null,
              "label": "记忆",
              "path": "资料库 → 记忆 → 提取记忆；原始或正式资料详情 → 记忆提取",
              "where": "在记忆视图使用手动提取；也可从满足条件的资料详情启动单份提取。"
            },
            "otherTargets": [],
            "setup": "需要配置该提取模块的可用模型；各策略会等待自己所需的输入。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=model",
                "collectionId": null,
                "categoryId": "model",
                "label": "模块与模型",
                "path": "设置 → 模型与服务 → 模块与模型",
                "where": "在「模块与模型」查看模型分配，向下查找执行并发、记忆节奏与配方。"
              }
            ],
            "caveats": [
              "正式资料使用当前精确证据，范围提取使用当前范围。",
              "没有可保存的新结论也可能是有效结果；暂停、取消和重试按该任务的实际状态提供。"
            ],
            "condition": null
          },
          {
            "id": "C26",
            "priority": "core",
            "title": "回答需要你澄清的问题",
            "purpose": "在相关工作或资料中补充信息，帮助 Mote 处理这份输入的疑问。",
            "actions": [
              "打开限定范围的问题",
              "查看相关原件",
              "自由文字或选项回复",
              "稍后回答",
              "说明不知道或结束",
              "有新信息时重新打开"
            ],
            "target": {
              "pageId": "ask",
              "href": "#/ask",
              "collectionId": null,
              "categoryId": null,
              "label": "问一问",
              "path": "问一问中的待澄清问题；活动详情 / 资料来源上下文 → 需要你补充",
              "where": "在问一问历史、活动详情或资料上下文查找「需要你补充」的问题入口。具体问题链接由现有对象提供。"
            },
            "otherTargets": [
              {
                "pageId": "activity",
                "href": "#/activity",
                "collectionId": null,
                "categoryId": null,
                "label": "活动",
                "path": "活动 → 工作详情 → 需要你补充",
                "where": "打开有澄清请求的工作。"
              },
              {
                "pageId": "archive",
                "href": "#/library?view=materials",
                "collectionId": "materials",
                "categoryId": null,
                "label": "全部资料",
                "path": "资料库 → 全部资料 → 来源与处理",
                "where": "查看资料上下文中的澄清请求。"
              }
            ],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "回答只用于对应输入。",
              "问题带版本；问题更新后，旧回复会被拒绝，需要重新核对。"
            ],
            "condition": "只有实际产生澄清问题时才出现；没有固定独立的全局问题页面。"
          },
          {
            "id": "A16",
            "priority": "advanced",
            "title": "核对记忆的历史和有效时间",
            "purpose": "查看某一时间有效的记忆、旧版本和替代或矛盾关系。",
            "actions": [
              "包含被替代与过期历史",
              "按时间查看有效记忆",
              "跟随替代或矛盾关系",
              "查看审核、生成和保存记录"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=memories",
              "collectionId": "memories",
              "categoryId": null,
              "label": "记忆",
              "path": "资料库 → 记忆 → 历史 / 截至时间筛选 → 记忆详情",
              "where": "在记忆筛选区切换历史或截至时间，然后打开卡片。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "开启完整历史时，截至时间筛选不可用。",
              "保存记录的导出不等于当时模型实际收到的输入。"
            ],
            "condition": "历史关联、审核和生成记录依所选记忆存在情况显示。"
          },
          {
            "id": "A17",
            "priority": "advanced",
            "title": "从一条当前记忆继续整理",
            "purpose": "以一条已发布整理记忆为起点，使用整合配方生成进一步整理结果。",
            "actions": [
              "选择整合配方",
              "核对默认模型和处理范围",
              "开始、取消或重试",
              "跟随结果"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=memories",
              "collectionId": "memories",
              "categoryId": null,
              "label": "记忆",
              "path": "资料库 → 记忆 → 可用记忆详情 → 从这条记忆开始整理",
              "where": "选择符合条件的当前整理记忆，点击「从这条记忆开始整理」。"
            },
            "otherTargets": [],
            "setup": "需要当前已发布的整理记忆版本及可用整合模型；事件资料不适用。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=model",
                "collectionId": null,
                "categoryId": "model",
                "label": "模块与模型",
                "path": "设置 → 模型与服务 → 模块与模型",
                "where": "在「模块与模型」查看模型分配，向下查找执行并发、记忆节奏与配方。"
              }
            ],
            "caveats": [
              "手动整理不会启用自动整合。",
              "整合模型可检索当前可读的相关来源；过时版本不能作为当前整合输入。"
            ],
            "condition": "只在当前、已发布且满足整合条件的整理记忆详情出现。"
          },
          {
            "id": "A18",
            "priority": "advanced",
            "title": "调整记忆策略和回顾节奏",
            "purpose": "设置提取历史窗口、整合与回顾节奏，以及默认、截图和来源的配方组合。",
            "actions": [
              "设置提取历史窗口",
              "设置整合、洞察与工作记忆控制和节奏",
              "选择默认、截图和来源的非空配方组合",
              "重试已停止的提取"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=model",
              "collectionId": null,
              "categoryId": "model",
              "label": "模块与模型",
              "path": "设置 → 模型与服务 → 模块与模型 → 记忆与洞察节奏",
              "where": "在「模块与模型」查看模型分配，向下查找执行并发、记忆节奏与配方。"
            },
            "otherTargets": [],
            "setup": "需要对应模块可用模型；保存这些设置会影响后续接收或任务，不等于切换整套插件方案。",
            "setupTargets": [],
            "caveats": [
              "除全局暂停外，新授权且就绪的输入持续入队。",
              "配方变更不会自动授权付费历史处理；截图和页面的默认策略分别设置。",
              "记忆配方定义要整理的输入和输出的记忆类型；整体记忆方案管理当前运行的实现，两者不同。"
            ],
            "condition": null
          }
        ]
      },
      {
        "id": "G10",
        "title": "生成洞察与回顾",
        "purpose": "按自己的方向生成有证据的回顾报告，或重新打开已有洞察。",
        "setting": "洞察需要可用模型；周期自动回顾在模块与模型的记忆与洞察节奏中控制。",
        "links": [
          {
            "pageId": "insights",
            "href": "#/library/insights",
            "collectionId": null,
            "categoryId": null,
            "label": "洞察",
            "path": "资料库工具 → 洞察；问一问 → 查看洞察；今天 → 最近洞察",
            "where": "在洞察页选择方向、范围和模型；已有报告列于历史。"
          }
        ],
        "units": [
          {
            "id": "C27",
            "priority": "core",
            "title": "生成并回看有证据的洞察",
            "purpose": "按自选方向或默认回顾生成报告，核对引用并重访已保存结果。",
            "actions": [
              "选择自定义方向或默认回顾",
              "选择全部资料或页面时间范围",
              "选择模型",
              "查看运行并停止、重试或恢复",
              "打开保存报告和证据"
            ],
            "target": {
              "pageId": "insights",
              "href": "#/library/insights",
              "collectionId": null,
              "categoryId": null,
              "label": "洞察",
              "path": "资料库工具 → 洞察；问一问 → 查看洞察；今天 → 最近洞察",
              "where": "在洞察页选择方向、范围和模型；已有报告列于历史。"
            },
            "otherTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=model",
                "collectionId": null,
                "categoryId": "model",
                "label": "模块与模型",
                "path": "设置 → 模型与服务 → 模块与模型 → 记忆与洞察节奏",
                "where": "在「模块与模型」查看模型分配，向下查找执行并发、记忆节奏与配方。"
              }
            ],
            "setup": "需要配置对应洞察模型；周期自动洞察在记忆与洞察节奏中单独控制。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=model",
                "collectionId": null,
                "categoryId": "model",
                "label": "模块与模型",
                "path": "设置 → 模型与服务 → 模块与模型",
                "where": "在「模块与模型」查看模型分配，向下查找执行并发、记忆节奏与配方。"
              }
            ],
            "caveats": [
              "失败或因证据失效的报告与已保存可用报告不同。"
            ],
            "condition": null
          }
        ]
      }
    ]
  },
  {
    "id": "manage",
    "title": "跟进与管理",
    "description": "了解正在进行的工作，管理待办，查看统计和备份。",
    "groups": [
      {
        "id": "G11",
        "title": "跟进工作与失败恢复",
        "purpose": "查看工作进度、分支、结果和需要补充的信息，继续排查技术步骤。",
        "setting": "先看活动的工作详情；具体取消或恢复操作按任务当前状态提供。",
        "links": [
          {
            "pageId": "activity",
            "href": "#/activity",
            "collectionId": null,
            "categoryId": null,
            "label": "活动",
            "path": "活动；资料库 → 处理任务",
            "where": "选择一项工作，查看进度、结果及相关操作。"
          }
        ],
        "units": [
          {
            "id": "C28",
            "priority": "core",
            "title": "查看正在做的工作和结果",
            "purpose": "集中查看 Mote 的工作、需要关注的问题、执行分支和完成结果。",
            "actions": [
              "筛选进行中、需要关注或已完成",
              "打开一项工作",
              "查看进度、事件、分支、结果和证据",
              "打开相关操作",
              "进入技术记录"
            ],
            "target": {
              "pageId": "activity",
              "href": "#/activity",
              "collectionId": null,
              "categoryId": null,
              "label": "活动",
              "path": "活动；资料库 → 处理任务",
              "where": "选择一项工作，查看进度、结果及相关操作。"
            },
            "otherTargets": [
              {
                "pageId": "activity",
                "href": "#/activity",
                "collectionId": null,
                "categoryId": null,
                "label": "活动",
                "path": "活动",
                "where": "进入后按页面中的名称操作。"
              }
            ],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "活动汇总实际产品工作，技术执行细节在次级入口。",
              "空列表不能证明后台能力不存在。"
            ],
            "condition": null
          },
          {
            "id": "A25",
            "priority": "advanced",
            "title": "检查技术步骤并恢复可重试工作",
            "purpose": "深入查看任务依赖、尝试和失败原因，找到负责该工作的设置或恢复入口。",
            "actions": [
              "筛选技术任务状态和类型",
              "打开技术任务",
              "查看步骤、依赖、尝试和下一可执行步骤",
              "打开对应来源或设置",
              "在提供入口时重试索引或上下文步骤"
            ],
            "target": {
              "pageId": "processing",
              "href": "#/system/processing",
              "collectionId": null,
              "categoryId": null,
              "label": "技术执行记录",
              "path": "活动 → 高级 / 工作详情 → 技术执行记录",
              "where": "活动的高级入口，或工作详情中的技术记录；也可由插件运行记录进入。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "技术记录用于观察和指定恢复操作，不是另一套任务授权。",
              "只有页面明确提供的步骤才能重试。"
            ],
            "condition": "步骤详情和重试依已有技术任务及其失败状态显示。"
          }
        ]
      },
      {
        "id": "G12",
        "title": "待办与日程建议",
        "purpose": "记录普通待办；审核日程建议，再交给选中的设备日历执行。",
        "setting": "日程发现与审核在行动页；可写日历和系统权限由设备端提供。",
        "links": [
          {
            "pageId": "actions",
            "href": "#/actions",
            "collectionId": null,
            "categoryId": null,
            "label": "行动",
            "path": "今天 → 行动建议 → 待办",
            "where": "进入行动页的待办区域。"
          }
        ],
        "units": [
          {
            "id": "C29",
            "priority": "core",
            "title": "记录和完成普通待办",
            "purpose": "添加标题和可选到期时间，管理完成、取消或重新打开的待办。",
            "actions": [
              "添加标题和可选到期时间",
              "筛选未完成、已完成或已取消",
              "完成、取消或重新打开",
              "查看支持证据"
            ],
            "target": {
              "pageId": "actions",
              "href": "#/actions",
              "collectionId": null,
              "categoryId": null,
              "label": "行动",
              "path": "今天 → 行动建议 → 待办",
              "where": "进入行动页的待办区域。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "完成待办不会创建日历事件。",
              "当前没有待办删除或编辑标题的入口。"
            ],
            "condition": null
          },
          {
            "id": "C30",
            "priority": "core",
            "title": "审核日程建议并交给设备执行",
            "purpose": "查看有证据的日程建议，核对内容和目标日历后确认，跟踪设备的执行结果。",
            "actions": [
              "启用发现并设置时区和审核设备",
              "筛选建议、待执行或全部",
              "打开证据",
              "核对或修改日期、标题、地点和时区",
              "选择设备与已有日历",
              "确认或忽略",
              "查看等待、不确定和成功状态"
            ],
            "target": {
              "pageId": "actions",
              "href": "#/actions",
              "collectionId": null,
              "categoryId": null,
              "label": "行动",
              "path": "今天 → 行动建议",
              "where": "行动页中开启建议发现；选中建议打开审核，选择已有设备日历。"
            },
            "otherTargets": [],
            "setup": "需要 Mac / Android 客户端连接、报告可写日历并具备设备端日历权限；由原生客户端执行已确认建议。",
            "setupTargets": [],
            "caveats": [
              "支持创建、更新、取消和标记完成；标记完成只改变 Mote 状态。",
              "中央节点不直接写 Google 日历；网页没有设备日历权限或采集启动控制。",
              "执行结果不确定时先核对已有日程，避免盲目重复写入。"
            ],
            "condition": "审核需要已有建议；目标日历需要设备端已提供可写日历。"
          }
        ]
      },
      {
        "id": "G07",
        "title": "按分类回看与查看时间",
        "purpose": "查看片段、文件、应用活动和媒体播放的专用视图；处理状态集中在处理任务。",
        "setting": "资料库分类是内容视图；设备端负责采集，时间统计只基于实际观测。",
        "links": [
          {
            "pageId": "archive",
            "href": "#/library?view=materials",
            "collectionId": "materials",
            "categoryId": null,
            "label": "全部资料",
            "path": "资料库 → 分类",
            "where": "使用资料库分类切换视图；导入、随手记和洞察属于「资料库工具」。"
          },
          {
            "pageId": "archive",
            "href": "#/library?view=activity",
            "collectionId": "activity",
            "categoryId": null,
            "label": "应用活动",
            "path": "资料库 → 应用活动",
            "where": "查看应用时长汇总。"
          }
        ],
        "units": [
          {
            "id": "C19",
            "priority": "core",
            "title": "按内容类型查看资料库",
            "purpose": "在同一资料库切换分类，找到片段、来源、文件、活动、记忆和处理视图。",
            "actions": [
              "查看片段、来源资料和文件与录音",
              "查看应用活动、媒体播放和记忆",
              "在处理任务查看 Coding 会话接收状态"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=materials",
              "collectionId": "materials",
              "categoryId": null,
              "label": "全部资料",
              "path": "资料库 → 分类",
              "where": "使用资料库分类切换视图；导入、随手记和洞察属于「资料库工具」。"
            },
            "otherTargets": [
              {
                "pageId": "archive",
                "href": "#/library?view=records",
                "collectionId": "records",
                "categoryId": null,
                "label": "原始采集记录",
                "path": "资料库 → 原始采集记录",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "archive",
                "href": "#/library?view=segments",
                "collectionId": "segments",
                "categoryId": null,
                "label": "片段",
                "path": "资料库 → 片段",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "archive",
                "href": "#/library?view=sources",
                "collectionId": "sources",
                "categoryId": null,
                "label": "来源资料",
                "path": "资料库 → 来源资料",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "archive",
                "href": "#/library?view=files",
                "collectionId": "files",
                "categoryId": null,
                "label": "文件与录音",
                "path": "资料库 → 文件与录音",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "archive",
                "href": "#/library?view=activity",
                "collectionId": "activity",
                "categoryId": null,
                "label": "应用活动",
                "path": "资料库 → 应用活动",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "archive",
                "href": "#/library?view=media",
                "collectionId": "media",
                "categoryId": null,
                "label": "媒体播放",
                "path": "资料库 → 媒体播放",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "archive",
                "href": "#/library?view=memories",
                "collectionId": "memories",
                "categoryId": null,
                "label": "记忆",
                "path": "资料库 → 记忆",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "activity",
                "href": "#/activity",
                "collectionId": null,
                "categoryId": null,
                "label": "活动",
                "path": "活动",
                "where": "查看产品工作，并展开 Coding 会话接收状态。"
              }
            ],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "资料库分类是已有内容的视图；Coding 接收状态在处理任务内查看，已发布正文在全部资料阅读。"
            ],
            "condition": null
          },
          {
            "id": "A12",
            "priority": "advanced",
            "title": "按截图片段或应用相册回看",
            "purpose": "按日期和设备查看连续会话或应用分组，打开组内采集证据。",
            "actions": [
              "选择日期和设备",
              "选择会话或应用 15 分钟分组",
              "翻页",
              "打开分组或采集记录"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=segments",
              "collectionId": "segments",
              "categoryId": null,
              "label": "片段",
              "path": "资料库 → 片段",
              "where": "选择日期、设备和分组方式，再打开片段。"
            },
            "otherTargets": [],
            "setup": "需要原生客户端已采集并同步的截图记录。",
            "setupTargets": [],
            "caveats": [
              "连续同应用记录在超过 5 分钟间隔或切换应用时分段。",
              "观测跨度不等于实际使用时长。"
            ],
            "condition": null
          },
          {
            "id": "A13",
            "priority": "advanced",
            "title": "查看测得的应用活动时间",
            "purpose": "查看采样得到的各应用时长和占比，理解其统计范围。",
            "actions": [
              "查看采样时长",
              "查看各应用占比"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=activity",
              "collectionId": "activity",
              "categoryId": null,
              "label": "应用活动",
              "path": "资料库 → 应用活动",
              "where": "查看应用时长汇总。"
            },
            "otherTargets": [],
            "setup": "需要设备端采集并同步应用活动记录。",
            "setupTargets": [],
            "caveats": [
              "同一设备的重叠观测会去重，不同设备分别计时。",
              "未采样的间隔不会补齐，也不能从时长推断注意力或工作成果。"
            ],
            "condition": null
          },
          {
            "id": "A14",
            "priority": "advanced",
            "title": "查看媒体播放观测",
            "purpose": "查看播放器、标题、状态和播放进度，核对按设备统计的播放观测。",
            "actions": [
              "查看应用、状态、标题、进度和媒体信息",
              "查看分布及设备汇总",
              "打开相关证据"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=media",
              "collectionId": "media",
              "categoryId": null,
              "label": "媒体播放",
              "path": "资料库 → 媒体播放",
              "where": "查看媒体汇总并展开记录信息。"
            },
            "otherTargets": [],
            "setup": "需要 Android 客户端开启媒体采集并授予系统权限；此权限在设备端设置。",
            "setupTargets": [],
            "caveats": [
              "媒体观测不会录制音频。",
              "媒体时长与前台应用时长不能相加；间隙、暂停和未知状态不计为播放。"
            ],
            "condition": null
          },
          {
            "id": "A15",
            "priority": "advanced",
            "title": "查看 Coding 会话接收与同步状态",
            "purpose": "在处理任务中核对 Coding 增量接收、会话发布、索引与记忆进度，再打开已发布正文。",
            "actions": [
              "查看当前页来源、事件接收数量和字节",
              "分别核对正文发布、索引和记忆状态",
              "打开此来源已发布的会话正文"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=coding-status",
              "collectionId": "coding-status",
              "categoryId": null,
              "label": "Coding 会话同步状态",
              "path": "新增数据源 → Coding Agent 会话",
              "where": "分别核对正文发布、索引和记忆状态",
              "requiredCollectionIds": ["coding-status"],
              "requires": [
                "http:GET:/api/coding/uploads"
              ]
            },
            "otherTargets": [
              {
                "pageId": "archive",
                "href": "#/library?view=materials",
                "collectionId": "materials",
                "categoryId": null,
                "label": "全部资料",
                "path": "资料库 → 全部资料",
                "where": "查看已发布的会话正文。"
              }
            ],
            "setup": "先安装并连接 Mac 客户端，在客户端「来源 → 连接 Coding Agent」选择本机已有的 Agent 与采集范围。中央 Web 查看同步结果。",
            "setupTargets": [
              {
                "pageId": "sourceCatalog",
                "href": "#/connections/add",
                "collectionId": null,
                "categoryId": null,
                "label": "新增数据源",
                "path": "新增数据源 → Coding Agent 会话",
                "where": "查看客户端接入与同步状态。"
              }
            ],
            "caveats": [
              "接收成功或任务完成不代表源会话内容完整；请在正文中核对覆盖范围和缺片提示。",
              "原始增量事件包保留为私有原件；已发布对话正文在「全部资料」读取。"
            ],
            "condition": "具体进度依已接收来源显示；没有来源时会显示客户端接入步骤。"
          }
        ]
      },
      {
        "id": "G15",
        "title": "备份、存储、索引与费用",
        "purpose": "导入导出归档，核对空间与保留政策，并检查索引和模型用量。",
        "setting": "完整备份在中央机器离线执行；保留与容量修改需应用部署草稿并重启。",
        "links": [
          {
            "pageId": "vault",
            "href": "#/system/storage",
            "collectionId": null,
            "categoryId": null,
            "label": "存储、加密与备份",
            "path": "设置 → 存储、加密与备份 → 导入与导出 / 索引与 Agent",
            "where": "查看「导入与导出」「大资料库适合使用离线备份」以及索引区域。"
          },
          {
            "pageId": "usage",
            "href": "#/system/usage",
            "collectionId": null,
            "categoryId": null,
            "label": "用量与费用",
            "path": "设置 → 用量与费用",
            "where": "设置筛选，查看汇总、趋势和运行明细。"
          }
        ],
        "units": [
          {
            "id": "C39",
            "priority": "core",
            "title": "导入导出归档并找到完整备份",
            "purpose": "导出可携带的资料或元数据，合并当前归档，检查索引并找到离线备份方式。",
            "actions": [
              "导出元数据或资料与附件",
              "导入当前 Mote v2 JSON",
              "找到离线备份命令",
              "查看索引队列和失败数",
              "重试索引"
            ],
            "target": {
              "pageId": "vault",
              "href": "#/system/storage",
              "collectionId": null,
              "categoryId": null,
              "label": "存储、加密与备份",
              "path": "设置 → 存储、加密与备份 → 导入与导出 / 索引与 Agent",
              "where": "查看「导入与导出」「大资料库适合使用离线备份」以及索引区域。"
            },
            "otherTargets": [],
            "setup": "网页导入当前 Mote v2 JSON；完整资料库备份需要按页面命令在中央机器离线执行。",
            "setupTargets": [],
            "caveats": [
              "便携 JSON 导入会合并并去重，不支持跨存储代际迁移。",
              "便携导出不是完整历史、插件和凭据备份；完整资料库使用离线备份。",
              "归档存在、正文发布、检索索引和记忆准备是独立状态。"
            ],
            "condition": null
          },
          {
            "id": "C40",
            "priority": "core",
            "title": "查看保留、容量和内容存储政策",
            "purpose": "查看实际空间和保留情况，控制未来文件加密，并找到部署层保留与容量配置。",
            "actions": [
              "查看空间、数量、最早记录和保留状态",
              "找到未来写入加密开关",
              "查看保留与容量草稿及实际生效值"
            ],
            "target": {
              "pageId": "vault",
              "href": "#/system/storage",
              "collectionId": null,
              "categoryId": null,
              "label": "存储、加密与备份",
              "path": "设置 → 存储、加密与备份 → 内容存储 / 数据与备份",
              "where": "查看内容存储政策和数据概览；保留与容量修改位于模型与服务。"
            },
            "otherTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=storage",
                "collectionId": null,
                "categoryId": "storage",
                "label": "保留与容量",
                "path": "设置 → 模型与服务 → 保留与容量",
                "where": "在「保留与容量」编辑并校验部署草稿，核对当前生效值。"
              }
            ],
            "setup": "未来文件加密可直接保存；保留与容量是部署草稿，需合并配置并重启后应用。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=storage",
                "collectionId": null,
                "categoryId": "storage",
                "label": "保留与容量",
                "path": "设置 → 模型与服务 → 保留与容量",
                "where": "在「保留与容量」编辑并校验部署草稿，核对当前生效值。"
              }
            ],
            "caveats": [
              "未来图片和原件加密不会加密 SQLite 正文或索引，也不会改写已有文件。"
            ],
            "condition": null
          },
          {
            "id": "C41",
            "priority": "core",
            "title": "核对模型用量和估算费用",
            "purpose": "按日期、模块、模型和状态查看请求、Token、缓存、耗时及费用明细。",
            "actions": [
              "筛选日期、模块、模型和状态",
              "查看 Token、缓存、运行、时长、成功和费用汇总",
              "查看每日趋势",
              "打开运行明细"
            ],
            "target": {
              "pageId": "usage",
              "href": "#/system/usage",
              "collectionId": null,
              "categoryId": null,
              "label": "用量与费用",
              "path": "设置 → 用量与费用",
              "where": "设置筛选，查看汇总、趋势和运行明细。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "未知、未上报或不完整用量不能当作零。",
              "按请求开始时价格计费，不同币种不相加；订阅扣费不能据此预测。"
            ],
            "condition": null
          },
          {
            "id": "A31",
            "priority": "advanced",
            "title": "把已有加密文件转为明文",
            "purpose": "关闭未来加密后，按需安排已有内容对象解密，并查看后台转换进度。",
            "actions": [
              "关闭加密",
              "启动批量解密",
              "查看总量和失败",
              "取消或重试"
            ],
            "target": {
              "pageId": "vault",
              "href": "#/system/storage",
              "collectionId": null,
              "categoryId": null,
              "label": "存储、加密与备份",
              "path": "设置 → 存储、加密与备份 → 内容存储",
              "where": "关闭加密后查看已有文件的批量解密入口。"
            },
            "otherTargets": [],
            "setup": "仅在内容加密已关闭后可启动已有对象转换。",
            "setupTargets": [],
            "caveats": [
              "任务离开页面后继续；取消会保留已完成的转换。",
              "凭据不参与转换；混合明文与加密内容仍可读取。"
            ],
            "condition": "有可转换的加密对象，且未来写入加密已关闭时才能执行。"
          },
          {
            "id": "A32",
            "priority": "advanced",
            "title": "查看运行状态与空间",
            "purpose": "按类型和日期查看中央机器可访问文件的字节与数量，并进入模型用量。",
            "actions": [
              "查看按类型与日期的字节、文件数",
              "选择 7 天、30 天或全部",
              "刷新",
              "打开用量"
            ],
            "target": {
              "pageId": "statistics",
              "href": "#/system",
              "collectionId": null,
              "categoryId": null,
              "label": "运行状态与空间",
              "path": "设置 → 运行状态与空间",
              "where": "在「运行状态与空间」查看中央节点磁盘统计，或打开用量与费用。"
            },
            "otherTargets": [
              {
                "pageId": "usage",
                "href": "#/system/usage",
                "collectionId": null,
                "categoryId": null,
                "label": "用量与费用",
                "path": "运行状态 → 用量与费用",
                "where": "进入后按页面中的名称操作。"
              }
            ],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "日期分布按 UTC 修改时间统计，不代表每天新增了多少数据。",
              "无法访问的文件会使结果不完整。"
            ],
            "condition": null
          },
          {
            "id": "A33",
            "priority": "advanced",
            "title": "维护估价并追查用量明细",
            "purpose": "按 Agent、模块、技能或模型汇总，逐层筛选请求，并维护后续请求使用的价格。",
            "actions": [
              "选择 Agent、模块、技能或模型汇总",
              "点击行、日期或模型筛选",
              "翻页查看明细",
              "设置模型、厂商、币种及缓存价格"
            ],
            "target": {
              "pageId": "usage",
              "href": "#/system/usage",
              "collectionId": null,
              "categoryId": null,
              "label": "用量与费用",
              "path": "设置 → 用量与费用 → 汇总 / 价格",
              "where": "切换汇总方式并点击数据行；展开价格设置。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "已保存价格用于未来请求，历史费用固定。",
              "已经计量的失败工作也纳入用量。"
            ],
            "condition": null
          }
        ]
      }
    ]
  },
  {
    "id": "settings",
    "title": "设置与维护",
    "description": "找到模型和处理设置、自动记忆控制与排查入口。",
    "groups": [
      {
        "id": "G13",
        "title": "模型、图片、文件与语音",
        "purpose": "连接模型并分配给模块，设置识字、画面理解、转写和文件处理。",
        "setting": "先检查模型连接与对应功能的模型分配；已有可用默认可保留。并发与执行参数属于高级设置，部署草稿另需合并并重启。",
        "links": [
          {
            "pageId": "settings",
            "href": "#/system/models",
            "collectionId": null,
            "categoryId": null,
            "label": "模型与服务",
            "path": "设置 → 模型与服务",
            "where": "进入后按页面中的名称操作。"
          }
        ],
        "units": [
          {
            "id": "C31",
            "priority": "core",
            "title": "配置或检查模型连接（Provider）",
            "purpose": "查看或保存模型连接的地址、凭据和模型，再核对实际生效配置。",
            "actions": [
              "创建预设",
              "选择厂商、协议和服务地址",
              "选择或填写模型",
              "保留、替换或清除凭据",
              "保存并查看生效配置",
              "测试连接"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=providers",
              "collectionId": null,
              "categoryId": "providers",
              "label": "模型连接（Provider）",
              "path": "设置 → 模型与服务 → 模型连接（Provider）",
              "where": "在「模型连接（Provider）」创建或选择预设，选中后查看编辑器与高级设置。"
            },
            "otherTargets": [],
            "setup": "已有可用连接可保留。API 连接需对应地址和凭据；Codex 使用中央机器已登录的 Codex CLI，界面 API Key 不能代替。",
            "setupTargets": [],
            "caveats": [
              "部署预设只读，可复制为自定义预设。",
              "连接测试会发送生成内容，可能产生模型费用；测试不会保存编辑草稿。"
            ],
            "condition": null
          },
          {
            "id": "C32",
            "priority": "core",
            "title": "检查或分配功能使用的模型",
            "purpose": "检查问答、记忆、回顾等功能当前用的连接和模型，按需为要使用的模块分配。",
            "actions": [
              "为各模块选择 Provider 和模型",
              "保存分配",
              "找到记忆、洞察和工作记忆设置"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=model",
              "collectionId": null,
              "categoryId": "model",
              "label": "模块与模型",
              "path": "设置 → 模型与服务 → 模块与模型",
              "where": "在「模块与模型」查看模型分配，向下查找执行并发、记忆节奏与配方。"
            },
            "otherTargets": [],
            "setup": "先检查现有连接和该功能的分配；已有可用默认无需新建预设，也无需修改所有模块。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=providers",
                "collectionId": null,
                "categoryId": "providers",
                "label": "模型连接（Provider）",
                "path": "设置 → 模型与服务 → 模型连接（Provider）",
                "where": "在「模型连接（Provider）」创建或选择预设，选中后查看编辑器与高级设置。"
              }
            ],
            "caveats": [
              "保存后新请求生效，无需重启。",
              "请求指定模型优先；文件处理器的明确模型或本地限制仍具有优先级。"
            ],
            "condition": null
          },
          {
            "id": "C36",
            "priority": "core",
            "title": "控制新图片识别与原图授权",
            "purpose": "为截图、上传、同步和笔记图片设置识字、理解方式，并单独决定问答模型能否读原图。",
            "actions": [
              "启用新图片自动处理",
              "选择图片或 OCR 方案",
              "启用画面理解",
              "查看模型配置或下载状态",
              "允许远程 OCR",
              "允许问答模型读取归档原图",
              "保存"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=images",
              "collectionId": null,
              "categoryId": "images",
              "label": "图片",
              "path": "设置 → 模型与服务 → 图片",
              "where": "在「图片」查看统一处理与授权，历史任务位于「处理已有图片」。"
            },
            "otherTargets": [],
            "setup": "原件先保存；识字或理解需要所选方案的模型和安装状态就绪。",
            "setupTargets": [],
            "caveats": [
              "识字、后台理解和问答原图读取是分别控制的。",
              "设置变化不代表已经授权处理所有历史图片。"
            ],
            "condition": null
          },
          {
            "id": "C37",
            "priority": "core",
            "title": "查看文件或录音的内容提取和恢复",
            "purpose": "核对原件、正文、转写及摘要状态，下载或播放原件，处理可取消或重试的阶段。",
            "actions": [
              "区分原件、提取正文和摘要状态",
              "打开图片或音频",
              "下载原件",
              "展开转写或文字分块",
              "取消或重试提取",
              "在支持时重试摘要或说话人分离"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=files",
              "collectionId": "files",
              "categoryId": null,
              "label": "文件与录音",
              "path": "资料库 → 文件与录音 → 文件详情；导入 → 媒体详情",
              "where": "选择一个文件或录音，查看原件、文本与处理控制。"
            },
            "otherTargets": [],
            "setup": "需要仍保留的原件；内容处理依赖文件与语音设置及对应模型。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=file-processing",
                "collectionId": null,
                "categoryId": "file-processing",
                "label": "文件与语音",
                "path": "设置 → 模型与服务 → 文件与语音",
                "where": "在「文件与语音」查看模型安装、规则、方案与服务，具体操作在对应区域。"
              }
            ],
            "caveats": [
              "原件过期后中央文字索引可能仍在，但无法加载原件。",
              "取消中的调用与未知物理调用状态会影响重试；未知状态重试需确认可能重复处理的风险。"
            ],
            "condition": "恢复操作依文件处理状态和处理器能力显示。"
          },
          {
            "id": "C38",
            "priority": "core",
            "title": "配置文件与语音处理",
            "purpose": "启用中央处理，安装所需本地语音模型，并按文件类型选择处理方案。",
            "actions": [
              "启用中央文件处理",
              "找到并安装本地音频模型",
              "设置单文件时长与超时",
              "为类型选择可用方案",
              "保存"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=file-processing",
              "collectionId": null,
              "categoryId": "file-processing",
              "label": "文件与语音",
              "path": "设置 → 模型与服务 → 文件与语音",
              "where": "在「文件与语音」查看模型安装、规则、方案与服务，具体操作在对应区域。"
            },
            "otherTargets": [],
            "setup": "本地语音识别和匿名说话人处理需要模型安装就绪；其他处理器按可信插件实际提供的能力配置。",
            "setupTargets": [],
            "caveats": [
              "文件处理的 PDF 选项来自加载的可信插件；导入解码器的文档支持另有范围。",
              "当前没有每日硬配额；不能把接口设置解释为任意厂商协议兼容。"
            ],
            "condition": null
          },
          {
            "id": "A19",
            "priority": "advanced",
            "title": "调整模型性能和协议细节",
            "purpose": "在预设中调整推理、速度、超时及协议参数，并确认敏感地址或凭据变更。",
            "actions": [
              "调整推理、速度、超时和输出限制",
              "设置请求头或高级参数",
              "允许无认证本机服务",
              "更换地址后明确确认复用凭据"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=providers",
              "collectionId": null,
              "categoryId": "providers",
              "label": "模型连接（Provider）",
              "path": "设置 → 模型与服务 → 模型连接（Provider） → 预设编辑 → 高级",
              "where": "在「模型连接（Provider）」创建或选择预设，选中后查看编辑器与高级设置。"
            },
            "otherTargets": [],
            "setup": "需要选中模型预设；可用 Codex 模式按当前模型目录校验。",
            "setupTargets": [],
            "caveats": [
              "编辑草稿与实际生效配置分开显示；测试连接不保存草稿。",
              "保存冲突时需重新核对当前版本。"
            ],
            "condition": null
          },
          {
            "id": "A20",
            "priority": "advanced",
            "title": "复制或删除模型预设",
            "purpose": "复用已有连接设置，或清理未使用的自定义预设。",
            "actions": [
              "复制预设并选择是否复制密钥",
              "删除未被模块使用的预设"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=providers",
              "collectionId": null,
              "categoryId": "providers",
              "label": "模型连接（Provider）",
              "path": "设置 → 模型与服务 → 模型连接（Provider） → 选中预设",
              "where": "在「模型连接（Provider）」创建或选择预设，选中后查看编辑器与高级设置。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "部署预设只读；删除正在使用的预设前需重新分配模块。",
              "密钥不会返回显示；复制密钥在服务器端执行。"
            ],
            "condition": "删除仅对允许删除且未被使用的自定义预设提供。"
          },
          {
            "id": "A21",
            "priority": "advanced",
            "title": "补处理或重算历史图片",
            "purpose": "明确选择历史日期与来源，预览数量后安排补齐或重新计算。",
            "actions": [
              "选择日期和来源",
              "选择补齐或重算",
              "预览数量",
              "安排全部",
              "查看批次与步骤进度"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=images",
              "collectionId": null,
              "categoryId": "images",
              "label": "图片",
              "path": "设置 → 模型与服务 → 图片 → 处理已有图片",
              "where": "在「图片」查看统一处理与授权，历史任务位于「处理已有图片」。"
            },
            "otherTargets": [],
            "setup": "先配置图片方案，再明确选择历史范围并确认安排；这是独立的历史处理授权。",
            "setupTargets": [],
            "caveats": [
              "补齐会复用已有结果；重算创建新修订。",
              "修改设置或安装组件不会自动授予历史重算。"
            ],
            "condition": null
          },
          {
            "id": "A22",
            "priority": "advanced",
            "title": "配置文件规则、方案和处理服务",
            "purpose": "为文件类型或特定来源选择处理方案，设置模型、摘要和服务连接。",
            "actions": [
              "增加或删除 MIME 规则",
              "创建、复制或删除方案",
              "选择处理器、参数、模型和摘要",
              "创建或移除来源覆盖",
              "配置本地或远程服务及密钥",
              "检查已保存的本地服务"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=file-processing",
              "collectionId": null,
              "categoryId": "file-processing",
              "label": "文件与语音",
              "path": "设置 → 模型与服务 → 文件与语音",
              "where": "在「文件与语音」查看模型安装、规则、方案与服务，具体操作在对应区域。"
            },
            "otherTargets": [],
            "setup": "可设置字段由已加载的可信处理器提供；服务检查使用已保存配置。",
            "setupTargets": [],
            "caveats": [
              "优先级为来源精确、来源通配、全局精确、全局通配、其他。",
              "远程服务需 HTTPS；本地多人转写绑定本地服务，不等于任意厂商协议兼容。"
            ],
            "condition": null
          },
          {
            "id": "A23",
            "priority": "advanced",
            "title": "预览文件规则并重新处理已有原件",
            "purpose": "用已保存规则试算 MIME 匹配，选择已有原件，核对预览后排队。",
            "actions": [
              "试算 MIME 匹配",
              "筛选来源和类型",
              "预览重新处理",
              "确认加入队列"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=file-processing",
              "collectionId": null,
              "categoryId": "file-processing",
              "label": "文件与语音",
              "path": "设置 → 模型与服务 → 文件与语音 → 规则试算与已有文件",
              "where": "在「文件与语音」查看模型安装、规则、方案与服务，具体操作在对应区域。"
            },
            "otherTargets": [],
            "setup": "先保存处理配置；预览仅针对当前原件。",
            "setupTargets": [],
            "caveats": [
              "每次预览最多 100 份当前原件，有效期 10 分钟。",
              "重处理后旧纠正可能失效；仅归档及 Shadow 方案跳过内容处理。"
            ],
            "condition": null
          },
          {
            "id": "A24",
            "priority": "advanced",
            "title": "纠正转写并确认说话人",
            "purpose": "手动校正文段、试听说话人样本，或让模型建议修改后逐项确认。",
            "actions": [
              "不调用模型直接纠正文段",
              "试听说话人样本",
              "确认匿名说话人的姓名",
              "请求日历场次或术语校对建议",
              "接受选中替换或拒绝",
              "继续下一批",
              "导出转写与说话人包"
            ],
            "target": {
              "pageId": "archive",
              "href": "#/library?view=files",
              "collectionId": "files",
              "categoryId": null,
              "label": "文件与录音",
              "path": "资料库 → 文件与录音 → 文件详情 → 文段 / 说话人试听与命名 / 复核",
              "where": "打开有转写的文件详情，查看文段、说话人和复核入口。"
            },
            "otherTargets": [],
            "setup": "手动文本纠正无需模型；模型建议需要对应可用模型，试听需要保留的音频。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=model",
                "collectionId": null,
                "categoryId": "model",
                "label": "模块与模型",
                "path": "设置 → 模型与服务 → 模块与模型",
                "where": "在「模块与模型」查看模型分配，向下查找执行并发、记忆节奏与配方。"
              }
            ],
            "caveats": [
              "模型只提出建议，姓名与替换由你确认；不确定或重叠发言应回听。",
              "原件与转写保留；tar.gz 导出包不含需另行下载的原始音频。"
            ],
            "condition": "需要已有转写；说话人、试听和模型复核按文件产物及处理能力出现。"
          },
          {
            "id": "A29",
            "priority": "advanced",
            "title": "设置执行并发和查看等待名额",
            "purpose": "调整问答和后台执行的同时工作数量，了解哪些工作在排队。",
            "actions": [
              "设置交互、后台 Agent、Harness 和记忆并发",
              "查看当前执行与等待容量",
              "保存并应用"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=model",
              "collectionId": null,
              "categoryId": "model",
              "label": "模块与模型",
              "path": "设置 → 模型与服务 → 模块与模型 → 执行并发",
              "where": "在「模块与模型」查看模型分配，向下查找执行并发、记忆节奏与配方。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "超过名额的工作排队；降低并发不会中断正在执行的任务。",
              "并发名额不是每日、Token 或费用硬预算。"
            ],
            "condition": null
          },
          {
            "id": "A30",
            "priority": "advanced",
            "title": "配置检索和外部连接的部署草稿",
            "purpose": "准备向量检索、来源间隔、MCP 和 OAuth 的配置差异，交给部署机器应用。",
            "actions": [
              "设置向量模型与地址",
              "设置来源同步间隔",
              "启用 MCP 读写及来源允许列表",
              "设置 OAuth 回调",
              "校验并下载环境配置差异",
              "刷新实际生效值"
            ],
            "target": {
              "pageId": "settings",
              "href": "#/system/models?category=embedding",
              "collectionId": null,
              "categoryId": "embedding",
              "label": "检索索引",
              "path": "设置 → 模型与服务 → 检索索引 / 来源与外部应用",
              "where": "在「检索索引」编辑并校验部署草稿，核对当前生效值。"
            },
            "otherTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=connectors",
                "collectionId": null,
                "categoryId": "connectors",
                "label": "来源与外部应用",
                "path": "设置 → 模型与服务 → 来源与外部应用",
                "where": "在「来源与外部应用」编辑并校验部署草稿，核对当前生效值。"
              }
            ],
            "setup": "下载的差异需在部署机器合并并保留密钥后重启；向量 Key 和 Google OAuth 密钥在部署机器配置。",
            "setupTargets": [
              {
                "pageId": "settings",
                "href": "#/system/models?category=connectors",
                "collectionId": null,
                "categoryId": "connectors",
                "label": "来源与外部应用",
                "path": "设置 → 模型与服务 → 来源与外部应用",
                "where": "在「来源与外部应用」编辑并校验部署草稿，核对当前生效值。"
              }
            ],
            "caveats": [
              "草稿尚未应用时不会改变运行节点；「当前生效值」单独显示。",
              "未配置向量模型时仍保留文字检索。"
            ],
            "condition": null
          }
        ]
      },
      {
        "id": "G14",
        "title": "自动记忆与可信插件方案",
        "purpose": "管理自动记忆接收；配置可信实例，验证后应用当前运行的整体记忆方案。",
        "setting": "暂停会让旧授权工作继续收尾；立即停止会撤销。安装、启用和应用方案是不同步骤。",
        "links": [
          {
            "pageId": "extensions",
            "href": "#/system/plugins?tab=memory",
            "collectionId": null,
            "categoryId": null,
            "label": "自动记忆控制",
            "path": "设置 → 自动记忆与插件 → 记忆方案 → 自动记忆",
            "where": "在当前记忆方案中查看「自动记忆」的状态和控制。"
          },
          {
            "pageId": "extensions",
            "href": "#/system/plugins",
            "collectionId": null,
            "categoryId": null,
            "label": "管理可信插件",
            "path": "设置 → 自动记忆与插件 → 已安装 / 发现",
            "where": "在「发现」选受支持发布；在「已安装」查看实例、配置、验证和启用。"
          }
        ],
        "units": [
          {
            "id": "C33",
            "priority": "core",
            "title": "暂停或立即停止自动记忆",
            "purpose": "控制全局新自动记忆的接收，并区分继续收尾与立即撤销旧工作。",
            "actions": [
              "暂停或恢复新的自动记忆接收",
              "查看收尾、排队、执行、检查点及未知计数",
              "确认后立即停止",
              "打开任务详情"
            ],
            "target": {
              "pageId": "extensions",
              "href": "#/system/plugins?tab=memory",
              "collectionId": null,
              "categoryId": null,
              "label": "自动记忆与插件",
              "path": "设置 → 自动记忆与插件 → 记忆方案 → 自动记忆",
              "where": "在当前记忆方案中查看「自动记忆」的状态和控制。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "暂停停止新自动工作入队，已授权旧工作继续收尾；立即停止会撤销或取消它们。",
              "归档、已有记忆和问答继续可用。",
              "恢复只接收后续新输入，不自动补处理暂停期间的历史；洞察和对话工作记忆各有控制。"
            ],
            "condition": null
          },
          {
            "id": "C34",
            "priority": "core",
            "title": "核对和替换整套记忆方案",
            "purpose": "查看当前运行的整套记忆实现，准备和验证替换，再单独应用已验证方案。",
            "actions": [
              "查看当前方案和模式",
              "查看内置、Mem0 和 Hindsight 可用方案",
              "预览替换",
              "声明已有授权历史范围并确认成本",
              "准备并查看迁移、验证",
              "单独应用",
              "重试或取消准备"
            ],
            "target": {
              "pageId": "extensions",
              "href": "#/system/plugins?tab=memory",
              "collectionId": null,
              "categoryId": null,
              "label": "自动记忆与插件",
              "path": "设置 → 自动记忆与插件 → 记忆方案",
              "where": "查看当前方案；选择替换目标后依次预览、准备、验证和应用。"
            },
            "otherTargets": [],
            "setup": "需要可用可信实例和目标方案；历史处理范围与费用需明确确认。",
            "setupTargets": [],
            "caveats": [
              "仅作用于默认空间；准备失败保留原绑定。",
              "已验证准备不等于已应用；安装组件也不等于激活方案或授权历史处理。",
              "模块高级视图只读，没有任意模块拼装或独立更换同权限检索的界面。"
            ],
            "condition": null
          },
          {
            "id": "C35",
            "priority": "core",
            "title": "管理可信记忆插件",
            "purpose": "从支持的固定版本发现、安装和配置实例，检查后启用或绑定方案。",
            "actions": [
              "选择目录、仓库和标签",
              "预览固定版本、能力、权限和依赖",
              "安装",
              "增加或配置声明式实例",
              "验证",
              "启用或禁用",
              "在允许时卸载"
            ],
            "target": {
              "pageId": "extensions",
              "href": "#/system/plugins",
              "collectionId": null,
              "categoryId": null,
              "label": "自动记忆与插件",
              "path": "设置 → 自动记忆与插件 → 已安装 / 发现",
              "where": "在「发现」选受支持发布；在「已安装」查看实例、配置、验证和启用。"
            },
            "otherTargets": [],
            "setup": "仅支持可信 GitHub 兼容发布或受支持的固定上游适配器；实例按自身字段和依赖配置。",
            "setupTargets": [],
            "caveats": [
              "安装、配置、检查、启用和绑定是不同步骤。",
              "不支持任意脚本或远程界面；需重启会提示，但页面不重启中央节点。",
              "Hindsight 验证可能调用真实模型并产生费用。"
            ],
            "condition": null
          }
        ]
      },
      {
        "id": "G01",
        "title": "登录、语言与页面入口",
        "purpose": "确认当前中央服务，选择浏览器会话期限，找到常用工作区。",
        "setting": "设置页管理语言、当前服务和会话；外部服务及受限 MCP 另行授权。",
        "links": [
          {
            "pageId": "about",
            "href": "#/preferences",
            "collectionId": null,
            "categoryId": null,
            "label": "设置",
            "path": "设置 → 当前服务（中央节点）",
            "where": "页面下方的「当前服务（中央节点）」和「登录会话有效期」；未登录时由目标页进入登录。"
          }
        ],
        "units": [
          {
            "id": "C01",
            "priority": "core",
            "title": "登录并管理当前会话",
            "purpose": "确认正在使用哪个中央节点，选择浏览器保留登录的时间，或退出当前会话。",
            "actions": [
              "使用管理令牌登录",
              "验证后回到原目的地",
              "选择当前窗口、1 天、7 天或 30 天会话",
              "退出登录"
            ],
            "target": {
              "pageId": "about",
              "href": "#/preferences",
              "collectionId": null,
              "categoryId": null,
              "label": "设置",
              "path": "设置 → 当前服务（中央节点）",
              "where": "页面下方的「当前服务（中央节点）」和「登录会话有效期」；未登录时由目标页进入登录。"
            },
            "otherTargets": [],
            "setup": "需要当前中央节点的管理令牌；登录只连接当前网页所属的中央节点。",
            "setupTargets": [],
            "caveats": [
              "浏览器与原生完整客户端会话拥有完整管理权限；受限 MCP 授权另行管理。",
              "退出会清除本地会话并撤销当前客户端凭据，不会更换根管理令牌。"
            ],
            "condition": null
          },
          {
            "id": "C02",
            "priority": "core",
            "title": "找到常用页面和所属工具",
            "purpose": "从五个主入口进入日常工作，再到各自的工具或设置继续操作。",
            "actions": [
              "打开今天、资料库、问一问、活动、采集与设备",
              "打开设置",
              "查找资料库工具",
              "查找来源与连接",
              "返回上级"
            ],
            "target": {
              "pageId": "overview",
              "href": "#/today",
              "collectionId": null,
              "categoryId": null,
              "label": "今天",
              "path": "主导航 → 今天 / 资料库 / 问一问 / 活动 / 采集与设备；设置",
              "where": "主导航切换工作区；资料库的「资料库工具」、采集与设备的「来源与连接」选择框进入所属工具。"
            },
            "otherTargets": [
              {
                "pageId": "archive",
                "href": "#/library?view=materials",
                "collectionId": "materials",
                "categoryId": null,
                "label": "全部资料",
                "path": "主导航 → 资料库",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "ask",
                "href": "#/ask",
                "collectionId": null,
                "categoryId": null,
                "label": "问一问",
                "path": "主导航 → 问一问",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "activity",
                "href": "#/activity",
                "collectionId": null,
                "categoryId": null,
                "label": "活动",
                "path": "主导航 → 活动",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "devices",
                "href": "#/connections/devices",
                "collectionId": null,
                "categoryId": null,
                "label": "采集与设备",
                "path": "主导航 → 采集与设备",
                "where": "进入后按页面中的名称操作。"
              },
              {
                "pageId": "about",
                "href": "#/preferences",
                "collectionId": null,
                "categoryId": null,
                "label": "设置",
                "path": "设置",
                "where": "进入后按页面中的名称操作。"
              }
            ],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "资料库分类是已有内容的视图；页面工具与分类视图使用不同入口。"
            ],
            "condition": null
          }
        ]
      },
      {
        "id": "G16",
        "title": "帮助、诊断与 Agent 视角",
        "purpose": "核对版本、日志和实际配置，查看 Agent 能读的内容与保留的读取记录。",
        "setting": "当前可读预览不同于历史实际输入；详细过程需事先开启且仍在保留范围。",
        "links": [
          {
            "pageId": "help",
            "href": "#/help",
            "collectionId": null,
            "categoryId": null,
            "label": "帮助与反馈",
            "path": "设置 → 帮助与反馈",
            "where": "查看反馈链接；版本也在设置的「版本与更新」或「诊断与更新」。"
          },
          {
            "pageId": "agentView",
            "href": "#/agent",
            "collectionId": null,
            "categoryId": null,
            "label": "Agent 能看到什么",
            "path": "今天 → 更多上下文视图 → Agent 视角；设置 → Agent 能看到什么",
            "where": "打开 Agent 视角，在目录、范围和首次上下文预览中核对。"
          }
        ],
        "units": [
          {
            "id": "C42",
            "priority": "core",
            "title": "找到帮助、版本和维护方式",
            "purpose": "查找问题反馈入口，核对网页与中央版本，以及中央节点的手动升级说明。",
            "actions": [
              "找到 GitHub 反馈入口",
              "找到诊断支持导出",
              "查看 Web 与中央版本差异",
              "找到 DEV 发布下载",
              "查看中央手动升级说明"
            ],
            "target": {
              "pageId": "help",
              "href": "#/help",
              "collectionId": null,
              "categoryId": null,
              "label": "帮助与反馈",
              "path": "设置 → 帮助与反馈",
              "where": "查看反馈链接；版本也在设置的「版本与更新」或「诊断与更新」。"
            },
            "otherTargets": [
              {
                "pageId": "about",
                "href": "#/preferences",
                "collectionId": null,
                "categoryId": null,
                "label": "设置",
                "path": "设置 → 版本与更新",
                "where": "展开「版本与更新」。"
              },
              {
                "pageId": "developer",
                "href": "#/system/diagnostics",
                "collectionId": null,
                "categoryId": null,
                "label": "诊断与更新",
                "path": "设置 → 诊断与更新",
                "where": "进入后按页面中的名称操作。"
              }
            ],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "中央没有应用内自动更新或重启按钮。",
              "Mac / Android 的客户端诊断包需在对应原生 App 导出。"
            ],
            "condition": null
          },
          {
            "id": "A26",
            "priority": "advanced",
            "title": "查看 Agent 当前能读取的上下文",
            "purpose": "只读浏览 Agent 的虚拟目录，并为一个问题预览首次上下文，不必调用模型。",
            "actions": [
              "浏览记忆、事件、来源和正式资料目录",
              "设置检查用设备和时间范围",
              "展开文字与证据",
              "预览一个问题的首次上下文"
            ],
            "target": {
              "pageId": "agentView",
              "href": "#/agent",
              "collectionId": null,
              "categoryId": null,
              "label": "Agent 能看到什么",
              "path": "今天 → 更多上下文视图 → Agent 视角；设置 → Agent 能看到什么",
              "where": "打开 Agent 视角，在目录、范围和首次上下文预览中核对。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "这是所有者对问答范围的只读预览，不是任意角色模拟。",
              "能访问、首次提供和实际读取是不同层次。",
              "不展示原始 Coding 包或宿主机文件系统。"
            ],
            "condition": null
          },
          {
            "id": "A27",
            "priority": "advanced",
            "title": "查看已记录的实际模型输入和工具读取",
            "purpose": "按运行查阅当时保存的上下文、模型和工具事件，核对真实记录。",
            "actions": [
              "选择运行或运行 ID",
              "查看上下文、模型和工具事件内容",
              "阅读记录文字",
              "翻页查看事件"
            ],
            "target": {
              "pageId": "agentView",
              "href": "#/agent",
              "collectionId": null,
              "categoryId": null,
              "label": "Agent 能看到什么",
              "path": "Agent 视角 → 实际输入与读取过程",
              "where": "切换实际输入与读取过程，选择已有运行；详细记录开关在诊断偏好。"
            },
            "otherTargets": [],
            "setup": "需要此前已开启并仍保留的详细 Agent 过程；可在诊断偏好控制今后的记录。",
            "setupTargets": [
              {
                "pageId": "developer",
                "href": "#/system/diagnostics",
                "collectionId": null,
                "categoryId": null,
                "label": "诊断与更新",
                "path": "设置 → 诊断与更新 → 诊断偏好",
                "where": "查看「记录详细 Agent 过程」。"
              }
            ],
            "caveats": [
              "旧的、未记录或被截断的输入不能用当前记忆重建。",
              "开启详细过程会保留可能包含个人内容的提示、上下文、输出和工具记录。"
            ],
            "condition": "只有已保留的详细运行记录可查；没有记录时只能理解设置与边界。"
          },
          {
            "id": "A28",
            "priority": "advanced",
            "title": "核对实际注册的插件能力",
            "purpose": "查看服务端与网页实际加载的能力、版本、状态和当前模块绑定。",
            "actions": [
              "展开功能项",
              "对照服务端和 Web 入口、版本与状态",
              "查看当前模块与绑定"
            ],
            "target": {
              "pageId": "extensions",
              "href": "#/system/plugins",
              "collectionId": null,
              "categoryId": null,
              "label": "自动记忆与插件",
              "path": "设置 → 自动记忆与插件 → 高级 → 已注册能力清单",
              "where": "在插件页高级区域展开已注册能力清单。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "已注册不能证明资料处理成功或组件健康。",
              "网页展示组件的移除不会改变后台处理或 Agent 授权。"
            ],
            "condition": null
          },
          {
            "id": "A34",
            "priority": "advanced",
            "title": "查阅运行日志并导出支持包",
            "purpose": "按文件、阶段和时间范围查看保留的日志，导出诊断资料用于排查。",
            "actions": [
              "选择日志文件、阶段、页码和大小",
              "选择、复制或换行查看日志",
              "自动刷新",
              "导出保留时间范围的诊断包"
            ],
            "target": {
              "pageId": "developer",
              "href": "#/system/diagnostics",
              "collectionId": null,
              "categoryId": null,
              "label": "诊断与更新",
              "path": "设置 → 诊断与更新 → 运行诊断",
              "where": "使用日志筛选和导出入口；以实际保留范围为准。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "固定诊断包排除正文和凭据；原始详细过程仍可能含私密内容。",
              "保留与轮转缺口会明确显示；客户端诊断报告在原生 App 获取。"
            ],
            "condition": null
          },
          {
            "id": "A35",
            "priority": "advanced",
            "title": "设置诊断记录并查看部署生效值",
            "purpose": "调整今后的日志和详细过程记录，核对中央节点实际使用的目录和配置。",
            "actions": [
              "开启或关闭日志、级别、调试和详细 Agent 过程",
              "保存",
              "查看环境文件、数据和基准目录",
              "查看全部实际生效配置"
            ],
            "target": {
              "pageId": "developer",
              "href": "#/system/diagnostics",
              "collectionId": null,
              "categoryId": null,
              "label": "诊断与更新",
              "path": "设置 → 诊断与更新 → 诊断偏好 / 部署与全部生效配置",
              "where": "查看「诊断偏好」，展开「部署与全部生效配置」。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "诊断偏好保存后立即生效，完整部署值主要只读。",
              "关闭详细过程会停止新增记录；页面没有中央重启按钮。"
            ],
            "condition": null
          },
          {
            "id": "A36",
            "priority": "advanced",
            "title": "切换界面语言",
            "purpose": "按当前使用习惯选择中文或 English 界面。",
            "actions": [
              "选择中文或 English"
            ],
            "target": {
              "pageId": "about",
              "href": "#/preferences",
              "collectionId": null,
              "categoryId": null,
              "label": "设置",
              "path": "设置 → 语言",
              "where": "设置入口顶部的语言选择器。"
            },
            "otherTargets": [],
            "setup": null,
            "setupTargets": [],
            "caveats": [
              "这是界面偏好，不会改变归档内容。"
            ],
            "condition": null
          }
        ]
      }
    ]
  }
];
export const quickLinks:GuideTarget[] = [
  {
    "pageId": "notes",
    "href": "#/library/notes",
    "collectionId": null,
    "categoryId": null,
    "label": "写随手记",
    "path": "资料库工具 → 随手记",
    "where": "笔记编辑器下方查看草稿、待同步队列和历史。"
  },
  {
    "pageId": "imports",
    "href": "#/library/import",
    "collectionId": null,
    "categoryId": null,
    "label": "导入资料",
    "path": "资料库 → 导入资料；资料库工具 → 导入",
    "where": "选择文件、文件夹或拖入；填写资料说明后加入队列。"
  },
  {
    "pageId": "sourceCatalog",
    "href": "#/connections/add",
    "collectionId": null,
    "categoryId": null,
    "label": "新增数据源",
    "path": "采集与设备 → 新增数据源",
    "where": "先选择录音、设备、导入文件或在线资料卡片；管理已有来源使用「管理已接入来源」。"
  },
  {
    "pageId": "recordings",
    "href": "#/connections/recordings",
    "collectionId": null,
    "categoryId": null,
    "label": "归档录音",
    "path": "新增数据源 → 录音与转写 → 录音厂商",
    "where": "先选择飞书录音 / 妙记或钉钉录音 / 闪记卡片，再查看该厂商的首次授权、历史范围和同步设置。"
  },
  {
    "pageId": "ask",
    "href": "#/ask",
    "collectionId": null,
    "categoryId": null,
    "label": "问一问",
    "path": "问一问",
    "where": "在对话输入区提问；答案中的引用可打开证据。"
  },
  {
    "pageId": "extensions",
    "href": "#/system/plugins?tab=memory",
    "collectionId": null,
    "categoryId": null,
    "label": "暂停自动记忆",
    "path": "设置 → 自动记忆与插件 → 记忆方案 → 自动记忆",
    "where": "在当前记忆方案中查看「自动记忆」的状态和控制。"
  }
];
