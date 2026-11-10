import {createHash, randomBytes} from 'node:crypto';

/** Official Notion read-only connector. It archives only the pages/databases
 * the owner selects after OAuth. The read guard accepts GET plus the three
 * Notion read/authorization POST endpoints and refuses every other method or
 * path before a request leaves the host. */
export const sdkVersion = '0.1.0';

const NOTION_VERSION = '2022-06-28';
const AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.notion.com/v1/oauth/token';
const API_ROOT = 'https://api.notion.com';
const SOURCE_KIND = 'mote.official.notion';
const DEVICE_ID = 'official-notion';
const STATE_KEY = 'notion';
const MAX_SELECTED = 50;
const MAX_BLOCKS = 200;
const MAX_DATABASE_ENTRIES = 100;
const MAX_TEXT = 100000;
const DEFAULT_INTERVAL = 900000;

class NotionError extends Error {
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
const richText = items => (Array.isArray(items) ? items : []).map(item => text(item?.plain_text)).join('');

function pageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function titleOf(value) {
  for (const property of Object.values(value?.properties ?? {})) {
    if (property?.type === 'title') {
      const title = richText(property.title).trim();
      if (title) return title;
    }
  }
  if (Array.isArray(value?.title)) {
    const title = richText(value.title).trim();
    if (title) return title;
  }
  return typeof value?.title === 'string' ? value.title.trim() : '';
}

function propertyValue(property) {
  if (!property || typeof property !== 'object') return '';
  switch (property.type) {
    case 'title': return richText(property.title);
    case 'rich_text': return richText(property.rich_text);
    case 'number': return typeof property.number === 'number' ? String(property.number) : '';
    case 'select': return text(property.select?.name);
    case 'status': return text(property.status?.name);
    case 'multi_select': return (Array.isArray(property.multi_select) ? property.multi_select : []).map(item => text(item?.name)).filter(Boolean).join(', ');
    case 'date': return text(property.date?.start);
    case 'checkbox': return property.checkbox === true ? 'true' : 'false';
    case 'url': return text(property.url);
    case 'email': return text(property.email);
    case 'phone_number': return text(property.phone_number);
    case 'formula': {
      const value = property.formula;
      if (typeof value?.string === 'string') return value.string;
      if (typeof value?.number === 'number') return String(value.number);
      if (typeof value?.boolean === 'boolean') return String(value.boolean);
      if (typeof value?.date?.start === 'string') return value.date.start;
      return '';
    }
    case 'rollup': {
      const value = property.rollup;
      if (typeof value?.number === 'number') return String(value.number);
      if (typeof value?.date?.start === 'string') return value.date.start;
      if (Array.isArray(value?.array)) return value.array.map(item => propertyValue(item)).filter(Boolean).join(', ');
      return '';
    }
    case 'relation': return Array.isArray(property.relation) ? String(property.relation.length) : '';
    case 'created_time': return text(property.created_time);
    case 'last_edited_time': return text(property.last_edited_time);
    default: return '';
  }
}

function propertiesText(properties) {
  const lines = [];
  for (const [name, property] of Object.entries(properties ?? {}).slice(0, 50)) {
    const value = propertyValue(property).trim().slice(0, 500);
    if (value) lines.push(name + ': ' + value);
    if (lines.length >= 100) break;
  }
  return lines.join('\n').slice(0, 20000);
}

function blockText(block) {
  const type = text(block?.type);
  const value = block?.[type];
  if (type === 'child_page' || type === 'child_database') return text(value?.title);
  const content = richText(value?.rich_text).trim();
  if (!content) return '';
  const prefix = {
    heading_1: '# ', heading_2: '## ', heading_3: '### ',
    bulleted_list_item: '- ', numbered_list_item: '1. ', to_do: '- [ ] ', quote: '> ',
  }[type] ?? '';
  return prefix + content;
}

function parseSelection(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  if (!Array.isArray(input.selected) || input.selected.length > MAX_SELECTED) throw new NotionError('notion_input_invalid', 400);
  const selected = [], identities = new Set();
  for (const value of input.selected) {
    const id = text(value?.id), type = text(value?.type);
    if (!id || id.length > 200 || (type !== 'page' && type !== 'database') || identities.has(id)) throw new NotionError('notion_input_invalid', 400);
    identities.add(id);
    selected.push({id, type});
  }
  return selected;
}

const connector = {
  apiVersion: 1,
  id: 'official-notion',
  statusKey: 'official-notion',
  sourceKinds: [{
    kind: SOURCE_KIND,
    capabilities: {
      lifecycle: 'continuous',
      discovery: 'explicit-selection',
      listening: 'none',
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
    const configured = () => Boolean(clientId && clientSecret && redirectUri);

    const sourceId = id => 'notion-' + hash(id).slice(0, 24);
    const sourceName = item => ('Notion · ' + (text(item.title).trim() || (item.type === 'database' ? '数据库' : '页面'))).slice(0, 200);
    const status = () => ({
      ready: true,
      sdkVersion,
      configured: configured(),
      connected: typeof doc.token?.accessToken === 'string',
      readOnly: true,
      ...(doc.token?.workspaceName ? {workspace: doc.token.workspaceName} : {}),
      selected: doc.selected.map(item => ({id: item.id, type: item.type, title: item.title ?? ''})),
      state: closed ? 'closed' : state,
      ...(code ? {code} : {}),
      ...(doc.lastSyncAt ? {lastSyncAt: doc.lastSyncAt} : {}),
    });

    const run = work => {
      const task = sequence.catch(() => {}).then(() => {
        if (closed) throw new NotionError('connector_closed', 503);
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
      if (value.version !== 1 || !Array.isArray(value.selected) || value.selected.some(item => typeof item?.id !== 'string' || (item.type !== 'page' && item.type !== 'database'))) throw new NotionError('notion_state_invalid', 503);
      doc = value;
      docRevision = record.revision;
    };

    const disableSelected = () => {
      for (const item of doc.selected) {
        try {
          ctx.sources.update(sourceId(item.id), {enabled: false});
        } catch { /* A missing historical source is already stopped. */ }
      }
    };

    const ensureSources = () => {
      for (const item of doc.selected) {
        const id = sourceId(item.id);
        ctx.sources.register({
          id, name: sourceName(item), kind: SOURCE_KIND, deviceId: DEVICE_ID,
          platform: 'import', retention: 'snapshot', enabled: true,
        });
        try {
          ctx.sources.update(id, {name: sourceName(item), enabled: true});
        } catch { /* Registration already failed above when identity changed. */ }
      }
    };

    const schedule = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (!initialized || closed || !configured() || !doc.token?.accessToken || !doc.selected.length) return;
      timer = setInterval(() => {
        if (!closed && doc.token?.accessToken && doc.selected.length) void sync().catch(() => {});
      }, intervalMs);
      timer.unref?.();
    };

    const send = async (url, init) => {
      if (closed) throw new NotionError('connector_closed', 503);
      const response = await fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
      });
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > 8 * 1024 * 1024) throw new NotionError('notion_response_too_large', 413);
      const raw = await response.text();
      if (raw.length > 8 * 1024 * 1024) throw new NotionError('notion_response_too_large', 413);
      let body;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        throw new NotionError('notion_response_invalid', 502);
      }
      return {response, body};
    };

    const api = async (method, path, body) => {
      const allowed = method === 'GET' || method === 'POST' && (path === '/v1/search' || /^\/v1\/databases\/[^/]+\/query$/.test(path));
      if (!allowed) throw new NotionError('notion_write_blocked', 403);
      const token = doc.token?.accessToken;
      if (typeof token !== 'string' || !token) throw new NotionError('notion_not_connected', 401);
      const result = await send(API_ROOT + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          'Notion-Version': NOTION_VERSION,
          ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
        },
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      if (!result.response.ok) {
        if (result.response.status === 401 || result.response.status === 403) {
          state = 'permission_required';
          code = 'notion_permission_required';
          throw new NotionError(code, result.response.status);
        }
        if (result.response.status === 404) throw new NotionError('notion_resource_not_found', 404);
        if (result.response.status === 429 || result.response.status === 503) throw new NotionError('notion_rate_limited', 503);
        throw new NotionError('notion_request_failed', 502);
      }
      return result.body;
    };

    const tokenRequest = async authorizationCode => {
      if (!configured()) throw new NotionError('notion_not_configured', 503);
      const result = await send(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
          'Content-Type': 'application/json',
          'Notion-Version': NOTION_VERSION,
        },
        body: JSON.stringify({grant_type: 'authorization_code', code: authorizationCode, redirect_uri: redirectUri}),
      });
      if (!result.response.ok || typeof result.body?.access_token !== 'string') throw new NotionError('notion_authorization_failed', 400);
      return result.body;
    };

    const listCandidates = async () => {
      const body = await api('POST', '/v1/search', {page_size: 100, sort: {direction: 'descending', timestamp: 'last_edited_time'}});
      const items = [];
      for (const entry of Array.isArray(body?.results) ? body.results : []) {
        if ((entry?.object !== 'page' && entry?.object !== 'database') || typeof entry.id !== 'string') continue;
        const uri = pageUrl(entry.url);
        items.push({
          id: entry.id, type: entry.object,
          title: titleOf(entry) || (entry.object === 'database' ? 'Notion 数据库' : 'Notion 页面'),
          ...(uri ? {uri} : {}),
        });
      }
      return {items, truncated: Boolean(body?.has_more)};
    };

    const blockLines = async pageId => {
      const lines = [];
      let cursor;
      for (let page = 0; page < 2; page++) {
        const query = new URLSearchParams({page_size: '100', ...(cursor ? {start_cursor: cursor} : {})});
        const body = await api('GET', '/v1/blocks/' + encodeURIComponent(pageId) + '/children?' + query.toString());
        for (const block of Array.isArray(body?.results) ? body.results : []) {
          const line = blockText(block);
          if (line) lines.push(line);
          if (lines.length >= MAX_BLOCKS) return lines;
        }
        cursor = body?.has_more === true && typeof body.next_cursor === 'string' ? body.next_cursor : undefined;
        if (!cursor) return lines;
      }
      return lines;
    };

    const pageItem = async item => {
      const page = await api('GET', '/v1/pages/' + encodeURIComponent(item.id));
      if (!page || page.object !== 'page' || page.id !== item.id) throw new NotionError('notion_response_invalid', 502);
      const lines = await blockLines(item.id);
      const title = titleOf(page) || text(item.title) || 'Notion 页面';
      const content = lines.join('\n').slice(0, MAX_TEXT);
      const uri = pageUrl(page.url) ?? item.uri;
      const modifiedAt = typeof page.last_edited_time === 'string' ? page.last_edited_time : undefined;
      const revision = hash(JSON.stringify({id: page.id, title, content, uri, modifiedAt}));
      return {
        externalId: page.id, revision, observedAt: now(),
        ...(modifiedAt ? {modifiedAt} : {}),
        title: title.slice(0, 2000), text: content, kind: 'file', layer: 'snapshot', mimeType: 'text/markdown',
        ...(uri ? {uri} : {}),
        metadata: {version: 1, provider: {updatedAt: modifiedAt ?? now()}},
      };
    };

    const databaseItems = async item => {
      const body = await api('POST', '/v1/databases/' + encodeURIComponent(item.id) + '/query', {
        page_size: MAX_DATABASE_ENTRIES,
        sorts: [{timestamp: 'last_edited_time', direction: 'descending'}],
      });
      const entries = [];
      for (const entry of (Array.isArray(body?.results) ? body.results : []).slice(0, MAX_DATABASE_ENTRIES)) {
        if (entry?.object !== 'page' || typeof entry.id !== 'string') continue;
        const title = titleOf(entry) || 'Notion 条目';
        const content = propertiesText(entry.properties).slice(0, MAX_TEXT);
        const uri = pageUrl(entry.url);
        const modifiedAt = typeof entry.last_edited_time === 'string' ? entry.last_edited_time : undefined;
        const revision = hash(JSON.stringify({id: entry.id, title, content, uri, modifiedAt}));
        entries.push({
          externalId: entry.id, revision, observedAt: now(),
          ...(modifiedAt ? {modifiedAt} : {}),
          title: title.slice(0, 2000), text: content, kind: 'file', layer: 'snapshot', mimeType: 'text/markdown',
          ...(uri ? {uri} : {}),
          metadata: {version: 1, provider: {updatedAt: modifiedAt ?? now()}},
        });
      }
      return entries;
    };

    const performSync = async () => {
      if (!configured()) throw new NotionError('notion_not_configured', 503);
      if (!doc.token?.accessToken) throw new NotionError('notion_not_connected', 401);
      if (!doc.selected.length) throw new NotionError('notion_selection_required', 409);
      state = 'syncing';
      code = undefined;
      let imported = 0, duplicates = 0, pages = 0, databases = 0;
      try {
        ensureSources();
        for (const item of doc.selected) {
          if (closed) throw new NotionError('connector_closed', 503);
          const id = sourceId(item.id);
          let source;
          try {
            source = ctx.sources.getSource(id);
          } catch {
            continue;
          }
          if (!source.enabled) continue;
          ctx.sources.reportStatus(id, {state: 'syncing'});
          const entries = item.type === 'database' ? await databaseItems(item) : [await pageItem(item)];
          if (item.type === 'database') databases++;
          else pages++;
          for (const entry of entries) {
            if (closed) throw new NotionError('connector_closed', 503);
            const result = await ctx.sources.upsert(id, entry);
            result.duplicate ? duplicates++ : imported++;
          }
          ctx.sources.reportStatus(id, {state: 'idle', lastSyncAt: now()});
        }
        doc.lastSyncAt = now();
        await persist();
        state = 'idle';
        return {imported, duplicates, pages, databases, selected: doc.selected.length};
      } catch (error) {
        const failure = error instanceof NotionError ? error : new NotionError('notion_sync_failed', 502);
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
      if (closed) return Promise.reject(new NotionError('connector_closed', 503));
      if (running) return running;
      running = run(performSync).finally(() => {
        running = undefined;
      });
      return running;
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
        if (!configured()) throw new NotionError('notion_not_configured', 503);
        for (const [key, entry] of pending) if (entry.expires < Date.now()) pending.delete(key);
        const oauthState = 'notion.' + randomBytes(32).toString('base64url');
        pending.set(oauthState, {expires: Date.now() + 600000});
        const url = new URL(AUTHORIZE_URL);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('owner', 'user');
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('state', oauthState);
        return {authorizationUrl: url.toString(), expiresIn: 600, readOnly: true};
      },
      callback(stateValue, authorizationCode) {
        const entry = pending.get(stateValue);
        pending.delete(stateValue);
        if (!entry || entry.expires < Date.now()) return Promise.reject(new NotionError('notion_state_invalid', 400));
        return run(async () => {
          const token = await tokenRequest(authorizationCode);
          if (closed) throw new NotionError('connector_closed', 503);
          disableSelected();
          doc = {
            version: 1,
            token: {
              accessToken: token.access_token,
              ...(typeof token.workspace_id === 'string' ? {workspaceId: token.workspace_id} : {}),
              ...(typeof token.workspace_name === 'string' ? {workspaceName: token.workspace_name} : {}),
              ...(typeof token.bot_id === 'string' ? {botId: token.bot_id} : {}),
              connectedAt: now(),
            },
            selected: [],
          };
          await persist();
          state = 'idle';
          code = undefined;
          schedule();
          return status();
        });
      },
      candidates() {
        return run(listCandidates);
      },
      select(raw) {
        const selection = parseSelection(raw);
        return run(async () => {
          const candidates = await listCandidates();
          const available = new Map(candidates.items.map(item => [item.id, item]));
          const chosen = selection.map(item => {
            const match = available.get(item.id);
            if (!match || match.type !== item.type) throw new NotionError('notion_selection_invalid', 404);
            return {id: match.id, type: match.type, title: match.title, ...(match.uri ? {uri: match.uri} : {})};
          });
          const keep = new Set(chosen.map(item => item.id));
          for (const prior of doc.selected) {
            if (keep.has(prior.id)) continue;
            try {
              ctx.sources.update(sourceId(prior.id), {enabled: false});
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
      configure(host) {
        host.ownerRoute({method: 'GET', path: '/api/connectors/notion', handler: status});
        host.ownerRoute({method: 'POST', path: '/api/connectors/notion/start', handler: () => instance.start()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/notion/candidates', handler: () => instance.candidates()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/notion/select', handler: request => instance.select(request.body)});
        host.ownerRoute({method: 'POST', path: '/api/connectors/notion/sync', handler: () => instance.sync()});
        host.ownerRoute({method: 'POST', path: '/api/connectors/notion/disconnect', handler: () => instance.disconnect()});
        host.oauthCallback({
          path: '/oauth/notion/callback',
          statePrefix: 'notion.',
          complete: (stateValue, authorizationCode) => instance.callback(stateValue, authorizationCode),
          successMessage: 'Notion 已连接。请回到来源，选择要归档的页面或数据库。',
          failureMessage: 'Notion 授权未完成。请回到来源重试。',
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
