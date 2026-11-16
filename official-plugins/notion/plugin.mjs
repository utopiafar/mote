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
const SCAN_PREFIX = 'notion.scan.';
const MAX_SELECTED = 50;
const MAX_BLOCKS = 200;
const MAX_DATABASE_ENTRIES = 100;
const MAX_TEXT = 100000;
// A continuation contains positions, never provider responses or document text.
const MAX_DEPTH = 32;
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
  let partial = Object.keys(properties ?? {}).length > 50;
  for (const [name, property] of Object.entries(properties ?? {}).slice(0, 50)) {
    const original = propertyValue(property).trim(), value = original.slice(0, 500);
    if (original.length > 500 || property?.has_more === true) partial = true;
    if (value) lines.push(name + ': ' + value);
    if (lines.length >= 100) break;
  }
  const joined = lines.join('\n');
  return {content: joined.slice(0, 20000), partial: partial || joined.length > 20000};
}

function blockText(block) {
  const type = text(block?.type);
  const value = block?.[type];
  if (type === 'child_page' || type === 'child_database') return text(value?.title);
  if (type === 'table_row') return (Array.isArray(value?.cells) ? value.cells : []).map(richText).join(' | ');
  if (type === 'equation') return text(value?.expression);
  if (['bookmark', 'embed', 'link_preview'].includes(type)) return [text(value?.url), richText(value?.caption)].filter(Boolean).join('\n');
  const content = richText(value?.rich_text).trim();
  if (!content) return '';
  const prefix = {
    heading_1: '# ', heading_2: '## ', heading_3: '### ',
    bulleted_list_item: '- ', numbered_list_item: '1. ', to_do: '- [ ] ', quote: '> ',
  }[type] ?? '';
  return prefix + content;
}

const supportedBlock = block => Array.isArray(block?.[block.type]?.rich_text) || ['divider', 'breadcrumb', 'table_of_contents', 'table', 'table_row', 'column_list', 'column', 'equation', 'bookmark', 'embed', 'link_preview'].includes(block.type) || block.type === 'synced_block' && block.has_children;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const prefixOf = content => ({length: content.length, hash: hash(content)});
const snapshot = item => {
  const {captureId, sourceId, receivedAt, current, ...entry} = item;
  return {...entry, observedAt: now()};
};

function stableContent(value) {
  if (Array.isArray(value)) return value.map(stableContent);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => {
    let child = value[key];
    // Notion-hosted file access URLs expire and refresh without an edit. Keep
    // file names/captions/upload IDs and external URLs as content identities.
    if (key === 'file' && value.type === 'file' && child && typeof child === 'object' && !Array.isArray(child)) {
      const {url, expiry_time, ...content} = child;
      child = content;
    }
    return [key, stableContent(child)];
  }));
}

const continuationHash = (response, blocks) => hash(JSON.stringify(stableContent({
  has_more: response.has_more, next_cursor: response.has_more ? response.next_cursor : null,
  results: response.results.map(entry => ({
    object: entry.object, id: entry.id, created_time: entry.created_time, last_edited_time: entry.last_edited_time,
    parent: entry.parent, archived: entry.archived === true, in_trash: entry.in_trash === true,
    ...(blocks ? {type: entry.type, has_children: entry.has_children === true, content: entry[entry.type]} :
      {url: pageUrl(entry.url), properties: entry.properties, icon: entry.icon, cover: entry.cover}),
  })),
})));

function parseSelection(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  if (!Array.isArray(input.selected) || input.selected.length > MAX_SELECTED) throw new NotionError('notion_input_invalid', 400);
  const selected = [], identities = new Set();
  for (const value of input.selected) {
    const id = text(value?.id), type = text(value?.type);
    if (!id || id.length > 200 || (type !== 'page' && type !== 'database') || identities.has(id)) throw new NotionError('notion_input_invalid', 400);
    identities.add(id);
    if (value.initialSync !== undefined && !['all', 'new_only'].includes(value.initialSync)) throw new NotionError('notion_input_invalid', 400);
    selected.push({id, type, ...(value.initialSync !== undefined ? {initialSync: value.initialSync} : {})});
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
      // Upstream workspace/integration identity, never a Mote account or token.
      ...(doc.token?.workspaceId ? {accountId: hash(JSON.stringify([doc.token.workspaceId, doc.token.botId ?? '']))} : doc.token?.connectedAt ? {connectionGeneration: hash(doc.token.connectedAt)} : {}),
      selected: doc.selected.map(item => {
        let source;
        try { source = ctx.sources.getSource(sourceId(item.id)); } catch { /* No source exists until selection. */ }
        return {id: item.id, type: item.type, title: item.title ?? '', sourceId: sourceId(item.id), initialSync: source?.initialSync ?? 'all', ...(source?.status?.coverage ? {coverage: source.status.coverage} : {})};
      }),
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
      const slots = new Set();
      doc = {...value, selected: value.selected.map((item, index) => {
        const slot = item.slot ?? index;
        if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SELECTED || slots.has(slot)) throw new NotionError('notion_state_invalid', 503);
        slots.add(slot);
        return {...item, slot, selection: item.selection ?? hash(JSON.stringify([value.token?.connectedAt, item.id, item.type]))};
      })};
      docRevision = record.revision;
    };

    const disableSelected = () => {
      for (const item of doc.selected) {
        try {
          ctx.sources.update(sourceId(item.id), {enabled: false});
        } catch { /* A missing historical source is already stopped. */ }
      }
    };

    const ensureSources = (enableSelected = false) => {
      for (const item of doc.selected) {
        const id = sourceId(item.id);
        ctx.sources.register({
          id, name: sourceName(item), kind: SOURCE_KIND, deviceId: DEVICE_ID,
          platform: 'import', retention: 'snapshot', enabled: true,
        });
        ctx.sources.update(id, {name: sourceName(item), ...(enableSelected ? {enabled: true} : {})});
      }
    };

    const coverage = scan => ({
      state: scan.complete && !scan.contentPartial && scan.failed === 0 ? 'complete' : 'partial',
      window: scan.window, processed: scan.processed,
      remaining: scan.complete && !scan.contentPartial && scan.failed === 0 ? 0 : null,
      failed: scan.failed,
      limitations: [...(!scan.complete && scan.type === 'database' ? ['pagination_pending'] : []), ...(scan.contentPartial || !scan.complete ? ['content_partial'] : [])],
      updatedAt: now(),
    });
    const scanPin = (item, source) => {
      const token = doc.token, selection = item.selection;
      const condition = {sourceId: source.id, syncScopeVersion: source.syncScopeVersion ?? 0};
      const current = () => {
        if (closed || doc.token !== token || !doc.selected.some(value => value.id === item.id && value.type === item.type && value.selection === selection)) throw new NotionError('notion_scope_changed', 409);
        try { ctx.sources.assertSyncScope(source.id, condition.syncScopeVersion); } catch { throw new NotionError('notion_scope_changed', 409); }
      };
      return {condition, current};
    };
    const saveScan = async (record, scan, pin) => {
      pin.current();
      if (Buffer.byteLength(JSON.stringify(scan)) > 60000) throw new NotionError('notion_traversal_limit', 413);
      const saved = await ctx.state.compareAndSet(record.key, record.revision || null, scan, pin.condition);
      pin.current();
      return {key: record.key, revision: saved.revision, scan};
    };
    const scanFor = async (item, source, pin) => {
      const key = SCAN_PREFIX + item.slot, record = await ctx.state.get(key);
      pin.current();
      const mode = source.initialSync ?? 'all';
      const scope = hash(JSON.stringify([doc.token?.workspaceId, doc.token?.botId, doc.token?.connectedAt, item.id, item.type, item.selection, mode, pin.condition.syncScopeVersion]));
      let scan = record?.value;
      const same = scan?.version === 1 && scan.id === item.id && scan.type === item.type && scan.mode === mode && scan.scope === scope;
      if (same) {
        if (mode === 'new_only' && (typeof scan.baselineAt !== 'string' || !Number.isFinite(Date.parse(scan.baselineAt))) || scan.pageBaseline !== undefined && (typeof scan.pageBaseline !== 'string' || !Number.isFinite(Date.parse(scan.pageBaseline))) || !scan.window || !Number.isFinite(Date.parse(scan.window.to)) || scan.window.from && (!Number.isFinite(Date.parse(scan.window.from)) || Date.parse(scan.window.from) > Date.parse(scan.window.to)) || !Number.isSafeInteger(scan.processed) || scan.processed < 0 || !Number.isSafeInteger(scan.failed) || scan.failed < 0 || typeof scan.complete !== 'boolean' || typeof scan.contentPartial !== 'boolean' || scan.cursor !== undefined && (typeof scan.cursor !== 'string' || !scan.cursor || scan.cursor.length > 2048)) throw new NotionError('notion_state_invalid', 503);
        if (scan.bodyFormat !== 1) {
          // The properties-only collector did not retain a body position. Its
          // completed row enumeration cannot advance past unread historical
          // bodies. Rebuild that position within the existing authorization and
          // anchor, retaining new-only's original admission baseline.
          scan = {...scan, bodyFormat: 1, window: {to: scan.window.to}, processed: 0, failed: 0, complete: false, contentPartial: false};
          delete scan.cursor;
          return saveScan({key, revision: record.revision}, scan, pin);
        }
        if (scan.rowIndex !== undefined && (!Number.isInteger(scan.rowIndex) || scan.rowIndex < 0 || scan.rowIndex > MAX_DATABASE_ENTRIES) || scan.body && (!validId(scan.body.id) || !validTime(scan.body.modifiedAt) || !Number.isSafeInteger(scan.body.prefix?.length) || scan.body.prefix.length < 0 || !/^[a-f0-9]{64}$/.test(scan.body.prefix.hash) || !Array.isArray(scan.body.stack) || scan.body.stack.length > MAX_DEPTH || scan.body.stack.some(frame => !validId(frame.id) || !Number.isInteger(frame.index) || frame.index < 0 || frame.index > 100 || frame.cursor !== undefined && (typeof frame.cursor !== 'string' || !frame.cursor || frame.cursor.length > 2048) || frame.textOffset !== undefined && (!Number.isSafeInteger(frame.textOffset) || frame.textOffset < 0)))) throw new NotionError('notion_state_invalid', 503);
        if (!scan.complete) return {key, revision: record.revision, scan};
      }
      const to = now();
      scan = {version: 1, bodyFormat: 1, id: item.id, type: item.type, scope, mode,
        window: {...(same ? {from: scan.window.to} : mode === 'new_only' ? {from: to} : {}), to},
        processed: 0, failed: 0, complete: false, contentPartial: false,
        ...(mode === 'new_only' ? {baselineAt: same ? scan.baselineAt : to, ...(same && scan.pageBaseline ? {pageBaseline: scan.pageBaseline} : {})} : {}),
      };
      return saveScan({key, revision: record?.revision ?? 0}, scan, pin);
    };
    const withinWindow = (entry, scan) => {
      if (typeof entry.last_edited_time !== 'string' || !Number.isFinite(Date.parse(entry.last_edited_time))) throw new NotionError('notion_response_invalid', 502);
      const at = Date.parse(entry.last_edited_time);
      return at <= Date.parse(scan.window.to) && (!scan.window.from || at >= Date.parse(scan.window.from));
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
        if (result.response.status === 400 && (body?.start_cursor || new URL(API_ROOT + path).searchParams.has('start_cursor'))) throw new NotionError('notion_cursor_invalid', 409);
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

    const pageMetadata = async id => {
      const page = await api('GET', '/v1/pages/' + encodeURIComponent(id));
      if (page?.object !== 'page' || page.id !== id || !validTime(page.last_edited_time)) throw new NotionError('notion_response_invalid', 502);
      return page;
    };

    // Brent's cycle check needs constant space even for an arbitrarily long
    // provider cursor chain. A cycle is a failed read, never completed coverage.
    const advanceCursor = (position, cursor) => {
      if (typeof cursor !== 'string' || !cursor || cursor.length > 2048 || cursor === position.cursor || cursor === position.anchor) throw new NotionError('notion_response_invalid', 502);
      position.span = (position.span ?? 0) + 1;
      position.power ??= 1;
      if (position.span === position.power) {
        position.anchor = cursor;
        position.power *= 2;
        position.span = 0;
      }
      position.cursor = cursor;
    };

    const pageItem = async (item, scan, source, budget) => {
      const page = await pageMetadata(item.id), modifiedAt = page.last_edited_time;
      if (Date.parse(modifiedAt) > Date.parse(scan.window.to)) return {done: true, partial: true};
      const head = ctx.sources.getItem(source.id, item.id);
      if (scan.mode === 'new_only' && !head) {
        if (item.type === 'page') {
          if (!scan.pageBaseline) return {done: true, pageBaseline: modifiedAt};
          if (scan.pageBaseline === modifiedAt) return {done: true};
        } else {
          if (!validTime(page.created_time)) throw new NotionError('notion_response_invalid', 502);
          if (Date.parse(page.created_time) <= Date.parse(scan.baselineAt)) return {done: true};
        }
      }
      let body = scan.body?.id === item.id ? structuredClone(scan.body) : undefined;
      if (body && body.modifiedAt !== modifiedAt) body = undefined;
      const prior = head?.document?.originalMetadata?.notion;
      if (!body && head?.modifiedAt === modifiedAt && prior?.finished === true && prior.bodyRevision === modifiedAt && head.document?.bodyCoverage) {
        return {entry: snapshot(head), done: true, partial: head.document.bodyCoverage.state === 'partial'};
      }
      let content;
      if (body) {
        content = head?.text.slice(0, body.prefix.length);
        if (head?.modifiedAt !== modifiedAt || content === undefined || content.length !== body.prefix.length || hash(content) !== body.prefix.hash) throw new NotionError('notion_prefix_unavailable', 409);
      } else {
        const properties = propertiesText(page.properties);
        content = properties.content;
        if (content.length > budget.text) return {done: false};
        budget.text -= content.length;
        body = {id: item.id, modifiedAt, prefix: prefixOf(content), stack: [{id: item.id, index: 0}],
          partial: properties.partial};
      }
      const cache = new Map(), seen = new Set();
      while (body.stack.length && budget.blocks > 0 && budget.text > 0) {
        const frame = body.stack.at(-1), key = JSON.stringify([frame.id, frame.cursor]);
        let response = cache.get(key);
        if (!response) {
          const query = new URLSearchParams({page_size: '100', ...(frame.cursor ? {start_cursor: frame.cursor} : {})});
          response = await api('GET', '/v1/blocks/' + encodeURIComponent(frame.id) + '/children?' + query.toString());
          if (!Array.isArray(response?.results) || response.results.length > 100 || typeof response.has_more !== 'boolean' || response.has_more && !response.results.length) throw new NotionError('notion_response_invalid', 502);
          const identities = new Set();
          for (const block of response.results) {
            if (!validId(block?.id) || identities.has(block.id) || block.parent?.block_id && block.parent.block_id !== frame.id || block.parent?.page_id && block.parent.page_id !== item.id) throw new NotionError('notion_response_invalid', 502);
            identities.add(block.id);
          }
          const pageHash = continuationHash(response, true);
          if (frame.pageHash && frame.pageHash !== pageHash) throw new NotionError('notion_page_changed', 409);
          if (!frame.pageHash && frame.previousHash === pageHash) throw new NotionError('notion_response_invalid', 502);
          frame.pageHash = pageHash;
          cache.set(key, response);
          if (cache.size > 2) cache.delete(cache.keys().next().value);
        }
        if (frame.index >= response.results.length) {
          if (response.has_more) {
            advanceCursor(frame, response.next_cursor);
            frame.previousHash = frame.pageHash;
            delete frame.pageHash;
            frame.index = 0;
          } else body.stack.pop();
          continue;
        }
        const block = response.results[frame.index];
        if (body.stack.some(parent => parent.id === block.id) || !frame.textOffset && seen.has(block.id)) throw new NotionError('notion_response_invalid', 502);
        seen.add(block.id);
        budget.blocks--;
        const line = blockText(block);
        frame.separator ??= Boolean(content && line);
        const segment = (frame.separator ? '\n' : '') + line, offset = frame.textOffset ?? 0;
        if (offset > segment.length) throw new NotionError('notion_page_changed', 409);
        let end = Math.min(segment.length, offset + budget.text);
        if (end < segment.length && /[\uD800-\uDBFF]/.test(segment[end - 1]) && /[\uDC00-\uDFFF]/.test(segment[end])) end--;
        const addition = segment.slice(offset, end);
        content += addition;
        budget.text -= addition.length;
        if (end < segment.length) {frame.textOffset = end;break;}
        frame.index++;
        delete frame.textOffset;
        delete frame.separator;
        if (!supportedBlock(block)) body.partial = true;
        if (block.has_children && !['child_page', 'child_database'].includes(block.type)) {
          if (body.stack.length >= MAX_DEPTH) throw new NotionError('notion_traversal_limit', 413);
          body.stack.push({id: block.id, index: 0});
        }
      }
      // Pop exhausted pages without reading another block after the budget.
      while (body.stack.length) {
        const frame = body.stack.at(-1), response = cache.get(JSON.stringify([frame.id, frame.cursor]));
        if (!response || frame.index < response.results.length || response.has_more) break;
        body.stack.pop();
      }
      const confirmed = await pageMetadata(item.id);
      if (confirmed.last_edited_time !== modifiedAt) throw new NotionError('notion_page_changed', 409);
      const done = body.stack.length === 0, title = titleOf(page) || text(item.title) || 'Notion 页面', uri = pageUrl(page.url) ?? item.uri;
      body.prefix = prefixOf(content);
      const document = {bodyCoverage: done && !body.partial ? {state: 'complete'} : {state: 'partial', reason: done ? 'unsupported_content' : 'pagination_pending'},
        originalMetadata: {notion: {bodyRevision: modifiedAt, finished: done}}};
      const semantic = {id: item.id, title, content, uri, modifiedAt, document};
      return {entry: {externalId: item.id, revision: hash(JSON.stringify(semantic)), observedAt: now(), modifiedAt,
        title: title.slice(0, 2000), text: content, kind: 'file', layer: 'snapshot', mimeType: 'text/markdown',
        ...(uri ? {uri} : {}), metadata: {version: 1, provider: {updatedAt: modifiedAt}}, document},
        done, partial: body.partial, ...(!done ? {body} : {})};
    };

    const databaseItems = async (item, scan, source, budget) => {
      const filters = [{timestamp: 'last_edited_time', last_edited_time: {on_or_before: scan.window.to}}];
      if (scan.window.from) filters.push({timestamp: 'last_edited_time', last_edited_time: {on_or_after: scan.window.from}});
      const response = await api('POST', '/v1/databases/' + encodeURIComponent(item.id) + '/query', {
        page_size: MAX_DATABASE_ENTRIES, ...(scan.cursor ? {start_cursor: scan.cursor} : {}),
        sorts: [{timestamp: 'last_edited_time', direction: 'descending'}], filter: {and: filters},
      });
      if (!Array.isArray(response?.results) || response.results.length > MAX_DATABASE_ENTRIES || typeof response.has_more !== 'boolean' || response.has_more && !response.results.length) throw new NotionError('notion_response_invalid', 502);
      const identities = new Set();
      for (const entry of response.results) {
        if (entry?.object !== 'page' || !validId(entry.id) || identities.has(entry.id)) throw new NotionError('notion_response_invalid', 502);
        identities.add(entry.id);
      }
      const pageHash = continuationHash(response, false);
      if (scan.pageHash && scan.pageHash !== pageHash) throw new NotionError('notion_page_changed', 409);
      const next = structuredClone(scan), entries = [];
      let index = scan.rowIndex ?? 0, processed = 0;
      for (; index < response.results.length && budget.blocks > 0 && budget.text > 0; index++) {
        const row = response.results[index];
        if (!withinWindow(row, scan)) continue;
        if (scan.mode === 'new_only' && !ctx.sources.getItem(source.id, row.id)) {
          if (!validTime(row.created_time)) throw new NotionError('notion_response_invalid', 502);
          if (Date.parse(row.created_time) <= Date.parse(scan.baselineAt)) continue;
        }
        const result = await pageItem({...row, type: 'database'}, next, source, budget);
        if (result.entry) entries.push(result.entry);
        if (!result.done) {if (result.body) next.body = result.body;break;}
        delete next.body;
        if (result.entry) processed++;
        next.contentPartial ||= Boolean(result.partial);
      }
      next.processed += processed;
      if (index < response.results.length) {
        next.rowIndex = index;
        next.pageHash = pageHash;
      } else {
        delete next.rowIndex;
        delete next.pageHash;
        if (response.has_more) advanceCursor(next, response.next_cursor);
        else {delete next.cursor;next.complete = true;}
      }
      return {entries, scan: next};
    };

    const performSync = async () => {
      if (!configured()) throw new NotionError('notion_not_configured', 503);
      if (!doc.token?.accessToken) throw new NotionError('notion_not_connected', 401);
      if (!doc.selected.length) throw new NotionError('notion_selection_required', 409);
      state = 'syncing';
      code = undefined;
      let imported = 0, duplicates = 0, pages = 0, databases = 0, active;
      try {
        ensureSources();
        for (const item of doc.selected) {
          if (closed) throw new NotionError('connector_closed', 503);
          const id = sourceId(item.id), source = ctx.sources.getSource(id);
          if (!source.enabled) continue;
          active = {id, pin: scanPin(item, source)};
          active.record = await scanFor(item, source, active.pin);
          active.pin.current();
          ctx.sources.reportStatus(id, {state: 'syncing', coverage: coverage(active.record.scan)}, active.pin.condition.syncScopeVersion);
          const budget = {blocks: MAX_BLOCKS, text: MAX_TEXT};
          let batch;
          if (item.type === 'database') batch = await databaseItems(item, active.record.scan, source, budget);
          else {
            const result = await pageItem(item, active.record.scan, source, budget), scan = {...active.record.scan,
              processed: active.record.scan.processed + (result.done && result.entry ? 1 : 0),
              complete: result.done, contentPartial: Boolean(result.partial),
              ...(result.pageBaseline ? {pageBaseline: result.pageBaseline} : {}),
            };
            if (result.body) scan.body = result.body; else delete scan.body;
            batch = {entries: result.entry ? [result.entry] : [], scan};
          }
          active.pin.current();
          if (item.type === 'database') databases++; else pages++;
          for (const entry of batch.entries) {
            if (closed) throw new NotionError('connector_closed', 503);
            const result = await ctx.sources.upsert(id, entry, active.pin.current);
            active.pin.current();
            result.duplicate ? duplicates++ : imported++;
          }
          // The entire bounded page commits before its continuation advances.
          // A crash before CAS replays that page; successful replay counts it
          // once, independent of duplicate archive acknowledgements.
          const scan = {...batch.scan, failed: 0};
          if (closed) throw new NotionError('connector_closed', 503);
          active.record = await saveScan(active.record, scan, active.pin);
          if (closed) throw new NotionError('connector_closed', 503);
          ctx.sources.reportStatus(id, {state: 'idle', lastSyncAt: now(), coverage: coverage(scan)}, active.pin.condition.syncScopeVersion);
          active = undefined;
        }
        doc.lastSyncAt = now();
        await persist();
        state = 'idle';
        return {imported, duplicates, pages, databases, selected: doc.selected.length};
      } catch (error) {
        const stale = () => {if (!active) return false;try { active.pin.current();return false; } catch { return true; }};
        const rejectStale = () => {state = 'idle';code = 'notion_scope_changed';throw new NotionError(code, 409);};
        if (stale()) rejectStale();
        const failure = error instanceof NotionError ? error : new NotionError('notion_sync_failed', 502);
        state = [401, 403].includes(failure.statusCode) ? 'permission_required' : 'error';
        code = failure.code;
        if (!closed && active?.record) {
          let scan = {...active.record.scan, failed: 1};
          if (['notion_cursor_invalid', 'notion_page_changed', 'notion_prefix_unavailable'].includes(code)) {
            scan = {...scan, processed: 0, complete: false, contentPartial: scan.contentPartial || code === 'notion_page_changed'};
            for (const key of ['cursor', 'rowIndex', 'pageHash', 'body', 'anchor', 'power', 'span']) delete scan[key];
          }
          try { active.record = await saveScan(active.record, scan, active.pin); } catch { if (stale()) rejectStale(); }
          if (stale()) rejectStale();
          // The host checks the pin inside the status transaction as well. A
          // failed old request cannot restore coverage for a newer owner range.
          try { ctx.sources.reportStatus(active.id, {state, code, coverage: coverage(scan)}, active.pin.condition.syncScopeVersion); } catch { if (stale()) rejectStale(); }
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
          const retained = new Map(doc.selected.filter(item => selection.some(value => value.id === item.id && value.type === item.type)).map(item => [item.id, item]));
          const used = new Set([...retained.values()].map(item => item.slot));
          const chosen = selection.map(item => {
            const match = available.get(item.id);
            if (!match || match.type !== item.type) throw new NotionError('notion_selection_invalid', 404);
            const prior = retained.get(item.id), slot = prior?.slot ?? Array.from({length: MAX_SELECTED}, (_, index) => index).find(index => !used.has(index));
            used.add(slot);
            return {id: match.id, type: match.type, title: match.title.slice(0, 200), ...(match.uri && match.uri.length <= 500 ? {uri: match.uri} : {}), slot, selection: prior?.selection ?? randomBytes(16).toString('hex')};
          });
          // Set every explicitly requested history policy before confirming or
          // enabling a new selection. Each staged policy remains paused until selection is saved;
          // an omitted policy preserves the existing caller's current strategy.
          for (const request of selection) if (request.initialSync !== undefined) {
            const item = chosen.find(value => value.id === request.id), id = sourceId(item.id);
            ctx.sources.register({id, name: sourceName(item), kind: SOURCE_KIND, deviceId: DEVICE_ID, platform: 'import', retention: 'snapshot', enabled: false, initialSync: request.initialSync});
            ctx.sources.update(id, {enabled: false, initialSync: request.initialSync});
          }
          const keep = new Set(chosen.map(item => item.id));
          for (const prior of doc.selected) {
            if (keep.has(prior.id)) continue;
            try {
              ctx.sources.update(sourceId(prior.id), {enabled: false});
            } catch { /* A removed historical source is already stopped. */ }
          }
          const previous = doc;
          doc = {...doc, selected: chosen};
          try { await persist(); } catch (error) { doc = previous; throw error; }
          ensureSources(true);
          for (const item of chosen) if (!retained.has(item.id)) {
            ctx.sources.resetCoverage(sourceId(item.id));
            const key = SCAN_PREFIX + item.slot, previous = await ctx.state.get(key);
            if (previous) await ctx.state.compareAndSet(key, previous.revision, null);
          }
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
