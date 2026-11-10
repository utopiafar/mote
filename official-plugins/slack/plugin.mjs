import {createHash, randomBytes} from 'node:crypto';

/** Official Slack archive connector. It archives only the owner-selected
 * conversations with a Slack user token. Sending uses a separate user token and
 * runs only through a host-dispatched, owner-confirmed message.send action. */
export const sdkVersion = '0.1.0';

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const API_ROOT = 'https://slack.com';
const SOURCE_KIND = 'mote.official.slack';
const DEVICE_ID = 'official-slack';
const STATE_KEY = 'slack';
const FIRST_SYNC_DAYS = 30;
const DEFAULT_INTERVAL = 900000;
const MAX_SELECTED = 100;
const MAX_CANDIDATES = 500;
const MAX_PAGES = 20;
const MAX_REPLIES = 100;
const MAX_TEXT = 200000;
const MAX_RESPONSE = 8 * 1024 * 1024;
const READ_SCOPES = [
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'users:read',
];
const SEND_SCOPES = ['chat:write'];
const READ_PATHS = new Set([
  '/api/conversations.list', '/api/conversations.info', '/api/users.info',
  '/api/conversations.history', '/api/conversations.replies', '/api/auth.test',
]);
const SYSTEM_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'channel_archive', 'channel_unarchive',
]);

/** The single allowlist for Slack HTTP methods and paths. Archive reads are
 * GET/POST read methods, OAuth exchange is a token POST, and chat.postMessage is
 * reachable only through the host action path below. */
export function slackRequestKind(method, pathname) {
  const verb = String(method).toUpperCase();
  if (verb === 'POST' && pathname === '/api/oauth.v2.access') return 'token';
  if ((verb === 'GET' || verb === 'POST') && READ_PATHS.has(pathname)) return 'read';
  if (verb === 'POST' && pathname === '/api/chat.postMessage') return 'send';
  return undefined;
}

class SlackError extends Error {
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
const scopes = value => text(value).split(/[,\s]+/).filter(Boolean);
const hasScopes = (granted, required) => required.every(scope => granted.includes(scope));
const slackTime = value => {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : now();
};
const cleanName = value => text(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);

function teamUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '') + '/';
  } catch {
    return undefined;
  }
}

function permalink(base, channel, ts) {
  return base ? base + 'archives/' + encodeURIComponent(channel) + '/p' + String(ts).replace('.', '') : undefined;
}

function parseSelection(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  if (!Array.isArray(input.selected) || input.selected.length > MAX_SELECTED) throw new SlackError('slack_input_invalid', 400);
  const selected = [], identities = new Set();
  for (const value of input.selected) {
    const id = text(value?.id), type = text(value?.type);
    if (!id || id.length > 200 || !['channel', 'im', 'mpim'].includes(type) || identities.has(id)) throw new SlackError('slack_input_invalid', 400);
    identities.add(id);
    selected.push({id, type});
  }
  return selected;
}

const connector = {
  apiVersion: 1,
  id: 'official-slack',
  statusKey: 'official-slack',
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
    const configuration = ctx.activation?.configuration ?? {};
    const secrets = ctx.activation?.secrets ?? {};
    const clientId = text(configuration.clientId).trim();
    const clientSecret = text(secrets.clientSecret);
    const redirectUri = text(configuration.redirectUri).trim();
    const fetcher = ctx.fetch ?? globalThis.fetch;

    let doc = {version: 1, selected: []};
    let docRevision = 0;
    let initialized = false, closed = false, running, sequence = Promise.resolve();
    const configuredInterval = Number(ctx.config?.connectors?.syncIntervalMs);
    let state = 'idle', code, intervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0 ? Math.max(60000, configuredInterval) : DEFAULT_INTERVAL, timer;
    const pending = new Map(), abort = new AbortController();
    const userNames = new Map();
    const configured = () => Boolean(clientId && clientSecret && redirectUri);
    const readToken = () => text(doc.read?.accessToken);
    const sendToken = () => text(doc.send?.accessToken);
    const readScopesOk = () => hasScopes(Array.isArray(doc.read?.scopes) ? doc.read.scopes : [], READ_SCOPES);
    const sendScopesOk = () => hasScopes(Array.isArray(doc.send?.scopes) ? doc.send.scopes : [], SEND_SCOPES);
    const sourceId = id => 'slack-' + hash(id).slice(0, 24);
    const sourceName = item => {
      if (item.type === 'channel') return ('Slack · #' + cleanName(item.name).replace(/^#/, '')).slice(0, 200);
      if (item.type === 'mpim') return ('Slack · 群组私信 · ' + cleanName(item.name)).slice(0, 200);
      return ('Slack · 私信 · ' + cleanName(item.name)).slice(0, 200);
    };
    const status = () => ({
      ready: true,
      sdkVersion,
      configured: configured(),
      connected: Boolean(readToken()),
      readOnly: true,
      readScopesOk: readScopesOk(),
      sendAuthorized: Boolean(sendToken()) && sendScopesOk(),
      firstSyncDays: FIRST_SYNC_DAYS,
      ...(doc.read?.userName ? {user: doc.read.userName} : {}),
      ...(doc.read?.teamName ? {team: doc.read.teamName} : {}),
      selected: Array.isArray(doc.selected) ? doc.selected.map(item => ({id: item.id, type: item.type, name: item.name})) : [],
      state: closed ? 'closed' : state,
      ...(code ? {code} : {}),
      ...(doc.lastSyncAt ? {lastSyncAt: doc.lastSyncAt} : {}),
    });

    const run = work => {
      const task = sequence.catch(() => {}).then(() => {
        if (closed) throw new SlackError('connector_closed', 503);
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
        typeof item?.id !== 'string' || !['channel', 'im', 'mpim'].includes(item.type) || typeof item.name !== 'string')) {
        throw new SlackError('slack_state_invalid', 503);
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
          // A paused single source stays paused; a newly selected one is enabled.
          ctx.sources.update(id, {name: sourceName(item), ...(enable ? {enabled: true} : {})});
        } catch { /* Registration already failed above when identity changed. */ }
      }
    };

    const schedule = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (!initialized || closed || !configured() || !readToken() || !doc.selected.length) return;
      timer = setInterval(() => {
        if (!closed && readToken() && doc.selected.length) void sync().catch(() => {});
      }, intervalMs);
      timer.unref?.();
    };

    const request = async ({purpose, method, path, query, form, token}) => {
      if (closed) throw new SlackError('connector_closed', 503);
      if (slackRequestKind(method, path) !== purpose) throw new SlackError('slack_method_blocked', 403);
      if (purpose !== 'token' && !token) throw new SlackError(purpose === 'send' ? 'slack_send_not_authorized' : 'slack_not_connected', purpose === 'send' ? 403 : 401);
      const url = new URL(API_ROOT + path);
      for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
      const headers = {};
      let body;
      if (form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form).toString();
      }
      if (token) headers.Authorization = 'Bearer ' + token;
      const response = await fetcher(url, {
        method,
        headers,
        ...(body === undefined ? {} : {body}),
        redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
      });
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_RESPONSE) throw new SlackError('slack_response_too_large', 413);
      const raw = await response.text();
      if (raw.length > MAX_RESPONSE) throw new SlackError('slack_response_too_large', 413);
      let parsed;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        throw new SlackError('slack_response_invalid', 502);
      }
      if (!response.ok || parsed?.ok !== true) {
        const provider = text(parsed?.error);
        if ([401, 403].includes(response.status) || /^(invalid_auth|not_authed|token_revoked|account_inactive|missing_scope|invalid_scope)$/.test(provider)) {
          throw new SlackError(provider === 'missing_scope' || provider === 'invalid_scope' ? 'slack_scope_missing' : 'slack_permission_required', 403);
        }
        if (response.status === 429 || response.status === 503) throw new SlackError('slack_rate_limited', 503);
        if (response.status === 404) throw new SlackError('slack_not_found', 404);
        throw new SlackError('slack_request_failed', response.status >= 400 ? response.status : 502);
      }
      return parsed;
    };

    const readApi = (method, path, query) => {
      if (!readToken()) throw new SlackError('slack_not_connected', 401);
      if (!readScopesOk()) throw new SlackError('slack_scope_missing', 403);
      return request({purpose: 'read', method, path, query, token: readToken()});
    };

    const tokenRequest = async authorizationCode => {
      if (!configured()) throw new SlackError('slack_not_configured', 503);
      const body = await request({
        purpose: 'token',
        method: 'POST',
        path: '/api/oauth.v2.access',
        form: {
          client_id: clientId,
          client_secret: clientSecret,
          code: authorizationCode,
          redirect_uri: redirectUri,
        },
      });
      const user = body?.authed_user;
      if (typeof user?.access_token !== 'string' || !user.access_token) throw new SlackError('slack_authorization_failed', 400);
      return {
        accessToken: user.access_token,
        userId: text(user.id),
        grantedScopes: scopes(user.scope),
        teamId: text(body?.team?.id),
        teamName: text(body?.team?.name),
      };
    };

    const authTest = async token => {
      const body = await request({purpose: 'read', method: 'GET', path: '/api/auth.test', token});
      if (body?.ok !== true || typeof body.user_id !== 'string') throw new SlackError('slack_authorization_failed', 400);
      return {
        userId: body.user_id,
        userName: text(body.user),
        teamId: text(body.team_id),
        teamName: text(body.team),
        teamUrl: teamUrl(body.url),
      };
    };

    const userName = async id => {
      if (!id) return 'Slack';
      if (userNames.has(id)) return userNames.get(id);
      try {
        const body = await readApi('GET', '/api/users.info', {user: id});
        const name = cleanName(body?.user?.profile?.display_name || body?.user?.real_name || body?.user?.name || id) || id;
        userNames.set(id, name);
        return name;
      } catch {
        userNames.set(id, id);
        return id;
      }
    };

    const listCandidates = async () => {
      const channels = [], directMessages = [];
      let cursor, truncated = false;
      outer: for (let page = 0; page < MAX_PAGES; page++) {
        const body = await readApi('GET', '/api/conversations.list', {
          types: 'public_channel,private_channel,mpim,im',
          exclude_archived: 'true',
          limit: '200',
          ...(cursor ? {cursor} : {}),
        });
        for (const entry of Array.isArray(body?.channels) ? body.channels : []) {
          if (channels.length + directMessages.length >= MAX_CANDIDATES) {
            truncated = true;
            break outer;
          }
          if (typeof entry?.id !== 'string' || entry.id.length > 200) continue;
          if (entry.is_im === true) {
            const name = cleanName(entry.user ? await userName(entry.user) : '') || entry.user || entry.id;
            directMessages.push({id: entry.id, type: 'im', name});
          } else if (entry.is_mpim === true) {
            directMessages.push({id: entry.id, type: 'mpim', name: cleanName(entry.name) || '群组私信'});
          } else if (entry.is_channel === true || entry.is_private === true || entry.is_group === true) {
            channels.push({id: entry.id, type: 'channel', name: cleanName(entry.name) || entry.id});
          }
        }
        cursor = text(body?.response_metadata?.next_cursor);
        if (!cursor) break;
      }
      if (cursor) truncated = true;
      return {channels, directMessages, items: [...channels, ...directMessages], truncated};
    };

    const repliesFor = async (channel, ts) => {
      try {
        const body = await readApi('GET', '/api/conversations.replies', {channel, ts, limit: String(MAX_REPLIES)});
        return (Array.isArray(body?.messages) ? body.messages : []).filter(message => message?.ts !== ts).slice(0, MAX_REPLIES);
      } catch {
        return [];
      }
    };

    const messageItem = async (item, message, replies) => {
      const lines = [];
      for (const value of [message, ...replies]) {
        const body = text(value?.text).trim();
        if (!body) continue;
        lines.push(slackTime(value.ts) + ' ' + (await userName(text(value.user) || text(value.bot_id))) + ': ' + body);
      }
      const content = lines.join('\n').slice(0, MAX_TEXT);
      const ts = text(message.ts);
      const modifiedAt = text(message.edited?.ts) ? slackTime(message.edited.ts) : undefined;
      const uri = permalink(doc.read?.teamUrl, item.id, ts);
      const revision = hash(JSON.stringify({channel: item.id, ts, text: content, edited: message.edited, replies: replies.map(reply => [reply.ts, reply.text, reply.edited])}));
      const author = await userName(text(message.user) || text(message.bot_id));
      return {
        externalId: ts,
        revision,
        observedAt: now(),
        ...(modifiedAt ? {modifiedAt} : {}),
        title: (item.name + ' · ' + author).slice(0, 2000),
        text: content,
        kind: 'message',
        layer: 'snapshot',
        mimeType: 'text/plain',
        ...(uri ? {uri} : {}),
        metadata: {version: 1, provider: {createdAt: slackTime(ts), updatedAt: modifiedAt ?? slackTime(ts)}},
      };
    };

    const performSync = async () => {
      if (!configured()) throw new SlackError('slack_not_configured', 503);
      if (!readToken()) throw new SlackError('slack_not_connected', 401);
      if (!doc.selected.length) throw new SlackError('slack_selection_required', 409);
      state = 'syncing';
      code = undefined;
      let imported = 0, duplicates = 0, conversations = 0;
      try {
        ensureSources(false);
        for (const item of doc.selected) {
          if (closed) throw new SlackError('connector_closed', 503);
          const id = sourceId(item.id);
          let source;
          try {
            source = ctx.sources.getSource(id);
          } catch {
            continue;
          }
          if (!source.enabled) continue;
          ctx.sources.reportStatus(id, {state: 'syncing'});
          const oldest = text(item.lastTs) || String(Math.floor(Date.now() / 1000) - FIRST_SYNC_DAYS * 86400);
          let cursor, maxTs = text(item.lastTs);
          for (let page = 0; page < MAX_PAGES; page++) {
            const body = await readApi('GET', '/api/conversations.history', {
              channel: item.id,
              oldest,
              limit: '200',
              ...(cursor ? {cursor} : {}),
            });
            for (const message of Array.isArray(body?.messages) ? body.messages : []) {
              if (closed) throw new SlackError('connector_closed', 503);
              const ts = text(message?.ts);
              if (!/^\d+(?:\.\d+)?$/.test(ts) || SYSTEM_SUBTYPES.has(text(message.subtype))) continue;
              const replies = Number(message.reply_count) > 0 ? await repliesFor(item.id, ts) : [];
              const entry = await messageItem(item, message, replies);
              const result = await ctx.sources.upsert(id, entry);
              result.duplicate ? duplicates++ : imported++;
              if (!maxTs || Number(ts) > Number(maxTs)) maxTs = ts;
            }
            cursor = text(body?.response_metadata?.next_cursor);
            if (!cursor) break;
          }
          if (maxTs) item.lastTs = maxTs;
          conversations++;
          ctx.sources.reportStatus(id, {state: 'idle', lastSyncAt: now()});
        }
        doc.lastSyncAt = now();
        await persist();
        state = 'idle';
        return {imported, duplicates, conversations, selected: doc.selected.length};
      } catch (error) {
        const failure = error instanceof SlackError ? error : new SlackError('slack_sync_failed', 502);
        state = [401, 403].includes(failure.statusCode) ? 'permission_required' : 'error';
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
      if (closed) return Promise.reject(new SlackError('connector_closed', 503));
      if (running) return running;
      running = run(performSync).finally(() => {
        running = undefined;
      });
      return running;
    };

    const completeAuthorization = async (authorizationCode, mode) => {
      const token = await tokenRequest(authorizationCode);
      if (mode === 'read') {
        if (!hasScopes(token.grantedScopes, READ_SCOPES)) throw new SlackError('slack_scope_missing', 403);
        const profile = await authTest(token.accessToken);
        if (closed) throw new SlackError('connector_closed', 503);
        disableSelected();
        doc = {
          version: 1,
          read: {
            accessToken: token.accessToken,
            userId: profile.userId || token.userId,
            userName: profile.userName,
            teamId: profile.teamId || token.teamId,
            teamName: profile.teamName || token.teamName,
            teamUrl: profile.teamUrl,
            scopes: token.grantedScopes,
            connectedAt: now(),
          },
          selected: [],
        };
        await persist();
        state = 'idle';
        code = undefined;
        schedule();
        return status();
      }
      if (!hasScopes(token.grantedScopes, SEND_SCOPES)) throw new SlackError('slack_scope_missing', 403);
      doc.send = {
        accessToken: token.accessToken,
        userId: token.userId,
        scopes: token.grantedScopes,
        connectedAt: now(),
      };
      await persist();
      return status();
    };

    const archivePostedMessage = async (item, body, ts) => {
      const message = {ts, user: doc.send?.userId || doc.read?.userId, text: body};
      const entry = await messageItem(item, message, []);
      await ctx.sources.upsert(sourceId(item.id), entry);
      if (!item.lastTs || Number(ts) > Number(item.lastTs)) item.lastTs = ts;
      await persist();
    };

    const performSend = async action => {
      if (action?.capability?.id !== 'message.send' || action.capability.version !== 1) throw new SlackError('slack_action_unsupported', 403);
      if (typeof action.operationId !== 'string' || !action.operationId) throw new SlackError('slack_operation_required', 400);
      const message = action.input?.message;
      if (action.input?.kind !== 'message.send' || !message || typeof message.conversationId !== 'string' || !message.conversationId || message.conversationId.length > 200 || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 40000) {
        throw new SlackError('slack_message_invalid', 400);
      }
      if (!readToken() || !readScopesOk()) throw new SlackError('slack_not_connected', 401);
      if (!sendToken() || !sendScopesOk()) throw new SlackError('slack_send_not_authorized', 403);
      const item = doc.selected.find(value => value.id === message.conversationId);
      if (!item) throw new SlackError('slack_conversation_not_selected', 403);
      const body = await request({
        purpose: 'send',
        method: 'POST',
        path: '/api/chat.postMessage',
        form: {channel: item.id, text: message.text},
        token: sendToken(),
      });
      if (typeof body?.ts !== 'string' || body.channel !== item.id) throw new SlackError('slack_send_failed', 502);
      try {
        await archivePostedMessage(item, message.text, body.ts);
      } catch { /* The external send already happened; a failed archive must not
        make the host retry the send. The next sync can still archive the message. */ }
      return {status: 'succeeded', externalId: item.id + ':' + body.ts};
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
      start() {
        if (!configured()) throw new SlackError('slack_not_configured', 503);
        for (const [key, entry] of pending) if (entry.expires < Date.now() || entry.mode === 'send') pending.delete(key);
        const oauthState = 'slack.read.' + randomBytes(32).toString('base64url');
        pending.set(oauthState, {mode: 'read', expires: Date.now() + 600000});
        const url = new URL(AUTHORIZE_URL);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('user_scope', READ_SCOPES.join(','));
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('state', oauthState);
        return {authorizationUrl: url.toString(), expiresIn: 600, readOnly: true};
      },
      startSend() {
        if (!configured()) throw new SlackError('slack_not_configured', 503);
        if (!readToken() || !readScopesOk()) throw new SlackError('slack_not_connected', 401);
        for (const [key, entry] of pending) if (entry.expires < Date.now() || entry.mode === 'send') pending.delete(key);
        const oauthState = 'slack.send.' + randomBytes(32).toString('base64url');
        pending.set(oauthState, {mode: 'send', expires: Date.now() + 600000});
        const url = new URL(AUTHORIZE_URL);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('user_scope', SEND_SCOPES.join(','));
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('state', oauthState);
        return {authorizationUrl: url.toString(), expiresIn: 600, readOnly: false};
      },
      callback(stateValue, authorizationCode, mode) {
        const entry = pending.get(stateValue);
        pending.delete(stateValue);
        if (!entry || entry.mode !== mode || entry.expires < Date.now()) return Promise.reject(new SlackError('slack_state_invalid', 400));
        return run(() => completeAuthorization(authorizationCode, mode));
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
            if (!match || match.type !== value.type) throw new SlackError('slack_selection_invalid', 404);
            return {
              id: match.id, type: match.type, name: match.name,
              firstSyncAt: prior.get(match.id)?.firstSyncAt ?? now(),
              ...(prior.get(match.id)?.lastTs ? {lastTs: prior.get(match.id).lastTs} : {}),
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
          return {status: status(), selected: status().selected};
        });
      },
      sync,
      executeAction(request) {
        return run(() => performSend(request));
      },
      disconnect() {
        return run(async () => {
          disableSelected();
          doc = {version: 1, selected: []};
          await persist();
          pending.clear();
          state = 'idle';
          code = undefined;
          schedule();
          return status();
        });
      },
      disconnectSend() {
        return run(async () => {
          for (const [key, entry] of pending) if (entry.mode === 'send') pending.delete(key);
          delete doc.send;
          await persist();
          return status();
        });
      },
      configure(host) {
        host.ownerRoute({method: 'GET', path: '/api/connectors/slack', handler: status});
        host.ownerRoute({method: 'POST', path: '/api/connectors/slack/start', handler: () => instance.start()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/slack/candidates', handler: () => instance.candidates()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/slack/select', handler: request => instance.select(request.body)});
        host.ownerRoute({method: 'POST', path: '/api/connectors/slack/sync', handler: () => instance.sync()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/slack/send/start', handler: () => instance.startSend()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/slack/send/disconnect', handler: () => instance.disconnectSend()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/slack/disconnect', handler: () => instance.disconnect()});
        host.oauthCallback({
          path: '/oauth/slack/callback',
          statePrefix: 'slack.read.',
          complete: (stateValue, authorizationCode) => instance.callback(stateValue, authorizationCode, 'read'),
          successMessage: 'Slack 归档已连接。请回到来源，预览并勾选要归档的频道或私信。',
          failureMessage: 'Slack 归档授权未完成。请回到来源重试。',
        });
        host.oauthCallback({
          path: '/oauth/slack/callback',
          statePrefix: 'slack.send.',
          complete: (stateValue, authorizationCode) => instance.callback(stateValue, authorizationCode, 'send'),
          successMessage: 'Slack 发送授权已连接。发送仍需在行动平台逐条确认。',
          failureMessage: 'Slack 发送授权未完成。请回到来源重试。',
        });
      },
      async close() {
        closed = true;
        if (timer) clearInterval(timer);
        timer = undefined;
        pending.clear();
        abort.abort();
        await sequence.catch(() => {});
      },
    };
    return instance;
  },
};

export {connector, connector as default};
