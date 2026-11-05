import type { AskRun, AskScope, AskConversation, AskCommand } from './contracts/ask';
export type { AskRun, AskScope, AskConversation, AskCommand } from './contracts/ask';
import { connectionToken, requireConnectionToken } from './login-session';
import { getLocale, moteText } from '@mote/shared/i18n';
import type { Config } from './contracts';
import { validateServerUrl } from './config';
import { readResponseText } from './response-body';

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
      case 'conversation':
        if (input.cursor !== undefined && !/^\d{1,9}$/.test(input.cursor)) throw Error('Invalid turn cursor');
        path = '/api/conversations/' + id() + '?limit=20' + (input.cursor !== undefined ? '&cursor=' + input.cursor : ''); break;
      case 'reference':
        if(typeof input.conversationId!=='string'||!/^[a-f0-9-]{36}$/i.test(input.conversationId))throw Error('Invalid conversation ID');
        path='/api/conversations/'+input.conversationId+'/references/'+id();break;
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
      if (command === 'run' && response.status === 404) return {id: input.id, notFound:true, status: 'failed', events: [], error: {message: moteText('对话或运行记录已删除。')}};
      throw Error(response.status === 401 || response.status === 403 ? moteText('令牌无效或已失效，请检查后重新登录。') : command==='history'?moteText('对话暂不可读取，请稍后重试。'):command==='reference'?moteText('这条引用暂时打不开，请稍后重试。'):moteText('问答请求失败（HTTP {0}）。检查中央模型设置或稍后重试', response.status));
    }
    const value=JSON.parse(await readResponseText(response,8*1024*1024));this.check(config);if(['start','run','cancel'].includes(command)&&(value?.id!==input.id||value?.notFound!==undefined||!['running','completed','failed','cancelled'].includes(value?.status)||!Array.isArray(value?.events)))throw Error('Invalid query run response');if(command==='reference'&&(value?.id!==input.id||typeof value?.available!=='boolean'))throw Error('Invalid reference availability');return value;
  }
}
