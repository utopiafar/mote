import { getLocale, moteText } from '@mote/shared/i18n';
import type { Config } from './contracts';
import { validateServerUrl } from './config';
import { readResponseText } from './response-body';
export interface AskRun { id: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; conversationId?: string; events: { stage: string; message?: string; tool?: string }[]; error?: {message: string} }
export interface AskConversation { id: string; title: string; turns: { question: string; status: string; error?: {message: string}; result?: { answer: string; citations: {id: string; appName: string; capturedAt: string; excerpt: string}[] } }[] }
export type AskCommand = 'history' | 'runs' | 'conversation' | 'run' | 'start' | 'cancel' | 'login' | 'logout';
/** Fixed endpoints only. Owner credentials remain in the main process and are scoped to one origin. */
export class AskClient {
  private ownerToken = '';
  private signedOut = false;
  private origin = '';
  async request(config: Config, command: AskCommand, input: {id?: string; question?: string; conversationId?: string; token?: string; cursor?: string} = {}): Promise<unknown> {
    const origin = validateServerUrl(config.serverUrl);
    if (origin !== this.origin) { this.ownerToken = ''; this.origin = origin; }
    if (command === 'logout') { this.ownerToken = ''; this.signedOut = true; return {}; }
    if (command === 'login') {
      if (typeof input.token !== 'string' || input.token.length < 32 || input.token.length > 8192 || /[\r\n]/.test(input.token)) throw Error(moteText('请输入有效的中央所有者令牌'));
      this.ownerToken = input.token; this.signedOut = false;
      try { await this.request(config, 'history'); } catch (error) { this.ownerToken = ''; throw error; }
      return {};
    }
    const token = this.ownerToken || (!this.signedOut && config.credentialScope !== 'collector' ? config.token : undefined);
    if (!token) throw Error(moteText('问一问需要中央所有者令牌；设备采集凭据不能读取个人归档。'));
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
    if (!response.ok) {
      await response.body?.cancel();
      if (command === 'run' && response.status === 404) return {id: input.id, status: 'failed', events: [], error: {message: moteText('对话或运行记录已删除。')}};
      throw Error(response.status === 401 || response.status === 403 ? moteText('问一问需要有效的中央所有者令牌，请重新登录。') : moteText('问答请求失败（HTTP {0}），请检查中央节点模型设置或稍后重试。', response.status));
    }
    return JSON.parse(await readResponseText(response, 8 * 1024 * 1024));
  }
}
