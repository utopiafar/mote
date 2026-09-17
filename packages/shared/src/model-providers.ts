import { moteText } from './i18n.js';
export const MODEL_PROTOCOLS = ['deepseek', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'codex-app-server'] as const;
export type ModelProtocol = typeof MODEL_PROTOCOLS[number];
export const MODEL_REASONING_EFFORTS = ['auto', 'off', 'low', 'high', 'max'] as const;
export type ModelReasoningEffort = typeof MODEL_REASONING_EFFORTS[number];
export const DEFAULT_MODEL_MAX_TOKENS = 65_536;
export const MODEL_OUTPUT_BUDGETS = [8192, 16384, 32768, DEFAULT_MODEL_MAX_TOKENS, 128000] as const;
export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_AGENT_TIMEOUT_MS = 600_000;
export const MAX_MODEL_REQUEST_TIMEOUT_MS = 600_000;
export const MAX_AGENT_TIMEOUT_MS = 3_600_000;

export interface ModelProviderPreset {
  id: string;
  name: string;
  group: 'china' | 'international' | 'local' | 'custom';
  protocol: ModelProtocol;
  baseUrl: string;
  description: string;
  docsUrl: string;
  reasoningEffort?: ModelReasoningEffort;
  allowUnauthenticatedLocal?: boolean;
}

export interface ModelSettingsParameters {
  provider: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  maxTokens: number;
  /** One provider/model request. Null means not applicable to Codex App Server. */
  modelRequestTimeoutMs: number | null;
  /** Complete Agent run, including all model/tool turns. Null disables Mote's total deadline. */
  agentTimeoutMs: number | null;
  allowUnauthenticatedLocal: boolean;
}
export interface ModelSettings extends ModelSettingsParameters {
  apiKey: string;
  headers: Record<string, string>;
  extraBody: Record<string, unknown>;
}
export interface ModelSettingsPublic extends ModelSettingsParameters {
  apiKeyConfigured: boolean;
  headersConfigured: boolean;
  extraBodyConfigured: boolean;
}
export interface ModelSettingsView {
  version: 1;
  revision: number;
  source: 'environment' | 'saved';
  settings: ModelSettingsPublic;
  /** Absent on older nodes. The default profile preserves the original API. */
  profiles?: ModelProfilePublic[];
  defaults?: ModelFeatureDefaults;
  /** An omitted entry follows the selected preset's default model. */
  defaultModels?: ModelFeatureModels;
}
export const MODEL_FEATURES = ['chat', 'memory', 'insight', 'import', 'file'] as const;
export type ModelFeature = typeof MODEL_FEATURES[number];
export type ModelFeatureDefaults = Record<ModelFeature, string>;
export type ModelFeatureModels = Partial<Record<ModelFeature, string>>;
export const DEFAULT_MODEL_PROFILE_ID = 'default';
export const DEPLOYMENT_MODEL_PROFILE_ID = 'env:deployment';
export const MODEL_FEATURE_LABELS: Record<ModelFeature, string> = {get chat() { return moteText("Chat 问答"); }, get memory() { return moteText("Memory 记忆提取"); }, get insight() { return moteText("个人回顾"); }, get import() { return moteText("资料导入"); }, get file() { return moteText("文件分析"); }};
export interface ModelProfile {id: string; name: string; settings: ModelSettings}
export interface ModelProfilePublic {id: string; name: string; settings: ModelSettingsPublic; readOnly?: boolean; source?: 'environment' | 'saved'}
export interface ModelSelection {profileId: string; profileName: string; provider: string; model: string}
export interface ModelSettingsInput extends ModelSettingsParameters {
  /** Omitted secrets retain their saved value; null explicitly clears them. */
  apiKey?: string | null;
  headers?: Record<string, string> | null;
  extraBody?: Record<string, unknown> | null;
}
export interface ModelSettingsUpdate {
  revision: number;
  settings: ModelSettingsInput;
  allowCredentialReuse?: boolean;
}
export interface ModelTestResult {
  ok: boolean;
  code: 'ok' | 'not_configured' | 'timeout' | 'provider_error' | 'invalid_response';
  message: string;
  durationMs: number;
}

/** Provider defaults; discover account-specific model IDs from its catalog and retain manual overrides. */
export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = [
  {id:'codex',get name() { return moteText("本机 Codex"); },group:'local',protocol:'codex-app-server',baseUrl:'',get description() { return moteText("通过中央服务器上的 Codex App Server 调用已登录账户。推理仍由 Codex 服务完成；需安装 Codex CLI 并在服务器登录。"); },docsUrl:'https://developers.openai.com/codex/app-server',reasoningEffort:'auto'},
  { id: 'custom', get name() { return moteText("自定义接口"); }, group: 'custom', protocol: 'openai-completions', baseUrl: '', get description() { return moteText("选择接口协议，填写服务基址和支持工具调用的模型 ID。高级配置可设置请求头和厂商参数。"); }, docsUrl: '', reasoningEffort: 'auto' },
  { id: 'deepseek', name: 'DeepSeek', group: 'china', protocol: 'deepseek', baseUrl: 'https://api.deepseek.com', get description() { return moteText("DeepSeek 官方接口，保留其推理与多轮工具调用格式。模型 ID 以控制台为准。"); }, docsUrl: 'https://api-docs.deepseek.com/', reasoningEffort: 'high' },
  { id: 'qwen', get name() { return moteText("阿里云 / 通义千问"); }, group: 'china', protocol: 'openai-completions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', get description() { return moteText("使用百炼 API key；工作空间与地域地址可按控制台修改，密钥必须与地域对应。"); }, docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope', reasoningEffort: 'auto' },
  { id: 'ark', get name() { return moteText("火山方舟 / 豆包"); }, group: 'china', protocol: 'openai-completions', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', get description() { return moteText("使用方舟 API key；模型栏填写控制台的模型 ID 或推理接入点 ID。"); }, docsUrl: 'https://www.volcengine.com/docs/82379/1795150', reasoningEffort: 'auto' },
  { id: 'glm', get name() { return moteText("智谱 / GLM"); }, group: 'china', protocol: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', get description() { return moteText("使用开放平台 API key；选择支持工具调用的模型，思考参数按该模型文档配置。"); }, docsUrl: 'https://docs.bigmodel.cn/cn/guide/capabilities/function-calling', reasoningEffort: 'auto' },
  { id: 'kimi', get name() { return moteText("月之暗面 / Kimi"); }, group: 'china', protocol: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1', get description() { return moteText("使用 Kimi 开放平台 API key；不同代际模型的思考参数不同，默认交给模型处理。"); }, docsUrl: 'https://platform.kimi.com/docs/api/chat', reasoningEffort: 'auto' },
  { id: 'minimax', name: 'MiniMax', group: 'china', protocol: 'openai-completions', baseUrl: 'https://api.minimax.cn/v1', get description() { return moteText("使用 MiniMax API key。也可切换 Messages 协议并将地址改为 https://api.minimax.cn/anthropic。"); }, docsUrl: 'https://platform.minimax.cn/docs/api-reference/text-chat-openai', reasoningEffort: 'auto' },
  { id: 'qianfan', get name() { return moteText("百度智能云 / 千帆"); }, group: 'china', protocol: 'openai-completions', baseUrl: 'https://qianfan.baidubce.com/v2', get description() { return moteText("使用新版 API Key（Bearer）；不要填写旧版 OAuth access_token。模型须支持工具调用。"); }, docsUrl: 'https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb', reasoningEffort: 'auto' },
  { id: 'tencent-tokenhub', get name() { return moteText("腾讯云 / TokenHub"); }, group: 'china', protocol: 'openai-completions', baseUrl: 'https://tokenhub.tencentmaas.com/v1', get description() { return moteText("腾讯新版模型服务，使用 TokenHub 新密钥；从旧混元平台迁移时需要同时更换地址和密钥。"); }, docsUrl: 'https://cloud.tencent.com/document/product/1823/130058', reasoningEffort: 'auto' },
  { id: 'hunyuan', get name() { return moteText("腾讯混元（原平台）"); }, group: 'china', protocol: 'openai-completions', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', get description() { return moteText("供已有混元账户使用；新接入建议选择 TokenHub，两个平台的密钥不能直接复用。"); }, docsUrl: 'https://cloud.tencent.com/document/product/1729/111007', reasoningEffort: 'auto' },
  { id: 'siliconflow', get name() { return moteText("硅基流动 / SiliconFlow"); }, group: 'china', protocol: 'openai-completions', baseUrl: 'https://api.siliconflow.cn/v1', get description() { return moteText("填写完整模型 ID；工具调用与思考能力取决于所选模型。"); }, docsUrl: 'https://docs.siliconflow.cn/docs/api/chat-completions-post', reasoningEffort: 'auto' },
  { id: 'spark', get name() { return moteText("讯飞 / 星火"); }, group: 'china', protocol: 'openai-completions', baseUrl: 'https://spark-api-open.xf-yun.com/x2', get description() { return moteText("使用 HTTP 服务的 APIPassword。预设为 X2 地址，其他版本请按控制台修改地址和模型 ID。"); }, docsUrl: 'https://www.xfyun.cn/doc/spark/X1http.html', reasoningEffort: 'auto' },
  { id: 'stepfun', get name() { return moteText("阶跃星辰 / StepFun"); }, group: 'china', protocol: 'openai-completions', baseUrl: 'https://api.stepfun.com/v1', get description() { return moteText("使用开放平台 API key；Step Plan 套餐需改为 https://api.stepfun.com/step_plan/v1 并选择套餐可用模型。"); }, docsUrl: 'https://platform.stepfun.com/docs/zh/api-reference/chat/chat-completion-create', reasoningEffort: 'auto' },
  { id: 'openai', name: 'OpenAI', group: 'international', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', get description() { return moteText("默认使用 Responses；也可切换 Chat Completions。填写账户可用的模型 ID。"); }, docsUrl: 'https://developers.openai.com/api/docs/guides/text', reasoningEffort: 'auto' },
  { id: 'anthropic', name: 'Anthropic / Claude', group: 'international', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', get description() { return moteText("使用原生 Messages 与工具调用，凭据为 Claude API key。"); }, docsUrl: 'https://platform.claude.com/docs/en/api/overview', reasoningEffort: 'auto' },
  { id: 'gemini', name: 'Google / Gemini', group: 'international', protocol: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', get description() { return moteText("Google 原生接口；使用 Gemini API key，保留工具调用中的思考签名。选择支持工具调用的模型。"); }, docsUrl: 'https://ai.google.dev/gemini-api/docs/function-calling', reasoningEffort: 'auto' },
  { id: 'azure-openai', name: 'Azure OpenAI / Foundry', group: 'international', protocol: 'openai-completions', baseUrl: '', get description() { return moteText("填写 Azure 资源的 https://资源名.openai.azure.com/openai/v1 地址；模型栏填写部署名称，密钥通过 api-key 请求头发送。"); }, docsUrl: 'https://learn.microsoft.com/en-us/azure/foundry/openai/latest', reasoningEffort: 'auto' },
  { id: 'xai', name: 'xAI / Grok', group: 'international', protocol: 'openai-responses', baseUrl: 'https://api.x.ai/v1', get description() { return moteText("使用 Responses 接口和 xAI API key；也可切换兼容 Chat Completions。"); }, docsUrl: 'https://docs.x.ai/developers/rest-api-reference/inference/responses', reasoningEffort: 'auto' },
  { id: 'mistral', name: 'Mistral', group: 'international', protocol: 'openai-completions', baseUrl: 'https://api.mistral.ai/v1', get description() { return moteText("使用 Chat Completions；选择支持函数调用的模型。"); }, docsUrl: 'https://docs.mistral.ai/api/endpoint/chat', reasoningEffort: 'auto' },
  { id: 'groq', name: 'Groq', group: 'international', protocol: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1', get description() { return moteText("Groq 官方兼容接口；模型的参数和工具能力以控制台说明为准。"); }, docsUrl: 'https://console.groq.com/docs/openai', reasoningEffort: 'auto' },
  { id: 'openrouter', name: 'OpenRouter', group: 'international', protocol: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', get description() { return moteText("填写完整模型 ID；请选择支持 tools 的模型与路由。"); }, docsUrl: 'https://openrouter.ai/docs/quickstart', reasoningEffort: 'auto' },
  { id: 'ollama', name: 'Ollama', group: 'local', protocol: 'openai-completions', baseUrl: 'http://localhost:11434/v1', get description() { return moteText("地址属于中央节点所在机器。需先启动 Ollama 并安装支持工具调用的模型。"); }, docsUrl: 'https://docs.ollama.com/api/openai-compatibility', reasoningEffort: 'auto', allowUnauthenticatedLocal: true },
  { id: 'lm-studio', name: 'LM Studio', group: 'local', protocol: 'openai-completions', baseUrl: 'http://localhost:1234/v1', get description() { return moteText("先在中央节点所在机器启动 LM Studio 服务，模型须支持工具调用。"); }, docsUrl: 'https://lmstudio.ai/docs/developer/openai-compat/tools', reasoningEffort: 'auto', allowUnauthenticatedLocal: true },
];

export function modelProvider(id: string): ModelProviderPreset | undefined {
  return MODEL_PROVIDER_PRESETS.find(provider => provider.id === id);
}
