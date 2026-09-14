import { join, resolve } from 'node:path';
import type { ConfigurationField, ConfigurationValue, ServerConfiguration } from '@mote/shared';
import { repositoryRoot, type Config } from './config.js';

/** Strip credential-bearing URL components even for programmatic Config callers that bypass env validation. */
export function configurationUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}

/** Explicit owner-only projection. Never spread Config or read mutable env files while serving requests. */
export function serverConfiguration(config: Config): ServerConfiguration {
  const context = config.configuration;
  const runtime = context?.runtime ?? 'unknown';
  const dataDir = resolve(config.dataDir), logDir = resolve(config.logDirectory ?? join(dataDir, 'logs'));
  const baseDir = context?.baseDir ?? repositoryRoot;
  const field = (key: string, label: string, value: ConfigurationValue, description: string, envVar?: string, extra: Partial<Pick<ConfigurationField, 'unit' | 'visibility' | 'restartRequired' | 'source'>> = {}): ConfigurationField => ({
    key, label, value, description, ...(envVar ? { envVar } : {}),
    source: envVar && context ? context.sources[envVar] ?? 'default' : 'derived', restartRequired: Boolean(envVar), ...extra,
  });
  const ownerPath = { visibility: 'owner-path' as const };
  const secret = { visibility: 'secret-status' as const };
  const nativeStorage = runtime === 'native' ? dataDir : null;
  const storage: ServerConfiguration['storage'] = {
    dataDir, sqlitePath: join(dataDir, 'mote.sqlite'), blobsDir: join(dataDir, 'blobs'), logDir,
    kind: context?.storageKind ?? 'unknown', source: context?.storageSource ?? nativeStorage,
    mountPath: context?.storageMount ?? null,
    description: runtime === 'docker'
      ? '路径属于中央容器；存储来源与挂载点由部署工具提供。命名卷是 Docker 卷标识，不是宿主机目录；未提供的宿主位置不会被猜测。'
      : 'SQLite、图片与日志路径属于运行中央进程的机器。存储来源是部署声明，未扫描磁盘或推断 NAS 挂载。',
  };
  const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  const hasAgentKey = Boolean(config.apiKey.trim()), hasEmbeddingKey = Boolean(config.embeddingApiKey.trim());
  const localWithoutKey = Boolean(config.allowUnauthenticatedLocal && (() => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.modelBaseUrl).hostname); } catch { return false; } })());
  return {
    version: 1, profile: config.profile ?? 'legacy', runtime, envFile: context?.hostConfigFile ?? context?.envFile ?? null, baseDir,
    readOnly: true, restartRequired: true,
    description: '此页展示中央进程启动时读取的生效配置，只向已认证的节点所有者提供。修改所选配置文件或部署设置后重启中央节点；本接口不能写入文件。路径不会加入安全支持包。',
    storage,
    groups: [
      { id: 'updates', title: '软件更新', description: '从固定发布身份验证新版本。检查只读取公开发布元数据；安装由部署机上的更新命令执行，保留配置、数据和连接授权。', fields: [
        field('updateRepository', 'GitHub 发布仓库', config.updateRepository ?? 'utopiafar/mote', '仓库格式为 owner/repository；发布清单仍必须通过随程序内置的发布公钥验证。', 'MOTE_UPDATE_REPOSITORY'),
        field('updateChannel', '发布渠道', config.updateChannel ?? 'stable', 'stable 使用正式版本，preview 使用预览版本。不会自动降级或重启服务。', 'MOTE_UPDATE_CHANNEL'),
      ] },
      { id: 'deployment', title: '部署与配置来源', description: '环境文件修改后不会立即影响运行中的进程。容器中的加载文件与宿主机可编辑配置可能不同。', fields: [
        field('profile', '环境', config.profile ?? 'legacy', 'dev、test、prod 或显式命名的独立环境。', 'MOTE_PROFILE'),
        field('runtime', '运行方式', runtime, '部署工具声明的运行方式；缺少元数据时显示 unknown，不探测宿主环境。', 'MOTE_RUNTIME'),
        field('configurationFile', '部署配置文件', context?.hostConfigFile ?? context?.envFile ?? null, '部署工具提供的宿主配置路径；请在部署机器修改。未提供时显示实际加载文件。', 'MOTE_CONFIG_FILE', { ...ownerPath, source: context?.hostConfigFile ? context.sources.MOTE_CONFIG_FILE ?? 'environment' : 'derived' }),
        field('effectiveEnvFile', '进程加载文件', context?.envFile ?? null, '显式 MOTE_ENV_FILE 只读取该文件；Docker 可使用空文件哨兵，生效值由容器环境注入。', 'MOTE_ENV_FILE', ownerPath),
        field('baseDirectory', '相对路径基准', baseDir, 'MOTE_DATA_DIR 与 MOTE_LOG_DIR 的相对路径以此目录解析。', undefined, ownerPath),
      ] },
      { id: 'storage', title: '数据与空间', description: storage.description, fields: [
        field('dataDirectory', '数据目录', dataDir, '中央资料库所在路径。迁移需先停止服务、备份并恢复到空目录，不要在线改动。', 'MOTE_DATA_DIR', ownerPath),
        field('sqlitePath', 'SQLite 数据库', storage.sqlitePath, '保存原文、元数据、全文索引和可选向量；运行时还有 WAL/SHM 文件。', undefined, ownerPath),
        field('blobsDirectory', '图片对象目录', storage.blobsDir, '按内容哈希存储图片，多次观察事件可共享一个对象。', undefined, ownerPath),
        field('storageKind', '存储类型', storage.kind, '部署声明的本地目录、Docker 命名卷或 bind mount；不是磁盘自动检测结果。', 'MOTE_STORAGE_KIND'),
        field('storageSource', '宿主存储来源', storage.source, 'Docker 卷名或宿主挂载源。未声明则无法从容器内部可靠获知。', 'MOTE_STORAGE_SOURCE', { ...ownerPath, source: context?.storageSource ? context.sources.MOTE_STORAGE_SOURCE ?? 'environment' : 'derived' }),
        field('storageMount', '容器挂载点', storage.mountPath, '例如 /data；原生部署无需容器挂载。', 'MOTE_STORAGE_MOUNT', ownerPath),
        field('maxStorageBytes', '资料容量上限', config.maxStorageBytes, '限制去重图片与记录 JSON 的逻辑字节；SQLite 索引、WAL、日志等额外占盘，不是全磁盘硬配额。达到上限返回 507，端点保留待传队列。', 'MOTE_MAX_STORAGE_MB', { unit: 'bytes' }),
        field('retentionDays', '历史保留天数', config.retentionDays, '0 表示不自动按时间删除；正数按采集时间清理过期记录和无引用图片，并使关联洞察失效。', 'MOTE_RETENTION_DAYS', { unit: 'days' }),
        field('maxExportBytes', 'HTTP 归档大小上限', config.maxExportBytes, '应用于 HTTP 导出/导入；最多 20,000 条记录，较大仓库使用离线备份。导出含可读原文与图片。', 'MOTE_MAX_EXPORT_MB', { unit: 'bytes' }),
        field('dataKeyConfigured', '图片加密密钥已配置', Boolean(config.dataKey), '只显示是否设置。AES-256-GCM 仅加密图片对象；SQLite 原文仍需磁盘加密。已有仓库不能直接更换密钥。', 'MOTE_DATA_KEY', secret),
      ] },
      { id: 'model', title: '问答与洞察模型', description: '模型选择只读检索工具并解释证据；这里不展示 API key，也不执行模型探测或发送资料。', fields: [
        field('agentConfigured', 'Agent 已具备配置', Boolean(config.model.trim() && (hasAgentKey || localWithoutKey)), '仅判断模型名称和认证配置是否齐全，不代表提供商可达或当前请求成功。'),
        field('model', '模型名称', config.model || null, '使用模型服务支持的准确标识，留空禁用 Agent。', 'MOTE_MODEL'),
        field('modelBaseUrl', '模型服务地址', configurationUrl(config.modelBaseUrl), 'OpenAI/DeepSeek 兼容 base URL；显示时移除 URL 凭据、查询与片段，认证应使用独立 API key。', 'MOTE_MODEL_BASE_URL'),
        field('modelApiKeyConfigured', '模型 API key 已配置', hasAgentKey, '凭据只用于中央到模型服务的请求，不返回给浏览器。', 'MOTE_MODEL_API_KEY', secret),
        field('modelReasoningEffort', '模型推理强度', config.modelReasoningEffort ?? 'high', '当前支持 off、low、high、max；具体行为取决于所选提供商和模型。', 'MOTE_MODEL_REASONING_EFFORT'),
        field('modelMaxTokens', '单轮模型输出上限', config.modelMaxTokens ?? 8192, '模型生成输出的 token 上限，不是资料库容量或检索条数。', 'MOTE_MODEL_MAX_TOKENS', { unit: 'tokens' }),
        field('modelTimeoutMs', 'Agent 运行期限', config.modelTimeoutMs ?? 120000, '查询、洞察与记忆提取共用，5000–600000 毫秒整数。超时返回 504；入口代理可能有更短的等待限制。普通上传期限保持不变。', 'MOTE_MODEL_TIMEOUT_MS', { unit: 'ms' }),
        field('allowUnauthenticatedLocal', '允许本机免密模型', config.allowUnauthenticatedLocal, '只对 localhost、127.0.0.1 或 ::1 的模型地址生效；容器 loopback 指容器本身。', 'MOTE_MODEL_ALLOW_UNAUTHENTICATED_LOCAL'),
        field('insightIntervalHours', '后台洞察间隔', config.insightIntervalHours, '0 关闭定时洞察；正数按小时请求已配置的 Agent，模型服务可能产生费用。', 'MOTE_INSIGHT_INTERVAL_HOURS', { unit: 'hours' }),
      ] },
      { id: 'embedding', title: '向量索引', description: '未配置 embedding 时保留本地文本索引。配置后中央将文本提交给所选 embedding 服务。', fields: [
        field('embeddingConfigured', '向量索引已配置', Boolean(config.embeddingModel && config.embeddingBaseUrl), '表示配置齐全，不代表已有资料全部完成索引或提供商可达。'),
        field('embeddingModel', 'Embedding 模型', config.embeddingModel || null, '留空使用文本索引；更改模型后已有向量可能需要重新索引。', 'MOTE_EMBEDDING_MODEL'),
        field('embeddingBaseUrl', 'Embedding 服务地址', configurationUrl(config.embeddingBaseUrl), '兼容 /embeddings 的 base URL；凭据与查询参数不会显示。', 'MOTE_EMBEDDING_BASE_URL'),
        field('embeddingApiKeyConfigured', 'Embedding key 已配置', hasEmbeddingKey, '只显示配置状态。', 'MOTE_EMBEDDING_API_KEY', secret),
      ] },
      {id:'connectors',title:'来源与 MCP',description:'授权凭据与中央访问令牌分离；未配置时不连接外部账户。',fields:[
        field('connectorDirectory','第三方凭据目录',config.connectors?.directory??join(dataDir,'connectors'),'连接器令牌私有保存，不进入资料导出。',undefined,ownerPath),
        field('mcpEnabled','MCP 已启用',config.connectors?.mcpEnabled??false,'外部 Chatbot 使用 /mcp 查询资料；需要单独的读令牌。','MOTE_MCP_ENABLED'),
        field('mcpReadTokenConfigured','MCP 读令牌已配置',Boolean(config.connectors?.mcpReadToken),'最少 32 字符，仅显示配置状态。','MOTE_MCP_READ_TOKEN',secret),
        field('mcpWriteEnabled','允许 MCP 写回',config.connectors?.mcpWriteEnabled??false,'为外部 Agent 保存可见记录提供独立写入能力，默认关闭。','MOTE_MCP_WRITE_ENABLED'),
        field('mcpWriteTokenConfigured','MCP 写令牌已配置',Boolean(config.connectors?.mcpWriteToken),'与读令牌及所有者令牌不同，仅显示状态。','MOTE_MCP_WRITE_TOKEN',secret),
        field('mcpWriteSourceIds','MCP 可写来源',config.connectors?.mcpWriteSourceIds??[],'只允许写入列出的已注册来源。','MOTE_MCP_WRITE_SOURCE_IDS'),
        field('mcpAllowLocal','允许本机 MCP 来源',config.connectors?.allowLocalMcp??false,'仅用于显式连接本机开发服务，生产保持关闭。','MOTE_MCP_ALLOW_LOCAL'),
        field('googleClientConfigured','Google OAuth 客户端已配置',Boolean(config.connectors?.googleClientId&&config.connectors?.googleClientSecret),'还需要在来源页完成账户授权并选择日历。','MOTE_GOOGLE_CLIENT_ID',secret),
        field('googleSecretConfigured','Google OAuth 密钥已配置',Boolean(config.connectors?.googleClientSecret),'凭据不返回浏览器。','MOTE_GOOGLE_CLIENT_SECRET',secret),
        field('googleRedirectUri','Google 授权回调',configurationUrl(config.connectors?.googleRedirectUri),'必须与 Google Cloud 登记完全一致；可使用 Cloudflare Tunnel 的 HTTPS 地址。','MOTE_GOOGLE_REDIRECT_URI'),
        field('connectorSyncInterval','来源同步间隔',(config.connectors?.syncIntervalMs??900000)/1000,'自动拉取已授权的来源，范围 60–86400 秒。','MOTE_CONNECTOR_SYNC_INTERVAL_SECONDS',{unit:'seconds'}),
      ]},
      { id: 'diagnostics', title: '诊断与日志', description: '安全支持包保持路径和正文隔离；此配置视图不作为诊断附件导出。', fields: [
        field('diagnosticsEnabled', '结构化诊断开关', config.diagnosticsEnabled ?? true, '记录固定事件、状态与数值指标，不记录截图、原文、模型 prompt 或任意异常文本。silent 日志级别会同时停止记录。', 'MOTE_DIAGNOSTICS_ENABLED'),
        field('diagnosticsDebug', '调试模式', config.diagnosticsDebug ?? false, '增加允许的固定调试事件，不开放任意正文日志。', 'MOTE_DEBUG'),
        field('logLevel', '配置的日志级别', config.logLevel ?? 'info', '支持 debug、info、warn、error、silent。调试模式会将非 silent 级别提升为 debug。', 'MOTE_LOG_LEVEL'),
        field('effectiveLogLevel', '实际诊断日志级别', config.logLevel === 'silent' ? 'silent' : config.diagnosticsDebug ? 'debug' : config.logLevel ?? 'info', 'silent 优先；其余情况下 MOTE_DEBUG=1 使用 debug。诊断总开关关闭时，任何级别均不记录事件。'),
        field('logDirectory', '日志目录', logDir, '结构化中央日志的实际路径；Docker 通常位于 /data/logs。', 'MOTE_LOG_DIR', ownerPath),
        field('logMaxBytes', '每份结构化日志上限', config.logMaxBytes ?? 2 * 1024 * 1024, '独立于资料容量上限。', 'MOTE_LOG_MAX_MB', { unit: 'bytes' }),
        field('logMaxFiles', '日志文件数上限', config.logMaxFiles ?? 3, '有限轮转的总文件数量；Docker/进程管理器输出另有部署级上限。', 'MOTE_LOG_MAX_FILES', { unit: 'files' }),
        field('logMaxEntries', '内存事件条数上限', config.logMaxEntries ?? 2000, '达到上限后保留较新的固定事件。', 'MOTE_LOG_MAX_ENTRIES', { unit: 'entries' }),
      ] },
      { id: 'network', title: '连接与访问', description: '中央是单所有者节点。所有者令牌管理整个资料库；设备页可发放权限受限的独立采集或 MCP 凭据。公开 URL 是部署声明，不证明隧道或 TLS 可用。', fields: [
        field('listenHost', '监听地址', config.host, '127.0.0.1 只接受本机连接，0.0.0.0 接受所有 IPv4 网卡；跨设备长期访问应通过 HTTPS。', 'MOTE_HOST'),
        field('listenPort', '监听端口', config.port, '这是中央进程端口；Docker 的宿主发布端口可能不同。', 'MOTE_PORT'),
        field('listenUrl', '进程 HTTP 地址', `http://${host}:${config.port}`, '绑定地址用于排查进程监听；0.0.0.0 或 :: 不是应填写给远端客户端的公共节点地址。'),
        field('publicUrl', '公开节点地址', configurationUrl(context?.publicUrl), '用户明确设置的 HTTPS 或本机测试地址，不改变中央监听，不自动配置 DNS、TLS 或隧道路由。', 'MOTE_PUBLIC_URL'),
        field('allowedOrigins', '允许的浏览器来源', config.allowedOrigins.map(origin => { const url = configurationUrl(origin); return url ? new URL(url).origin : null; }).filter((origin): origin is string => origin !== null), 'CORS 浏览器 origin 白名单。配置仅控制浏览器跨源请求，不能替代令牌鉴权。', 'MOTE_ALLOWED_ORIGINS'),
        field('accessTokenConfigured', '访问令牌已配置', Boolean(config.token), '只显示状态，不显示令牌、哈希、前后缀或可恢复片段。', 'MOTE_TOKEN', { ...secret, source: config.tokenFromEnvironment ? context?.sources.MOTE_TOKEN ?? 'environment' : 'derived' }),
        field('accessTokenSource', '访问令牌来源', config.tokenFromEnvironment === undefined ? 'programmatic' : config.tokenFromEnvironment ? 'configured-value' : 'private-token-file', 'configured-value 来自进程/所选配置；private-token-file 来自资料库私有 access-token 文件；programmatic 表示由调用方传入。文件内容不返回。'),
        field('clientConnectionsPath', '独立连接凭据位置', join(dataDir, 'connectors', 'client-connections.json'), '保存凭据哈希、权限和撤销状态，不保存明文令牌。随本数据目录使用，最多 500 条／2 MiB；在设备页管理。', undefined, ownerPath),
        field('tunnelConfigured', '隧道已声明启用', context?.tunnelEnabled ?? false, '只有部署配置状态，不代表隧道已经连接或公网路由可达。', 'MOTE_TUNNEL_ENABLED'),
        field('tunnelProvider', '隧道提供方', context?.tunnelProvider ?? null, '由部署工具声明；隧道凭据文件与 token 不进入此接口。', 'MOTE_TUNNEL_PROVIDER'),
        field('tunnelProtocol', '隧道传输设置', context?.tunnelProtocol ?? 'auto', 'auto、http2 或 quic；修改后需要由部署工具重新启动隧道进程。', 'MOTE_TUNNEL_PROTOCOL'),
      ] },
    ],
  };
}
