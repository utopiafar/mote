import { connectionToken, requireConnectionToken } from './login-session';
import { getLocale, moteText } from '@mote/shared/i18n';
import type { Config } from './contracts';
import { validateServerUrl } from './config';
import { readResponseText } from './response-body';
export interface AskRun { id: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; conversationId?: string; events: { stage: string; message?: string; tool?: string }[]; error?: {message: string}; execution?: import('@mote/shared').ExecutionEnvelope }
export interface AskConversation { id: string; title: string; turns: { question: string; status: string; error?: {message: string}; result?: { answer: string; citations: {id: string; appName: string; capturedAt: string; excerpt: string}[] } }[] }
export type AskCommand = 'history' | 'runs' | 'conversation' | 'run' | 'start' | 'cancel' | 'login' | 'logout' | 'login-browser';
/** Fixed endpoints only. Owner credentials remain in the main process and are scoped to one origin. */
export class AskClient {
  constructor(private isCurrent:(config:Config)=>boolean=()=>true) {}
  private check(config:Config){if(!this.isCurrent(config)||!connectionToken(config))throw Error(moteText('登录会话已变更，请重新打开中央页面。'));}
  async request(config: Config, command: AskCommand, input: {id?: string; question?: string; conversationId?: string; token?: string; cursor?: string; durationMs?:number} = {}): Promise<unknown> {
    const origin = validateServerUrl(config.serverUrl), token=requireConnectionToken(config);
    const id = () => { if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id)) throw Error('Invalid ID'); return input.id; };
    let path: string, body: string | undefined;
    switch (command) {
      case 'history': path = '/api/conversations?limit=30' + (input.cursor ? '&cursor=' + encodeURIComponent(input.cursor.slice(0, 1000)) : ''); break;
      case 'runs': path = '/api/query-runs'; break;
      case 'conversation': path = '/api/conversations/' + id(); break;
      case 'run': path = '/api/query-runs/' + id(); break;
      case 'cancel': path = '/api/query-runs/' + id() + '/cancel'; body = '{}'; break;
      case 'start':
        if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 8000) throw Error(moteText('请输入问题（最多 8000 字）'));
        if (input.conversationId && !/^[a-f0-9-]{36}$/i.test(input.conversationId)) throw Error('Invalid conversation ID');
        path = '/api/query-runs'; body = JSON.stringify({id: id(), input: { question: input.question.trim(), ...(input.conversationId ? {conversationId: input.conversationId} : {}), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }}); break;
      default: throw Error('Unsupported ask command');
    }
    const response = await fetch(origin + path, {method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000), headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept-Language': getLocale()}, ...(body ? {body} : {})});
    if(!this.isCurrent(config)||!connectionToken(config)){await response.body?.cancel();this.check(config);}
    if (!response.ok) {
      await response.body?.cancel();
      if (command === 'run' && response.status === 404) return {id: input.id, status: 'failed', events: [], error: {message: moteText('对话或运行记录已删除。')}};
      throw Error(response.status === 401 || response.status === 403 ? moteText('令牌无效或已失效，请检查后重新登录。') : moteText('问答请求失败（HTTP {0}），请检查中央节点模型设置或稍后重试。', response.status));
    }
    const value=JSON.parse(await readResponseText(response,8*1024*1024));this.check(config);return value;
  }
}
