import {createHash, randomUUID} from 'node:crypto';

/** Official Feishu (Lark) IM archive connector. It attaches a new source kind
 * to the existing Feishu account binding supplied by the Central host. Archive
 * authorization is read-only; sending needs a second authorization and runs
 * only through a host-dispatched, owner-confirmed message.send action. */
export const sdkVersion = '0.1.0';

const SOURCE_KIND = 'mote.official.feishu-session';
const DEVICE_ID = 'official-feishu-session';
const STATE_KEY = 'feishu-session';
const FIRST_SYNC_DAYS = 30;
const DEFAULT_INTERVAL = 900000;
const MAX_SELECTED = 100;
const MAX_CANDIDATES = 500;
const MAX_PAGES = 20;
const MAX_TEXT = 200000;
const MAX_MESSAGE = 40000;
const READ_SCOPES = [
  'im:chat:readonly',
  'im:message:readonly',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
];
const SEND_SCOPES = ['im:message', 'im:message.send_as_user'];

class FeishuSessionError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = 'ConnectorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' ? value : '';
const cleanName = value => text(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
const statusOf = error => Number.isInteger(error?.statusCode) ? error.statusCode : 502;
const errorCode = error => typeof error?.code === 'string' ? error.code : 'feishu_session_operation_failed';
const msTime = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? new Date(number).toISOString() : now();
};

function scopeSet(values) {
  return new Set(Array.isArray(values) ? values.filter(value => typeof value === 'string') : []);
}
function readScopesOk(values) {
  const granted = scopeSet(values);
  return ['im:chat:readonly', 'im:chat:read', 'im:chat'].some(scope => granted.has(scope)) &&
    ['im:message:readonly', 'im:message', 'im:message.history:readonly'].some(scope => granted.has(scope));
}
function messageScopesOk(type, values) {
  const granted = scopeSet(values);
  if (granted.has('im:message')) return true;
  return granted.has(type === 'p2p' ? 'im:message.p2p_msg:get_as_user' : 'im:message.group_msg:get_as_user');
}
function sendScopesOk(values) {
  const granted = scopeSet(values);
  return granted.has('im:message') && (granted.has('im:message.send_as_user') || granted.has('im:message:send_as_user'));
}

function parseSelection(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  if (!Array.isArray(input.selected) || input.selected.length > MAX_SELECTED) throw new FeishuSessionError('feishu_session_input_invalid', 400);
  const selected = [], identities = new Set();
  for (const value of input.selected) {
    const id = text(value?.id), type = text(value?.type);
    if (!id || id.length > 200 || !['group', 'p2p'].includes(type) || identities.has(id)) throw new FeishuSessionError('feishu_session_input_invalid', 400);
    identities.add(id);
    selected.push({id, type});
  }
  return selected;
}

function parsedContent(value) {
  try {
    return JSON.parse(text(value));
  } catch {
    return undefined;
  }
}

function postText(content) {
  const root = content?.content ? content : (content?.zh_cn ?? content?.en_us ?? content);
  const lines = [];
  const title = text(root?.title).trim();
  if (title) lines.push(title);
  for (const block of Array.isArray(root?.content) ? root.content : []) {
    if (!Array.isArray(block)) continue;
    const line = block.map(node => text(node?.text) || text(node?.href)).join('').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function messageText(message) {
  if (message?.deleted === true) return '';
  const raw = text(message?.body?.content);
  if (!raw) return '';
  const type = text(message.msg_type);
  if (type === 'text') return text(parsedContent(raw)?.text) || raw;
  if (type === 'post') return postText(parsedContent(raw)) || raw;
  if (type === 'image') return '[图片]';
  if (type === 'file') return '[文件] ' + text(parsedContent(raw)?.file_name);
  if (type === 'audio') return '[语音]';
  if (type === 'media') return '[视频]';
  if (type === 'sticker') return '[表情]';
  if (type === 'share_chat') return '[群名片]';
  if (type === 'share_user') return '[个人名片]';
  if (type === 'interactive') return '[卡片]';
  return raw;
}

const connector = {
  apiVersion: 1,
  id: 'official-feishu-session',
  statusKey: 'official-feishu-session',
  sourceKinds: [{
    kind: SOURCE_KIND,
    capabilities: {
      lifecycle: 'continuous',
      discovery: 'explicit-selection',
      listening: 'polling',
      readOriginal: 'explicit-provider-read',
      synchronization: 'revisions',
      externalWrite: false,
    },
  }],
  create(ctx) {
    if (!ctx.state) throw Error('The Central host did not provide instance state');
    const binding = ctx.bindings?.lark;
    if (!binding || typeof binding.status !== 'function') throw Error('The Central host did not provide the lark account binding');

    let doc = {version: 1, selected: [], archiveAuthorized: false, sendAuthorized: false};
    let docRevision = 0;
    let initialized = false, closed = false, running, sequence = Promise.resolve();
    const configuredInterval = Number(ctx.config?.connectors?.syncIntervalMs);
    let state = 'idle', code, intervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0 ? Math.max(60000, configuredInterval) : DEFAULT_INTERVAL, timer;
    let snapshot = {installed: false, configured: false, connected: false, scopes: []};
    let job, controller, active;

    const sourceId = id => 'feishu-session-' + hash(id).slice(0, 24);
    const sourceName = item => ((item.type === 'p2p' ? '飞书私信 · ' : '飞书会话 · ') + cleanName(item.name)).slice(0, 200);
    const status = () => ({
      ready: true,
      sdkVersion,
      binding: 'lark',
      configured: true,
      installed: snapshot.installed !== false,
      connected: snapshot.connected === true,
      ...(snapshot.accountName ? {account: snapshot.accountName} : {}),
      ...(snapshot.accountId ? {accountId: snapshot.accountId} : {}),
      readScopesOk: readScopesOk(snapshot.scopes),
      sendScopesOk: sendScopesOk(snapshot.scopes),
      archiveAuthorized: doc.archiveAuthorized === true,
      sendAuthorized: doc.sendAuthorized === true && sendScopesOk(snapshot.scopes),
      firstSyncDays: FIRST_SYNC_DAYS,
      selected: Array.isArray(doc.selected) ? doc.selected.map(item => ({id: item.id, type: item.type, name: item.name})) : [],
      state: closed ? 'closed' : state,
      ...(code ? {code} : {}),
      ...(doc.lastSyncAt ? {lastSyncAt: doc.lastSyncAt} : {}),
      ...(job ? {job: {...job}} : {}),
    });

    const run = work => {
      const task = sequence.catch(() => {}).then(() => {
        if (closed) throw new FeishuSessionError('connector_closed', 503);
        return work();
      });
      sequence = task.catch(() => {});
      return task;
    };

    const persist = async () => {
      const saved = await ctx.state.compareAndSet(STATE_KEY, docRevision || null, doc);
      docRevision = saved.revision;
    };

    const load = async () => {
      const record = await ctx.state.get(STATE_KEY);
      if (!record?.value) return;
      const value = record.value;
      if (value.version !== 1 || !Array.isArray(value.selected) || value.selected.some(item =>
        typeof item?.id !== 'string' || !['group', 'p2p'].includes(item.type) || typeof item.name !== 'string')) {
        throw new FeishuSessionError('feishu_session_state_invalid', 503);
      }
      doc = value;
      docRevision = record.revision;
    };

    const disableSelected = () => {
      for (const item of doc.selected ?? []) {
        try {
          ctx.sources.update(sourceId(item.id), {enabled: false});
        } catch { /* A missing historical source is already stopped. */ }
      }
    };

    const ensureSources = (enable = true) => {
      for (const item of doc.selected) {
        const id = sourceId(item.id);
        ctx.sources.register({
          id, name: sourceName(item), kind: SOURCE_KIND, deviceId: DEVICE_ID,
          platform: 'import', retention: 'snapshot', enabled: true,
        });
        try {
          ctx.sources.update(id, {name: sourceName(item), ...(enable ? {enabled: true} : {})});
        } catch { /* Registration already failed above when identity changed. */ }
      }
    };

    const schedule = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (!initialized || closed || !doc.archiveAuthorized || !doc.selected.length) return;
      timer = setInterval(() => {
        if (!closed && doc.archiveAuthorized && doc.selected.length) void sync().catch(() => {});
      }, intervalMs);
      timer.unref?.();
    };

    const refresh = async () => {
      const next = await binding.status();
      snapshot = next;
      if (doc.accountId && next.accountId && doc.accountId !== next.accountId) {
        disableSelected();
        doc = {version: 1, selected: [], archiveAuthorized: false, sendAuthorized: false, accountId: next.accountId};
        await persist();
        code = 'feishu_session_account_changed';
        state = 'idle';
        schedule();
      } else if (doc.archiveAuthorized && !doc.accountId && next.accountId) {
        doc = {...doc, accountId: next.accountId};
        await persist();
      }
      return status();
    };

    const requireConnected = () => {
      if (!snapshot.connected) throw new FeishuSessionError('feishu_session_not_connected', 401);
      if (doc.accountId && snapshot.accountId && doc.accountId !== snapshot.accountId) throw new FeishuSessionError('feishu_session_account_changed', 409);
    };
    const requireReadReady = () => {
      requireConnected();
      if (!readScopesOk(snapshot.scopes)) throw new FeishuSessionError('feishu_session_scope_missing', 403);
    };

    const finishArchive = async next => {
      snapshot = next;
      if (!next.connected) throw new FeishuSessionError('feishu_session_not_connected', 401);
      if (!readScopesOk(next.scopes)) throw new FeishuSessionError('feishu_session_scope_missing', 403);
      if (doc.accountId && next.accountId && doc.accountId !== next.accountId) {
        disableSelected();
        doc = {version: 1, selected: [], archiveAuthorized: true, sendAuthorized: false, ...(next.accountId ? {accountId: next.accountId} : {})};
      } else {
        doc = {...doc, archiveAuthorized: true, ...(next.accountId ? {accountId: next.accountId} : {})};
      }
      await persist();
      state = 'idle';
      code = undefined;
      schedule();
    };

    const startJob = (kind, work) => {
      if (closed) throw new FeishuSessionError('connector_closed', 503);
      if (job && ['running', 'waiting'].includes(job.state)) throw new FeishuSessionError('feishu_session_busy', 409);
      const jobController = new AbortController();
      const current = {id: randomUUID(), kind, state: 'running'};
      controller = jobController;
      job = current;
      state = 'running';
      active = run(() => work(jobController.signal))
        .then(() => {
          if (current.state !== 'cancelled') current.state = 'completed';
          state = 'idle';
          delete current.error;
        })
        .catch(error => {
          current.state = jobController.signal.aborted ? 'cancelled' : 'failed';
          current.error = errorCode(error);
          state = current.state === 'cancelled' ? 'idle' : ([401, 403].includes(statusOf(error)) ? 'permission_required' : 'error');
          code = current.error;
        })
        .finally(() => {
          delete current.authorizationUrl;
          delete current.expiresAt;
          if (job === current) {
            active = undefined;
            controller = undefined;
          }
        });
      return current;
    };

    const performSync = async () => {
      await refresh();
      if (!doc.archiveAuthorized) throw new FeishuSessionError('feishu_session_archive_not_authorized', 403);
      requireReadReady();
      if (!doc.selected.length) throw new FeishuSessionError('feishu_session_selection_required', 409);
      state = 'syncing';
      code = undefined;
      let imported = 0, duplicates = 0, conversations = 0;
      try {
        ensureSources(false);
        for (const item of doc.selected) {
          if (closed) throw new FeishuSessionError('connector_closed', 503);
          const id = sourceId(item.id);
          let source;
          try {
            source = ctx.sources.getSource(id);
          } catch {
            continue;
          }
          if (!source.enabled) continue;
          if (!messageScopesOk(item.type, snapshot.scopes)) throw new FeishuSessionError('feishu_session_scope_missing', 403);
          ctx.sources.reportStatus(id, {state: 'syncing'});
          const start = item.lastCursor ? Math.max(0, Math.floor(Number(item.lastCursor) / 1000)) : Math.floor(Date.now() / 1000) - FIRST_SYNC_DAYS * 86400;
          let cursor, maxCursor = text(item.lastCursor);
          for (let page = 0; page < MAX_PAGES; page++) {
            const result = await binding.listMessages({
              chatId: item.id,
              startTime: String(start),
              endTime: String(Math.floor(Date.now() / 1000)),
              pageSize: 50,
              ...(cursor ? {pageToken: cursor} : {}),
            });
            for (const message of Array.isArray(result.items) ? result.items : []) {
              if (closed) throw new FeishuSessionError('connector_closed', 503);
              const messageId = text(message?.message_id);
              if (!messageId || messageId.length > 1000) continue;
              if (text(message.msg_type) === 'system') continue;
              const entry = messageItem(item, message);
              const ack = await ctx.sources.upsert(id, entry);
              ack.duplicate ? duplicates++ : imported++;
              const created = text(message.create_time);
              if (created && (!maxCursor || Number(created) > Number(maxCursor))) maxCursor = created;
            }
            cursor = text(result.pageToken);
            if (result.hasMore !== true || !cursor) break;
          }
          if (maxCursor) item.lastCursor = maxCursor;
          conversations++;
          ctx.sources.reportStatus(id, {state: 'idle', lastSyncAt: now()});
        }
        doc.lastSyncAt = now();
        await persist();
        state = 'idle';
        return {imported, duplicates, conversations, selected: doc.selected.length};
      } catch (error) {
        const failure = error instanceof FeishuSessionError ? error : new FeishuSessionError('feishu_session_sync_failed', 502);
        state = [401, 403].includes(statusOf(failure)) ? 'permission_required' : 'error';
        code = failure.code;
        for (const item of doc.selected) {
          try {
            ctx.sources.reportStatus(sourceId(item.id), {state, code});
          } catch { /* Only selected sources that still exist report failure. */ }
        }
        throw failure;
      }
    };

    const sync = () => {
      if (closed) return Promise.reject(new FeishuSessionError('connector_closed', 503));
      if (running) return running;
      running = run(performSync).finally(() => {
        running = undefined;
      });
      return running;
    };

    const messageItem = (item, message) => {
      const messageId = text(message?.message_id);
      const body = messageText(message).trim().slice(0, MAX_TEXT);
      const created = msTime(message?.create_time);
      const updated = message?.updated === true && message?.update_time ? msTime(message.update_time) : undefined;
      const sender = text(message?.sender?.name) || text(message?.sender?.id) || '飞书';
      const value = {
        externalId: messageId,
        observedAt: now(),
        ...(updated ? {modifiedAt: updated} : {}),
        title: (item.name + ' · ' + sender).slice(0, 2000),
        text: message?.deleted === true ? '' : body,
        kind: 'message',
        layer: 'snapshot',
        mimeType: 'text/plain',
        deleted: message?.deleted === true,
        metadata: {version: 1, provider: {createdAt: created, updatedAt: updated ?? created}},
      };
      const prior = ctx.sources.getItem(sourceId(item.id), messageId);
      const comparable = value => JSON.stringify({
        externalId: value.externalId, title: value.title, text: value.text, kind: value.kind,
        layer: value.layer, deleted: value.deleted, modifiedAt: value.modifiedAt, metadata: value.metadata,
      });
      if (prior && comparable(prior) === comparable(value)) return {...value, revision: prior.revision};
      return {...value, revision: hash(comparable(value) + ':' + (prior?.revision ?? ''))};
    };

    const archivePostedMessage = async (item, sent, body) => {
      const message = {
        message_id: sent.messageId,
        msg_type: 'text',
        create_time: sent.createTime || String(Date.now()),
        sender: {id: snapshot.accountName || '我'},
        body: {content: sent.content || JSON.stringify({text: body})},
      };
      const entry = messageItem(item, message);
      await ctx.sources.upsert(sourceId(item.id), entry);
      if (!item.lastCursor || Number(message.create_time) > Number(item.lastCursor)) item.lastCursor = message.create_time;
      await persist();
    };

    const listCandidates = async () => {
      await refresh();
      if (!doc.archiveAuthorized) throw new FeishuSessionError('feishu_session_archive_not_authorized', 403);
      requireReadReady();
      const channels = [], directMessages = [];
      let cursor, truncated = false;
      outer: for (let page = 0; page < MAX_PAGES; page++) {
        const result = await binding.listChats({pageSize: 100, ...(cursor ? {pageToken: cursor} : {})});
        for (const chat of Array.isArray(result.items) ? result.items : []) {
          if (channels.length + directMessages.length >= MAX_CANDIDATES) {
            truncated = true;
            break outer;
          }
          if (!chat?.id) continue;
          if (chat.type === 'p2p') directMessages.push({id: chat.id, type: 'p2p', name: chat.name});
          else channels.push({id: chat.id, type: 'group', name: chat.name});
        }
        cursor = text(result.pageToken);
        if (result.hasMore !== true || !cursor) break;
      }
      if (cursor) truncated = true;
      return {channels, directMessages, items: [...channels, ...directMessages], truncated};
    };

    const beginArchive = async () => {
      if (job && ['running', 'waiting'].includes(job.state)) throw new FeishuSessionError('feishu_session_busy', 409);
      await run(async () => {
        await refresh();
        requireConnected();
      });
      const request = await binding.startAuthorization(READ_SCOPES);
      const current = startJob('archive', async signal => {
        const next = await binding.completeAuthorization(request.id, signal);
        await finishArchive(next);
      });
      current.authorizationUrl = request.authorizationUrl;
      current.expiresAt = request.expiresAt;
      current.state = 'waiting';
      return status();
    };

    const beginSend = async () => {
      if (job && ['running', 'waiting'].includes(job.state)) throw new FeishuSessionError('feishu_session_busy', 409);
      await run(async () => {
        await refresh();
        if (!doc.archiveAuthorized) throw new FeishuSessionError('feishu_session_archive_not_authorized', 403);
        requireReadReady();
      });
      const request = await binding.startAuthorization(SEND_SCOPES);
      const current = startJob('send', async signal => {
        const next = await binding.completeAuthorization(request.id, signal);
        snapshot = next;
        if (!next.connected) throw new FeishuSessionError('feishu_session_not_connected', 401);
        if (!sendScopesOk(next.scopes)) throw new FeishuSessionError('feishu_session_scope_missing', 403);
        if (doc.accountId && next.accountId && doc.accountId !== next.accountId) throw new FeishuSessionError('feishu_session_account_changed', 409);
        doc = {...doc, sendAuthorized: true};
        await persist();
      });
      current.authorizationUrl = request.authorizationUrl;
      current.expiresAt = request.expiresAt;
      current.state = 'waiting';
      return status();
    };

    const performSend = async action => {
      if (action?.capability?.id !== 'message.send' || action.capability.version !== 1) throw new FeishuSessionError('feishu_session_action_unsupported', 403);
      if (typeof action.operationId !== 'string' || !action.operationId) throw new FeishuSessionError('feishu_session_operation_required', 400);
      const message = action.input?.message;
      if (action.input?.kind !== 'message.send' || !message || typeof message.conversationId !== 'string' || !message.conversationId || message.conversationId.length > 200 || typeof message.text !== 'string' || !message.text.trim() || message.text.length > MAX_MESSAGE) {
        throw new FeishuSessionError('feishu_session_message_invalid', 400);
      }
      if (!doc.sendAuthorized) throw new FeishuSessionError('feishu_session_send_not_authorized', 403);
      await refresh();
      if (!snapshot.connected) throw new FeishuSessionError('feishu_session_not_connected', 401);
      if (doc.accountId && snapshot.accountId && doc.accountId !== snapshot.accountId) throw new FeishuSessionError('feishu_session_account_changed', 409);
      if (!sendScopesOk(snapshot.scopes)) throw new FeishuSessionError('feishu_session_send_not_authorized', 403);
      const item = doc.selected.find(value => value.id === message.conversationId);
      if (!item) throw new FeishuSessionError('feishu_session_conversation_not_selected', 403);
      const sent = await binding.sendMessage({chatId: item.id, text: message.text, uuid: action.operationId});
      try {
        await archivePostedMessage(item, sent, message.text);
      } catch { /* The external send already happened; a failed archive must not
        make the host retry the send. The next sync can still archive the message. */ }
      return {status: 'succeeded', externalId: item.id + ':' + sent.messageId};
    };

    const instance = {
      async init() {
        await load();
        initialized = true;
        schedule();
      },
      status,
      configureSyncInterval(value) {
        const next = Number(value);
        intervalMs = Number.isFinite(next) ? Math.max(60000, next) : DEFAULT_INTERVAL;
        schedule();
      },
      check() {
        return run(refresh);
      },
      candidates() {
        return run(listCandidates);
      },
      select(raw) {
        const selection = parseSelection(raw);
        return run(async () => {
          const candidates = await listCandidates();
          const available = new Map(candidates.items.map(item => [item.id, item]));
          const prior = new Map(doc.selected.map(item => [item.id, item]));
          const chosen = selection.map(value => {
            const match = available.get(value.id);
            if (!match || match.type !== value.type) throw new FeishuSessionError('feishu_session_selection_invalid', 404);
            const previous = prior.get(match.id);
            return {
              id: match.id, type: match.type, name: match.name,
              firstSyncAt: previous?.firstSyncAt ?? now(),
              ...(previous?.lastCursor ? {lastCursor: previous.lastCursor} : {}),
            };
          });
          const keep = new Set(chosen.map(item => item.id));
          for (const previous of doc.selected) {
            if (keep.has(previous.id)) continue;
            try {
              ctx.sources.update(sourceId(previous.id), {enabled: false});
            } catch { /* A removed historical source is already stopped. */ }
          }
          doc.selected = chosen;
          await persist();
          ensureSources();
          schedule();
          return status();
        });
      },
      sync,
      executeAction(request) {
        return run(() => performSend(request));
      },
      archiveStart() {
        return beginArchive();
      },
      sendStart() {
        return beginSend();
      },
      cancel() {
        controller?.abort();
        return active ? active.catch(() => {}).then(() => status()) : Promise.resolve(status());
      },
      disconnect() {
        controller?.abort();
        return run(async () => {
          disableSelected();
          doc = {version: 1, selected: [], archiveAuthorized: false, sendAuthorized: false};
          await persist();
          state = 'idle';
          code = undefined;
          schedule();
          return status();
        });
      },
      disconnectSend() {
        controller?.abort();
        return run(async () => {
          doc = {...doc, sendAuthorized: false};
          await persist();
          return status();
        });
      },
      configure(host) {
        host.ownerRoute({method: 'GET', path: '/api/connectors/feishu-session', handler: status});
        host.ownerRoute({method: 'POST', path: '/api/connectors/feishu-session/check', handler: () => instance.check()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/feishu-session/archive/start', handler: () => instance.archiveStart()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/feishu-session/send/start', handler: () => instance.sendStart()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/feishu-session/send/disconnect', handler: () => instance.disconnectSend()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/feishu-session/candidates', handler: () => instance.candidates()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/feishu-session/select', handler: request => instance.select(request.body)});
        host.ownerRoute({method: 'POST', path: '/api/connectors/feishu-session/sync', handler: () => instance.sync()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/feishu-session/cancel', handler: () => instance.cancel()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/feishu-session/disconnect', handler: () => instance.disconnect()});
      },
      async close() {
        closed = true;
        if (timer) clearInterval(timer);
        timer = undefined;
        controller?.abort();
        await active?.catch(() => {});
        await sequence.catch(() => {});
      },
    };
    return instance;
  },
};

export {connector, connector as default};
