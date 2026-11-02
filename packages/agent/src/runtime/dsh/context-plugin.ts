import {createServer} from 'node:http';
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Context} from '@deepseek-ai/cordis';
import {assertObjectJsonSchema, type ToolDefinition} from '@deepseek-ai/dsh-tools';
import type {HostRunPort, RuntimeAttempt, RuntimeToolDefinition, RuntimeToolPayload} from '../contracts.js';
import {AgentResponseError} from '../../types.js';
import {ContextToolError} from '../../tool-errors.js';
import {AgentYieldError} from '../../host-controls.js';

interface ChildConfiguration {url: string; token: string; runId: string; tools: readonly RuntimeToolDefinition[]}
interface NativeCall {attempt: RuntimeAttempt; name: string; arguments: unknown; consumed: boolean}
interface RuntimeReceipt {runId: string; attemptId: string; callId: string; payloadFingerprint: string}
const fingerprint = (payload: RuntimeToolPayload) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const failure = () => new AgentResponseError('The native context tools could not be verified or delivered.', 'tools_unverified');

/** Private process transport only. This owns no reader, ledger or data grant. */
export async function createDshHostChannel(host: HostRunPort) {
  const token = randomBytes(32).toString('hex');
  let rejectFailure!: (error: Error) => void, closing = false;
  const failurePromise = new Promise<never>((_resolve, reject) => { rejectFailure = reject; }); void failurePromise.catch(() => {});
  const calls = new Map<string, NativeCall>(), waiters = new Map<string, Set<() => void>>();
  const acknowledgements = new Map<string, {resolve(): void; reject(error: Error): void; completed: Promise<void>; receipt: RuntimeReceipt}>();
  const pending = new Set<Promise<void>>();
  const keyFor = (turn: number, callId: string) => `${turn}:${callId}`;
  const cancel = () => {
    for (const ack of acknowledgements.values()) ack.reject(new DOMException('Host delivery cancelled', 'AbortError'));
    acknowledgements.clear(); for (const group of waiters.values()) for (const wake of group) wake(); waiters.clear();
  };
  host.signal.addEventListener('abort', cancel, {once: true});
  const server = createServer((req, res) => {
    const task = (async () => {
      const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token);
      if (closing || req.method !== 'POST' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end(); return; }
      try {
        host.assertCurrent();
        let raw = ''; for await (const part of req) { raw += part; if (Buffer.byteLength(raw) > 1_048_576) throw failure(); }
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure();
        if (req.url === '/ready') {
          if (Object.keys(body).some(key => key !== 'tools') || !Array.isArray(body.tools)) throw failure();
          const expectedTools = host.tools.definitions;
          if (body.tools.length !== expectedTools.length || body.tools.some((actual: {name?: string; description?: string; parameters?: unknown}) => {
            const expected = expectedTools.find(tool => tool.name === actual.name);
            return !expected || actual.description !== expected.description || !isDeepStrictEqual(actual.parameters, expected.inputSchema);
          }) || new Set(body.tools.map((tool: {name?: string}) => tool.name)).size !== body.tools.length) throw failure();
          host.emit({type: 'tools.ready', tools: expectedTools.map(({name, version, fingerprint}) => ({name, version, fingerprint}))}, null);
          res.writeHead(200).end('{}'); return;
        }
        if (req.url === '/ack') {
          if (typeof body.id !== 'string' || typeof body.delivered !== 'boolean' || Object.keys(body).some(key => !['id', 'delivered', 'runId', 'attemptId', 'callId', 'payloadFingerprint'].includes(key))) throw failure();
          const ack = acknowledgements.get(body.id);
          if (!ack || !isDeepStrictEqual(ack.receipt, {runId: body.runId, attemptId: body.attemptId, callId: body.callId, payloadFingerprint: body.payloadFingerprint})) throw failure();
          acknowledgements.delete(body.id);
          body.delivered ? ack.resolve() : ack.reject(new AgentResponseError('Native tool preparation failed.', 'tool_failure'));
          await ack.completed;
          res.writeHead(200).end('{}'); return;
        }
        if (req.url !== '/call' || body.sessionId !== host.identity.runId || !Number.isSafeInteger(body.turn) || body.turn < 0 || typeof body.callId !== 'string' || typeof body.name !== 'string' || Object.keys(body).some(key => !['sessionId', 'turn', 'callId', 'name', 'arguments'].includes(key))) throw failure();
        const key = keyFor(body.turn, body.callId);
        if (!calls.has(key)) await new Promise<void>(resolve => { const group = waiters.get(key) ?? new Set(); group.add(resolve); waiters.set(key, group); });
        host.assertCurrent(); if (closing) throw failure();
        const call = calls.get(key); if (!call || call.consumed || call.name !== body.name || !isDeepStrictEqual(call.arguments, body.arguments)) throw failure();
        call.consumed = true;
        let confirmed!: () => void, rejected!: (error: unknown) => void;
        const completed = new Promise<void>((resolve, reject) => { confirmed = resolve; rejected = reject; }); void completed.catch(() => {});
        try {
          await host.tools.deliver(call.attempt, {callId: body.callId, name: body.name, arguments: body.arguments}, async (payload: RuntimeToolPayload) => {
            const id = randomUUID();
            const receipt: RuntimeReceipt = {runId: host.identity.runId, attemptId: call.attempt.id, callId: body.callId, payloadFingerprint: fingerprint(payload)};
            const delivered = new Promise<void>((resolve, reject) => acknowledgements.set(id, {resolve, reject, completed, receipt}));
            res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({id, receipt, payload}));
            await delivered;
          });
          confirmed();
        } catch (error) { rejected(error); throw error; }
      } catch (error) {
        if (error instanceof AgentYieldError || error instanceof AgentResponseError && (error.reason === 'tool_failure' || error.reason === 'tools_unverified')) rejectFailure(error);
        if (req.url === '/ready') rejectFailure(failure());
        if (res.headersSent) { rejectFailure(error instanceof AgentResponseError ? error : new AgentResponseError('Native delivery did not complete.', 'tool_failure')); return; }
        const toolError = error instanceof ContextToolError ? error.toJSON() : {code: 'host_tool_rejected', message: 'The Host rejected this tool call.', recovery: 'stop', details: {}};
        res.writeHead(400, {'Content-Type': 'application/json'}).end(JSON.stringify({toolError}));
      }
    })();
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
  });
  server.requestTimeout = 30_000; server.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw failure();
  let closed: Promise<void> | undefined;
  return {
    configuration: {url: `http://127.0.0.1:${address.port}`, token, runId: host.identity.runId, tools: host.tools.definitions} satisfies ChildConfiguration,
    failure: failurePromise,
    bindCall(turn: number, callId: string, name: string, attempt: RuntimeAttempt, args: unknown) {
      if (closing) return;
      const key = keyFor(turn, callId), existing = calls.get(key);
      if (existing && (existing.attempt !== attempt || existing.name !== name || !isDeepStrictEqual(existing.arguments, args))) { rejectFailure(failure()); return; }
      if (!existing) calls.set(key, {attempt, name, arguments: structuredClone(args), consumed: false});
      for (const wake of waiters.get(key) ?? []) wake(); waiters.delete(key);
    },
    close() {
      return closed ??= (async () => {
        const unknown = acknowledgements.size > 0 || waiters.size > 0;
        closing = true; host.signal.removeEventListener('abort', cancel); cancel();
        await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
        await Promise.allSettled([...pending]);
        if (unknown) throw new AgentResponseError('Native tool delivery acknowledgement is unknown.', 'tool_failure');
      })();
    },
  };
}

/** Child-side native adapter. Host configuration is mandatory; there is no
 * archive reader, default tool catalog, ambient skill or path fallback. */
export async function applyContextPlugin(ctx: Context) {
  const raw = process.env.MOTE_HOST_RUN;
  if (!raw) throw failure();
  const config = JSON.parse(raw) as ChildConfiguration;
  if (!config.url?.startsWith('http://127.0.0.1:') || typeof config.token !== 'string' || !Array.isArray(config.tools) || new Set(config.tools.map(tool => tool.name)).size !== config.tools.length) throw failure();
  const transport = globalThis.fetch.bind(globalThis);
  const call = async (path: string, body: unknown, signal?: AbortSignal) => {
    const response = await transport(config.url + path, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token}, body: JSON.stringify(body), signal});
    const value = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    return value;
  };
  for (const tool of config.tools) {
    assertObjectJsonSchema(tool.inputSchema);
    const definition: ToolDefinition = {
      name: tool.name, description: tool.description, parameters: {...tool.inputSchema},
      output: {schema: {}, render: (_args, value) => {
        const result = value as {text: string; attachments?: unknown[]};
        return [{type: 'text', text: result.text}, ...(result.attachments ?? []).map(attachment => ({type: 'image' as const, attachment: attachment as never}))];
      }},
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const event = [...(exec.agent?.session.snapshotEvents() ?? [])].reverse().find(event => event.type === 'tool/call' && event.data.callId === exec.callId);
        if (!event || event.type !== 'tool/call' || exec.agent?.id !== config.runId) throw failure();
        const delivered = await call('/call', {sessionId: config.runId, turn: event.data.turn, callId: exec.callId, name: tool.name, arguments: args}, exec.signal) as {id: string; receipt: RuntimeReceipt; payload: RuntimeToolPayload};
        try {
          if (delivered.receipt.runId !== config.runId || delivered.receipt.callId !== exec.callId || delivered.receipt.payloadFingerprint !== fingerprint(delivered.payload)) throw failure();
          const attachments = [];
          for (const image of delivered.payload.images ?? []) {
            const service = ctx.get('attachments') as {saveImage(input: {data: Buffer; mediaType: string; name: string}): Promise<unknown>} | undefined;
            if (!service) throw failure();
            attachments.push(await service.saveImage({data: Buffer.from(image.data, 'base64'), mediaType: image.mimeType, name: 'capture'}));
          }
          await call('/ack', {id: delivered.id, ...delivered.receipt, delivered: true}, exec.signal);
          return {text: delivered.payload.text, ...(attachments.length ? {attachments} : {})};
        } catch (error) {
          await call('/ack', {id: delivered.id, ...delivered.receipt, delivered: false}, AbortSignal.timeout(5000)).catch(() => {}); throw error;
        }
      },
    };
    ctx.tools.register(definition);
  }
  const allowed = new Set(config.tools.map(tool => tool.name));
  ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'Only Host-granted tools are available');
  const actual = ctx.tools.schemas().map(({name, description, parameters}) => ({name, description, parameters}));
  await call('/ready', {tools: actual});
  ctx.provide('moteReady', {tools: actual.map(tool => tool.name)});
}
