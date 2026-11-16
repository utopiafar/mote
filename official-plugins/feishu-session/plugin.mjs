import {createHash, randomUUID} from 'node:crypto';

/** Official Feishu (Lark) IM archive connector. It attaches a new source kind
 * to the existing Feishu account binding supplied by the Central host. Archive
 * authorization is read-only; sending needs a second authorization and runs
 * only through a host-dispatched, owner-confirmed message.send action. */
export const sdkVersion = '0.1.0';

const SOURCE_KIND = 'mote.official.feishu-session';
const DEVICE_ID = 'official-feishu-session';
const STATE_KEY = 'feishu-session';
const DEFAULT_INTERVAL = 900000;
const MAX_SELECTED = 100;
const MAX_CANDIDATES = 500;
const MAX_PAGES = 20;
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
const stable = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const text = value => typeof value === 'string' ? value : '';
const cleanName = value => text(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
const statusOf = error => Number.isInteger(error?.statusCode) ? error.statusCode : 502;
const errorCode = error => typeof error?.code === 'string' ? error.code : 'feishu_session_operation_failed';
const protocolId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
const milliseconds = value => {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) throw new FeishuSessionError('feishu_session_time_unavailable', 502);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || !Number.isFinite(new Date(number).getTime())) throw new FeishuSessionError('feishu_session_time_unavailable', 502);
  return number;
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
    if (!protocolId(id) || !['group', 'p2p'].includes(type) || identities.has(id)) throw new FeishuSessionError('feishu_session_input_invalid', 400);
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

function messageBody(message) {
  if (message?.deleted === true) return {text: '', bodyCoverage: {state: 'complete'}};
  const raw = text(message?.body?.content);
  if (typeof message?.body?.content !== 'string') throw new FeishuSessionError('feishu_session_content_unavailable', 502);
  const content = parsedContent(raw);
  if (message.msg_type === 'text' && typeof content?.text === 'string') return {text: content.text, bodyCoverage: {state: 'complete'}};
  // Retain the actual available protocol body, without silently replacing it
  // by a placeholder, truncating it or treating unread media as full text.
  return {text: raw, bodyCoverage: {state: 'partial', reason: 'unsupported_content'}};
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
    if (!binding || typeof binding.status !== 'function' || typeof binding.captureRead !== 'function' || typeof binding.onReadInvalidated !== 'function') throw Error('The Central host did not provide the lark account binding');

    let doc = {version: 1, selected: [], archiveAuthorized: false, sendAuthorized: false};
    let docRevision = 0;
    let initialized = false, closed = false, running, sequence = Promise.resolve();
    const configuredInterval = Number(ctx.config?.connectors?.syncIntervalMs);
    let state = 'idle', code, intervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0 ? Math.max(60000, configuredInterval) : DEFAULT_INTERVAL, timer;
    let snapshot = {installed: false, configured: false, connected: false, scopes: []};
    let job, controller, active;
    let selectionGeneration = 0;
    const lifetime = new AbortController();
    const readWatches = new Map();
    const releaseReadWatches = () => {for (const release of readWatches.values()) release();readWatches.clear();};

    const sourceId = id => 'feishu-session-' + hash(JSON.stringify([doc.accountId, id])).slice(0, 24);
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
      releaseReadWatches();
      for (const item of doc.selected ?? []) {
        try {
          ctx.sources.resetCoverage(sourceId(item.id));
          ctx.sources.update(sourceId(item.id), {enabled: false});
        } catch { /* A missing historical source is already stopped. */ }
      }
    };

    const watchReadSource = item => {
      if (!doc.archiveAuthorized || !doc.accountId) return;
      const id = sourceId(item.id);
      if (readWatches.has(id)) return;
      let source;
      try { source = ctx.sources.getSource(id); } catch { return; }
      if (source.kind !== SOURCE_KIND || source.deviceId !== DEVICE_ID || source.platform !== 'import') return;
      // A prior confirmed withdrawal already fenced this paused source. A
      // repeated check (including after restart) must not reset it again.
      if (!source.enabled && source.status?.code === 'feishu_session_read_reauthorization_required' && !source.status.coverage) return;
      const accountId = doc.accountId;
      readWatches.set(id, binding.onReadInvalidated({accountId, type: item.type}, () => {
        readWatches.delete(id);
        if (closed || doc.accountId !== accountId || !doc.selected.includes(item)) return;
        // Ordinary pause/resume deliberately preserves a source's range.
        // Confirmed grant loss explicitly withdraws it, fencing admitted
        // CAS and queued upserts even if the owner subsequently re-enables.
        ctx.sources.resetCoverage(id);
        ctx.sources.reportStatus(id, {state: 'permission_required', code: 'feishu_session_read_reauthorization_required'});
        ctx.sources.update(id, {enabled: false});
      }));
    };
    const restoreReadWatches = () => {for (const item of doc.selected) watchReadSource(item);};

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
        watchReadSource(item);
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
      restoreReadWatches();
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
      ensureSources();
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

    const scanPin = (item, source) => {
      const accountId = doc.accountId, generation = selectionGeneration, lease = binding.captureRead({accountId, type: item.type});
      const condition = {sourceId: source.id, syncScopeVersion: source.syncScopeVersion ?? 0};
      const current = () => {
        if (closed || generation !== selectionGeneration || !doc.archiveAuthorized || doc.accountId !== accountId || !doc.selected.includes(item)) throw new FeishuSessionError('feishu_session_scope_changed', 409);
        try { lease(); ctx.sources.assertSyncScope(source.id, condition.syncScopeVersion); }
        catch { throw new FeishuSessionError('feishu_session_scope_changed', 409); }
      };
      return {condition, current};
    };
    const coverage = scan => ({
      state: scan.complete && !scan.contentPartial && !scan.failed ? 'complete' : 'partial',
      window: scan.window, processed: scan.processed,
      remaining: scan.complete && !scan.contentPartial && !scan.failed ? 0 : null,
      failed: scan.failed,
      limitations: [...(!scan.complete ? ['pagination_pending'] : []), ...(scan.contentPartial ? ['content_partial'] : [])],
      updatedAt: now(),
    });
    const position = () => ({token: '', done: [], previous: [], cycle: {anchor: hash(''), power: 1, span: 0}});
    const saveScan = async (current, scan) => {
      current.pin.current();
      const saved = await ctx.state.compareAndSet(current.key, current.revision || null, scan, current.pin.condition);
      current.pin.current();
      current.scan = scan; current.revision = saved.revision;
    };
    const openScan = async (item, source) => {
      const pin = scanPin(item, source), key = 'feishu-session.scan.' + doc.selected.indexOf(item);
      const record = await ctx.state.get(key); pin.current();
      const mode = source.initialSync ?? 'all';
      const range = hash(JSON.stringify([doc.accountId, item.id, item.type, item.firstSyncAt, source.syncPolicyVersion ?? 0]));
      const scopeVersion = pin.condition.syncScopeVersion, scope = hash(JSON.stringify([range, mode, scopeVersion]));
      const old = record?.value, same = old?.version === 1 && old.scope === scope;
      const sameRange = old?.version === 1 && old.range === range && old.mode === mode;
      if (sameRange) {
        const hashes = value => Array.isArray(value) && value.length <= 50 && value.every(entry => typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry));
        const validPosition = value => value && typeof value.token === 'string' && value.token.length <= 2048 && hashes(value.done) && hashes(value.previous) && (!value.signature || /^[a-f0-9]{64}$/.test(value.signature)) && (value.afterMs === undefined || Number.isSafeInteger(value.afterMs)) && value.cycle && /^[a-f0-9]{64}$/.test(value.cycle.anchor) && Number.isSafeInteger(value.cycle.power) && value.cycle.power > 0 && Number.isSafeInteger(value.cycle.span) && value.cycle.span >= 0 && value.cycle.span < value.cycle.power;
        if (!old.window || !Number.isFinite(Date.parse(old.window.to)) || !Number.isSafeInteger(old.processed) || old.processed < 0 || !Number.isSafeInteger(old.failed) || old.failed < 0 || typeof old.complete !== 'boolean' || typeof old.contentPartial !== 'boolean' || !validPosition(old.history) || old.thread && (!validPosition(old.thread) || !protocolId(old.thread.id) || !protocolId(old.thread.root)) || mode === 'new_only' && !Number.isFinite(Date.parse(old.baselineAt))) throw new FeishuSessionError('feishu_session_state_invalid', 503);
      }
      const current = {id: source.id, item, pin, key, revision: record?.revision ?? 0, scan: old, remaining: MAX_PAGES};
      if (same && !old.complete) return current;
      const to = now();
      await saveScan(current, {version: 1, range, scope, scopeVersion, mode, window: {to}, processed: 0, failed: 0, contentPartial: false, complete: false, history: position(),
        ...(sameRange && old.completeThrough ? {completeThrough: old.completeThrough} : {}),
        // The owner policy identifies the approved range independently of
        // read authorization generations. A new lease starts a fresh traversal
        // while retaining this baseline; mode ABA creates a new policy range.
        ...(mode === 'new_only' ? {baselineAt: sameRange ? old.baselineAt : to} : {}),
      });
      return current;
    };
    // Brent's cycle check keeps an opaque cursor chain bounded even when more
    // than a whole round of messages share the same millisecond timestamp.
    const advance = (where, next, batch) => {
      if (!next) return {...position(), afterMs: batch.afterMs};
      if (next === where.token) throw new FeishuSessionError('feishu_session_pagination_invalid', 502);
      let {anchor, power, span} = where.cycle;
      const digest = hash(next);
      if (digest === anchor) throw new FeishuSessionError('feishu_session_pagination_invalid', 502);
      span++;
      if (span === power) {anchor = digest; power *= 2; span = 0;}
      return {token: next, done: [], previous: batch.identities, afterMs: batch.afterMs, cycle: {anchor, power, span}};
    };
    const pageOf = (result, where, item, thread) => {
      if (!Array.isArray(result?.items) || result.items.length > 50 || typeof result.hasMore !== 'boolean' || result.hasMore && (typeof result.pageToken !== 'string' || !result.pageToken || result.pageToken.length > 2048)) throw new FeishuSessionError('feishu_session_pagination_invalid', 502);
      const identities = [], unique = new Set(); let afterMs = where.afterMs ?? 0;
      for (const message of result.items) {
        if (!protocolId(message?.message_id) || message.chat_id !== undefined && message.chat_id !== item.id || thread && message.thread_id && message.thread_id !== thread.id || ['root_id', 'parent_id', 'thread_id'].some(key => message[key] !== undefined && message[key] !== '' && !protocolId(message[key]))) throw new FeishuSessionError('feishu_session_message_invalid', 502);
        const id = hash(message.message_id), created = milliseconds(message.create_time);
        if (unique.has(id) || where.previous.includes(id) || created < afterMs) throw new FeishuSessionError('feishu_session_pagination_invalid', 502);
        unique.add(id); identities.push(id); afterMs = created;
      }
      const signature = hash(JSON.stringify(identities));
      if (where.signature && signature !== where.signature || where.done.some(id => !unique.has(id))) throw new FeishuSessionError('feishu_session_page_changed', 502);
      const batch = {items: result.items, identities, signature, afterMs};
      return {...batch, next: result.hasMore ? result.pageToken : '', following: advance(where, result.hasMore ? result.pageToken : '', batch)};
    };
    const fetchPage = async (current, where, thread) => {
      current.pin.current();
      if (current.remaining <= 0) return undefined;
      current.remaining--;
      const query = thread ? {threadId: thread.id} : {chatId: current.item.id, startTime: '0', endTime: String(Math.floor(Date.parse(current.scan.window.to) / 1000) + 1)};
      const result = await binding.listMessages({...query, pageSize: 50, ...(where.token ? {pageToken: where.token} : {})}, {signal: lifetime.signal, authorize: current.pin.current});
      current.pin.current();
      return pageOf(result, where, current.item, thread);
    };
    const archive = async (current, message, counts, root) => {
      current.pin.current();
      const created = milliseconds(message.create_time);
      if (created > Date.parse(current.scan.window.to) || current.scan.mode === 'new_only' && created <= Date.parse(current.scan.baselineAt) && !ctx.sources.getItem(current.id, message.message_id)) return {processed: 0, partial: false};
      const entry = messageItem(current.item, message, root);
      const ack = await ctx.sources.upsert(current.id, entry, current.pin.current);
      current.pin.current();
      ack.duplicate ? counts.duplicates++ : counts.imported++;
      return {processed: 1, partial: entry.document.bodyCoverage.state === 'partial'};
    };
    const readThread = async (current, counts) => {
      while (current.scan.thread && current.remaining > 0) {
        const thread = current.scan.thread, batch = await fetchPage(current, thread, thread);
        let processed = 0, partial = false, future = false;
        for (const message of batch.items) {
          if (milliseconds(message.create_time) > Date.parse(current.scan.window.to)) {future = true; break;}
          if (thread.done.includes(hash(message.message_id)) || message.message_id === thread.root) continue;
          const archived = await archive(current, message, counts, thread.root);
          processed += archived.processed; partial ||= archived.partial;
        }
        const scan = {...current.scan, processed: current.scan.processed + processed, contentPartial: current.scan.contentPartial || partial, failed: 0};
        if (!batch.next || future) {
          delete scan.thread;
          scan.history = {...scan.history, done: [...scan.history.done, hash(thread.root)]};
        } else scan.thread = {...batch.following, id: thread.id, root: thread.root};
        await saveScan(current, scan);
      }
    };
    const readHistory = async (current, counts) => {
      if (current.scan.thread) await readThread(current, counts);
      while (!current.scan.thread && !current.scan.complete && current.remaining > 0) {
        const batch = await fetchPage(current, current.scan.history);
        for (const message of batch.items) {
          const where = current.scan.history, id = hash(message.message_id);
          if (where.done.includes(id)) continue;
          if (milliseconds(message.create_time) > Date.parse(current.scan.window.to)) break;
          const archived = await archive(current, message, counts);
          const scan = {...current.scan, processed: current.scan.processed + archived.processed, contentPartial: current.scan.contentPartial || archived.partial, failed: 0,
            history: {...where, signature: batch.signature}};
          if (message.thread_id) scan.thread = {...position(), id: message.thread_id, root: message.message_id};
          else scan.history.done = [...where.done, id];
          // Commit the root and one pending thread before spending any of the
          // same round's remaining requests on replies. No unbounded root map.
          await saveScan(current, scan);
          if (scan.thread) await readThread(current, counts);
          if (current.scan.thread) return;
        }
        const scan = {...current.scan, history: batch.following, failed: 0};
        if (!batch.next || batch.items.some(message => milliseconds(message.create_time) > Date.parse(scan.window.to))) {
          scan.complete = true;
          if (!scan.contentPartial) scan.completeThrough = scan.window.to;
        }
        await saveScan(current, scan);
      }
    };

    const performSync = async () => {
      await refresh();
      if (!doc.archiveAuthorized) throw new FeishuSessionError('feishu_session_archive_not_authorized', 403);
      requireReadReady();
      if (!doc.selected.length) throw new FeishuSessionError('feishu_session_selection_required', 409);
      state = 'syncing'; code = undefined;
      const counts = {imported: 0, duplicates: 0}; let conversations = 0, current;
      try {
        ensureSources(false);
        for (const item of doc.selected) {
          if (!messageScopesOk(item.type, snapshot.scopes)) throw new FeishuSessionError('feishu_session_scope_missing', 403);
          const source = ctx.sources.getSource(sourceId(item.id));
          if (!source.enabled) continue;
          current = await openScan(item, source); current.pin.current();
          ctx.sources.reportStatus(current.id, {state: 'syncing', coverage: coverage(current.scan)}, current.pin.condition.syncScopeVersion);
          await readHistory(current, counts); current.pin.current();
          ctx.sources.reportStatus(current.id, {state: 'idle', lastSyncAt: now(), coverage: coverage(current.scan)}, current.pin.condition.syncScopeVersion);
          conversations++; current = undefined;
        }
        doc.lastSyncAt = now(); await persist(); state = 'idle';
        return {...counts, conversations, selected: doc.selected.length};
      } catch (error) {
        const stale = () => {if (!current) return closed; try {current.pin.current();return false;} catch {return true;}};
        const rejectStale = () => {state = 'idle';code = 'feishu_session_scope_changed';throw new FeishuSessionError(code, 409);};
        if (stale()) rejectStale();
        const failure = new FeishuSessionError(errorCode(error), statusOf(error));
        state = [401, 403].includes(failure.statusCode) ? 'permission_required' : 'error'; code = failure.code;
        if (current) {
          let scan = {...current.scan, failed: 1};
          // A changed page or looping/contradictory continuation is not a
          // trustworthy resume point. Rewalk this same fixed window; committed
          // original message identities and revisions remain safely deduplicated.
          if (['feishu_session_page_changed', 'feishu_session_pagination_invalid'].includes(code)) {scan = {...scan, processed: 0, contentPartial: false, complete: false, history: position()};delete scan.thread;}
          try {await saveScan(current, scan);} catch {if (stale()) rejectStale();}
          if (stale()) rejectStale();
          try {ctx.sources.reportStatus(current.id, {state, code, coverage: coverage(current.scan)}, current.pin.condition.syncScopeVersion);} catch {if (stale()) rejectStale();}
        }
        throw failure;
      }
    };

    const sync = () => {
      if (closed) return Promise.reject(new FeishuSessionError('connector_closed', 503));
      if (running) return running;
      running = run(performSync).finally(() => {running = undefined;});
      return running;
    };

    const messageItem = (item, message, threadRoot) => {
      const messageId = text(message?.message_id), body = messageBody(message);
      const created = new Date(milliseconds(message.create_time)).toISOString();
      const updated = message?.update_time && message.update_time !== '0' ? new Date(milliseconds(message.update_time)).toISOString() : undefined;
      const sender = cleanName(message?.sender?.name) || cleanName(message?.sender?.id) || '飞书';
      const originalMetadata = {version: 1, provider: 'lark', accountId: doc.accountId, chatId: item.id, messageId, messageType: text(message.msg_type),
        ...(protocolId(message.sender?.id) ? {authorId: message.sender.id} : {}),
        ...(message.sender?.id_type ? {authorIdType: cleanName(message.sender.id_type)} : {}),
        ...(message.sender?.sender_type ? {authorType: cleanName(message.sender.sender_type)} : {}),
        ...(message.root_id ? {rootExternalId: message.root_id} : {}), ...(message.parent_id ? {parentExternalId: message.parent_id} : {}),
        ...(message.thread_id ? {threadId: message.thread_id} : {}), ...(threadRoot ? {threadRootExternalId: threadRoot} : {}),
      };
      const value = {
        externalId: messageId, observedAt: now(), ...(updated ? {modifiedAt: updated} : {}),
        title: (item.name + ' · ' + sender).slice(0, 2000), text: body.text,
        kind: 'message', layer: 'snapshot', mimeType: 'text/plain', deleted: message?.deleted === true,
        metadata: {version: 1, provider: {createdAt: created, updatedAt: updated ?? created}},
        document: {recordedAt: created, timeBasis: 'recorded', contentRole: 'authored', originalMetadata, bodyCoverage: body.bodyCoverage},
      };
      const prior = ctx.sources.getItem(sourceId(item.id), messageId);
      const comparable = value => stable({
        externalId: value.externalId, title: value.title, text: value.text, kind: value.kind,
        layer: value.layer, deleted: value.deleted, modifiedAt: value.modifiedAt, metadata: value.metadata, document: value.document,
      });
      if (prior && comparable(prior) === comparable(value)) return {...value, revision: prior.revision};
      return {...value, revision: hash(comparable(value) + ':' + (prior?.revision ?? ''))};
    };

    const archivePostedMessage = async (item, sent, body) => {
      const pin = scanPin(item, ctx.sources.getSource(sourceId(item.id))); pin.current();
      const message = {
        message_id: sent.messageId,
        msg_type: 'text',
        create_time: sent.createTime,
        sender: {id: snapshot.accountName || '我'},
        body: {content: sent.content || JSON.stringify({text: body})},
      };
      const entry = messageItem(item, message);
      await ctx.sources.upsert(sourceId(item.id), entry, pin.current); pin.current();
      // A sent-message observation is not evidence that history was scanned.
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
        // Restore observation without registering, enabling or otherwise
        // changing the owner's already-persisted source pause intent.
        restoreReadWatches();
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
        selectionGeneration++;
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
            };
          });
          releaseReadWatches();
          const keep = new Set(chosen.map(item => item.id));
          for (const previous of doc.selected) {
            if (keep.has(previous.id)) continue;
            try {
              ctx.sources.resetCoverage(sourceId(previous.id));
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
        selectionGeneration++;
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
        releaseReadWatches();
        lifetime.abort();
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
