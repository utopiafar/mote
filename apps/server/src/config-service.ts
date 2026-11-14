import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { watch, type FSWatcher } from 'chokidar';
import { parseDocument, stringify } from 'yaml';
import {z,type ZodType} from 'zod';
import type { ConfigFieldMetadata, ConfigServiceView } from '@mote/shared';

export type ConfigDocument = { version: 1; revision: number; [domain: string]: unknown };
export interface PreparedConfigChange {
  /** Awaitable resource installation; do not expose candidate admission, permissions or policy here. */
  apply(): void | Promise<void>;
  /** Synchronous runtime/SQL snapshot publication after all awaitable work succeeds. */
  publish?(): void;
  /** Undo published snapshots synchronously; resource-only rollback may be awaitable. */
  rollback?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
  /** Non-throwing finalization after all domains have applied, such as retiring old runtimes. */
  complete?(): void;
  /** Resource swaps that must share the publication point, such as models, apply last. */
  applyOrder?: number;
}
export interface ConfigDomainRegistration<T = unknown> {
  id: string;
  schema: ZodType<T, any, any>;
  defaultValue: unknown;
  fields?: ConfigFieldMetadata[];
  restartRequired?: boolean;
  /** Public domain editors must not persist submitted paths stripped by their input schema. */
  rejectUnknownUpdates?: boolean;
  /** Explicit raw-key declaration for public domains with opaque preprocessors. Parsed output is never persisted. */
  rawInputSchema?: z.AnyZodObject;
  /** Resolve declared credentials and contextual defaults without materializing them in the raw file. */
  resolve?(raw: unknown, document?: Readonly<ConfigDocument>): unknown;
  prepare?(next: T, previous: T): Promise<PreparedConfigChange> | PreparedConfigChange;
}
type FileSystem = Pick<typeof fs, 'open' | 'mkdir' | 'rename' | 'unlink'>;
type RegisteredDomain = ConfigDomainRegistration<any> & { documentPath?: string[] };
export interface ConfigServiceOptions {
  path: string;
  initialDocument?: ConfigDocument;
  watch?: boolean;
  fileSystem?: Partial<FileSystem>;
}
export type ConfigErrorCode = 'config_invalid' | 'config_conflict' | 'config_unavailable' | 'config_prepare_failed' | 'config_apply_failed' | 'config_save_failed' | 'config_commit_uncertain';
export class ConfigServiceError extends Error {
  readonly statusCode: number;
  constructor(readonly code: ConfigErrorCode, readonly domain?: string) {
    super(code); this.name = 'ConfigServiceError';
    this.statusCode = code === 'config_invalid' ? 400 : code === 'config_conflict' ? 409 : 503;
  }
}
const clone = <T>(value: T): T => structuredClone(value);
const MAX_BYTES = 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function merge(base: unknown, patch: unknown): unknown {
  if (!object(base) || !object(patch)) return clone(patch);
  const result = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new ConfigServiceError('config_invalid');
    result[key] = merge(result[key], value);
  }
  return result;
}
/** Path membership follows the registered INPUT declaration, independently of its parsed output.
 * The original schema remains responsible for full candidate validation in the same transaction. */
function knownInputPath(schema:z.ZodTypeAny,input:unknown,path:string[]):boolean {
  if(!path.length)return true;
  if(schema instanceof z.ZodEffects){
    // Opaque raw inputs need their own declaration; never infer keys by executing a preprocessor.
    if(schema._def.effect.type==='preprocess')return false;
    return knownInputPath(schema.innerType(),input,path);
  }
  if(schema instanceof z.ZodOptional||schema instanceof z.ZodNullable||schema instanceof z.ZodBranded||schema instanceof z.ZodReadonly)return knownInputPath(schema.unwrap(),input,path);
  if(schema instanceof z.ZodDefault)return knownInputPath(schema.removeDefault(),input,path);
  if(schema instanceof z.ZodCatch)return knownInputPath(schema._def.innerType,input,path);
  if(schema instanceof z.ZodPipeline)return knownInputPath(schema._def.in,input,path);
  if(schema instanceof z.ZodLazy)return knownInputPath(schema.schema,input,path);
  if(schema instanceof z.ZodUnion||schema instanceof z.ZodDiscriminatedUnion){
    const selected=schema.options.find((option:z.ZodTypeAny)=>option.safeParse(input).success);
    return Boolean(selected&&knownInputPath(selected,input,path));
  }
  if(schema instanceof z.ZodIntersection)return knownInputPath(schema._def.left,input,path)||knownInputPath(schema._def.right,input,path);
  const [key,...tail]=path,child=(object(input)||Array.isArray(input))?(input as Record<string,unknown>)[key]:undefined;
  if(schema instanceof z.ZodObject){
    const declared=Object.hasOwn(schema.shape,key)?schema.shape[key] as z.ZodTypeAny:undefined;
    if(declared)return knownInputPath(declared,child,tail);
    if(!(schema._def.catchall instanceof z.ZodNever))return knownInputPath(schema._def.catchall,child,tail);
    return schema._def.unknownKeys==='passthrough';
  }
  if(schema instanceof z.ZodArray)return /^(0|[1-9][0-9]*)$/.test(key)&&knownInputPath(schema.element,child,tail);
  if(schema instanceof z.ZodTuple){
    const item=/^(0|[1-9][0-9]*)$/.test(key)?schema.items[Number(key)]??schema._def.rest:undefined;
    return Boolean(item&&knownInputPath(item,child,tail));
  }
  if(schema instanceof z.ZodRecord)return knownInputPath(schema.element,child,tail);
  return schema instanceof z.ZodAny||schema instanceof z.ZodUnknown;
}
function hasPreprocessor(schema:z.ZodTypeAny,seen=new Set<z.ZodTypeAny>()):boolean {
  if(seen.has(schema))return false;seen.add(schema);
  if(schema instanceof z.ZodEffects&&schema._def.effect.type==='preprocess')return true;
  if(schema instanceof z.ZodPipeline)return hasPreprocessor(schema._def.in,seen);
  if(schema instanceof z.ZodLazy)return hasPreprocessor(schema.schema,seen);
  if(schema instanceof z.ZodObject&&Object.values(schema.shape).some(child=>hasPreprocessor(child as z.ZodTypeAny,seen)))return true;
  // Traverse declarations only. Do not call default/refinement/transform functions or interpret their behavior.
  const children=Object.values(schema._def).flatMap(value=>Array.isArray(value)?value:value instanceof Map?[...value.values()]:[value]);
  return children.some(value=>value instanceof z.ZodType&&hasPreprocessor(value,seen));
}
function knownPatchPaths(patch:unknown,schema:z.ZodTypeAny,input:unknown,path:string[]=[]):boolean {
  if(!knownInputPath(schema,input,path))return false;
  return !object(patch)&&!Array.isArray(patch)||Object.entries(patch as object).every(([key,value])=>knownPatchPaths(value,schema,input,[...path,key]));
}
function editPath(value: unknown, path: string[], fn: (value: unknown, previous: unknown) => unknown, previous?: unknown): unknown {
  if (!path.length) return fn(value, previous);
  if (!object(value) && !Array.isArray(value)) return value;
  const result = clone(value) as Record<string, unknown>;
  const [head, ...tail] = path;
  for (const key of head === '*' ? Object.keys(result) : [head!]) {
    if (Object.hasOwn(result, key)) result[key] = editPath(result[key], tail, fn, (previous as Record<string, unknown> | undefined)?.[key]);
  }
  return result;
}
function projectPath(target: unknown, source: unknown, path: string[]): unknown {
  if (!path.length) return clone(source);
  const result = (object(target) || Array.isArray(target) ? clone(target) : Array.isArray(source) ? [] : {}) as Record<string, unknown>;
  const [head, ...tail] = path, sourceObject = object(source) || Array.isArray(source) ? source as Record<string, unknown> : {};
  const keys = head === '*' ? new Set([...Object.keys(result), ...Object.keys(sourceObject)]) : [head!];
  for (const key of keys) {
    if (!Object.hasOwn(result, key) && !Object.hasOwn(sourceObject, key)) continue;
    if (!tail.length) { if (Object.hasOwn(sourceObject, key)) result[key] = clone(sourceObject[key]); else delete result[key]; }
    else {
      const prior = result[key], projected = projectPath(prior, sourceObject[key], tail);
      const contains = (value: unknown, parts: string[]): boolean => {
        if (!parts.length) return true;
        if (!object(value) && !Array.isArray(value)) return false;
        const [part, ...rest] = parts, record = value as Record<string, unknown>;
        return part === '*' ? Object.keys(record).some(item => contains(record[item], rest)) : Object.hasOwn(record, part!) && contains(record[part!], rest);
      };
      if (!Object.hasOwn(sourceObject, key) && object(projected) && !Object.keys(projected).length && contains(prior, tail)) delete result[key];
      else result[key] = projected;
    }
  }
  return result;
}
async function cleanup(work?: () => void | Promise<void>): Promise<void> { try { await work?.(); } catch { /* Complete remaining cleanup without replacing the transaction's safe error. */ } }
function resolveSensitive(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (process.env[name] === undefined) throw new ConfigServiceError('config_invalid');
    return process.env[name]!;
  });
  if (Array.isArray(value)) return value.map(resolveSensitive);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSensitive(item)]));
  return value;
}
function preserveReferences(raw: unknown, previous: unknown, next: unknown): unknown {
  if (typeof raw === 'string' && /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(raw) && isDeepStrictEqual(previous, next)) return raw;
  if (Array.isArray(next)) return next.map((item, index) => {
    const rawItems = Array.isArray(raw) ? raw : [], previousItems = Array.isArray(previous) ? previous : [];
    if (object(item) && typeof item.id === 'string') return preserveReferences(rawItems.find(value => object(value) && value.id === item.id), previousItems.find(value => object(value) && value.id === item.id), item);
    return preserveReferences(rawItems[index], previousItems[index], item);
  });
  if (object(next)) return Object.fromEntries(Object.entries(next).map(([key, value]) => [key, preserveReferences((raw as Record<string, unknown> | undefined)?.[key], (previous as Record<string, unknown> | undefined)?.[key], value)]));
  return clone(next);
}

/** One owner-editable file, one transaction queue, and independently registered domains. */
export class ConfigService {
  readonly path: string;
  private readonly io: FileSystem;
  private domains = new Map<string, RegisteredDomain>();
  private raw?: ConfigDocument;
  private effective = new Map<string, unknown>();
  /** Resolved schema inputs pin restart fields without reparsing transformed outputs or secret references. */
  private effectiveInputs = new Map<string, unknown>();
  private diskText: string | null = null;
  private tail: Promise<void> = Promise.resolve();
  private watcher?: FSWatcher;
  private watcherStopping?: Promise<void>;
  private watcherGeneration=0;
  private cancelWatcherReady?: () => void;
  private closing = false;
  private quiescing = false;
  private quiescePromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private unavailable = false;
  private lastError: { code: string; domain?: string } | null = null;
  private failedDomains = new Set<string>();
  private listeners = new Set<() => void>();
  private validateDocument?: (resolvedDocument: ConfigDocument) => void;
  private normalizeDocument?: (rawDocument: unknown, previous?: Readonly<ConfigDocument>) => unknown;
  constructor(private readonly options: ConfigServiceOptions) {
    this.path = resolve(options.path);
    this.io = { open: fs.open, mkdir: fs.mkdir, rename: fs.rename, unlink: fs.unlink, ...options.fileSystem };
  }
  get revision(): number { return this.state().revision; }
  register<T>(domain: ConfigDomainRegistration<T>): () => void {
    if (this.raw || !/^[a-z][a-zA-Z0-9_-]*$/.test(domain.id) || this.domains.has(domain.id) || ['version', 'revision'].includes(domain.id)) throw new ConfigServiceError('config_invalid');
    this.domains.set(domain.id, domain);
    return () => { if (!this.closing && this.raw) throw new ConfigServiceError('config_unavailable'); this.domains.delete(domain.id); };
  }
  /** Trusted Cordis plugins register after bootstrap; each gets an isolated namespace in the same file. */
  registerPlugin<T>(domain: ConfigDomainRegistration<T>): Promise<() => Promise<void>> {
    return this.serialize(async () => {
      if (!/^[a-z][a-zA-Z0-9_-]*$/.test(domain.id) || !this.domains.has('plugins')) throw new ConfigServiceError('config_invalid');
      const id = `plugin.${domain.id}`;
      if (this.domains.has(id)) throw new ConfigServiceError('config_conflict');
      const entry: RegisteredDomain = { ...domain, id, documentPath: ['plugins', 'configuration', domain.id] };
      const raw = this.state(), input = this.domainRaw(raw, entry) ?? entry.defaultValue;
      if(entry.rejectUnknownUpdates){
        if(!(entry.schema instanceof z.ZodType))throw new ConfigServiceError('config_invalid',id);
        if(entry.rawInputSchema){
          if(!(entry.rawInputSchema instanceof z.ZodObject)||hasPreprocessor(entry.rawInputSchema))throw new ConfigServiceError('config_invalid',id);
        }else if(hasPreprocessor(entry.schema))throw new ConfigServiceError('config_invalid',id);
      }
      const resolvedInput=this.resolveDomainInput(entry,input,raw),value=this.parseDomainInput(entry,resolvedInput);
      let candidate: PreparedConfigChange | undefined, applied = false;
      try {
        candidate = await entry.prepare?.(clone(value), clone(value));
        if (candidate) { applied = true; await candidate.apply(); this.publishCandidate(candidate,id); candidate.complete?.(); }
      } catch {
        let uncertain = this.unavailable;
        if (applied) {
          if (!candidate?.rollback) uncertain = true;
          else try { await candidate.rollback(); } catch { uncertain = true; }
        }
        await cleanup(() => candidate?.dispose?.());
        const error = new ConfigServiceError(uncertain ? 'config_commit_uncertain' : applied ? 'config_apply_failed' : 'config_prepare_failed', id);
        if (uncertain) this.unavailable = true;
        this.recordError(error); throw error;
      }
      this.domains.set(id, entry); this.effective.set(id, value); this.effectiveInputs.set(id,resolvedInput); this.assignRaw(raw, entry, clone(input));
      this.effective.set('plugins', this.pluginValues(this.effective.get('plugins'), child => clone(this.effective.get(child.id)))); this.notify();
      return async () => {
        const remove = async () => { this.domains.delete(id); this.effective.delete(id); this.effectiveInputs.delete(id); this.notify(); };
        if (this.closing) await remove();
        else if (this.quiescing) { try { await this.quiesce(); } finally { await remove(); } }
        else await this.serialize(remove);
      };
    });
  }
  private domainRaw(document: ConfigDocument, domain: RegisteredDomain): unknown {
    if (!domain.documentPath) return document[domain.id];
    return domain.documentPath.reduce<unknown>((value, part) => object(value) ? value[part] : undefined, document);
  }
  private assignRaw(document: ConfigDocument, domain: RegisteredDomain, value: unknown): void {
    if (!domain.documentPath) { document[domain.id] = value; return; }
    let parent: Record<string, unknown> = document;
    for (const part of domain.documentPath.slice(0, -1)) { if (!object(parent[part])) parent[part] = {}; parent = parent[part] as Record<string, unknown>; }
    parent[domain.documentPath.at(-1)!] = value;
  }
  setHandler<T>(id: string, prepare: NonNullable<ConfigDomainRegistration<T>['prepare']>): void {
    const domain = this.domains.get(id); if (!domain || this.closing) throw new ConfigServiceError('config_unavailable');
    domain.prepare = prepare;
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Internal bootstrap only; HTTP owners receive the redacted view. */
  document(): ConfigDocument { return clone(this.state()); }
  setValidator(validate: (resolvedDocument: ConfigDocument) => void): void { this.validateDocument = validate; }
  /** Startup has no previous document; updates receive a detached saved snapshot. */
  setNormalizer(normalize: (rawDocument: unknown, previous?: Readonly<ConfigDocument>) => unknown): void { this.normalizeDocument = normalize; }
  private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* observers cannot invalidate a committed configuration */ } } }
  private state(): ConfigDocument { if (!this.raw || this.unavailable) throw new ConfigServiceError('config_unavailable'); return this.raw; }
  private pluginValues(parent: unknown, read: (domain: RegisteredDomain) => unknown): unknown {
    if (!object(parent)) return parent;
    const value = clone(parent), configuration = object(value.configuration) ? value.configuration : {};
    for (const domain of this.domains.values()) if (domain.documentPath) configuration[domain.documentPath.at(-1)!] = read(domain);
    return { ...value, configuration };
  }
  current<T = unknown>(id: string): T {
    this.state(); if (!this.effective.has(id)) throw new ConfigServiceError('config_invalid');
    const value = clone(this.effective.get(id));
    return (id === 'plugins' ? this.pluginValues(value, domain => clone(this.effective.get(domain.id))) : value) as T;
  }
  saved<T = unknown>(id: string): T {
    const raw = this.state(), domain = this.domains.get(id); if (!domain) throw new ConfigServiceError('config_invalid');
    const value = this.parseDomain(domain, this.domainRaw(raw, domain), raw);
    return (id === 'plugins' ? this.pluginValues(value, child => this.parseDomain(child, this.domainRaw(raw, child), raw)) : value) as T;
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing || this.quiescing || this.unavailable) return Promise.reject(new ConfigServiceError('config_unavailable'));
    const result = this.tail.then(work); this.tail = result.then(() => {}, () => {}); return result;
  }
  private resolveDomainInput(domain: ConfigDomainRegistration, raw: unknown, document?: ConfigDocument): unknown {
    try {
      this.validateRawInput(domain,raw);
      let value = clone(raw);
      if (domain.resolve) value = domain.resolve(value, document ? clone(document) : undefined);
      else for (const field of domain.fields ?? []) if (field.sensitive) value = editPath(value, field.path.split('.'), resolveSensitive);
      return clone(value);
    }
    catch { throw new ConfigServiceError('config_invalid', domain.id); }
  }
  private parseDomainInput(domain:ConfigDomainRegistration,input:unknown):unknown {
    try{return domain.schema.parse(clone(input));}catch{throw new ConfigServiceError('config_invalid',domain.id);}
  }
  private validateRawInput(domain:ConfigDomainRegistration,input:unknown):void {
    if(!domain.rawInputSchema)return;
    try{
      domain.rawInputSchema.parse(clone(input));
      if(!knownPatchPaths(input,domain.rawInputSchema,input))throw new ConfigServiceError('config_invalid',domain.id);
    }catch{throw new ConfigServiceError('config_invalid',domain.id);}
  }
  private parseDomain(domain:ConfigDomainRegistration,raw:unknown,document?:ConfigDocument):unknown {
    return this.parseDomainInput(domain,this.resolveDomainInput(domain,raw,document));
  }
  private parse(raw: unknown): { raw: ConfigDocument; inputs:Map<string,unknown>; values: Map<string, unknown> } {
    if (this.normalizeDocument) { try { raw = this.normalizeDocument(raw, this.raw ? clone(this.raw) : undefined); } catch { throw new ConfigServiceError('config_invalid'); } }
    if (!object(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || Object.keys(raw).some(key => !['version', 'revision'].includes(key) && !this.domains.has(key))) throw new ConfigServiceError('config_invalid');
    const next = clone(raw) as ConfigDocument, values = new Map<string, unknown>(),inputs=new Map<string,unknown>();
    for (const domain of this.domains.values()) {
      const value = clone(this.domainRaw(next, domain) ?? domain.defaultValue);
      this.assignRaw(next, domain, value);
      const input=this.resolveDomainInput(domain,value,next);inputs.set(domain.id,input);
      values.set(domain.id, this.parseDomainInput(domain,input));
    }
    if (values.has('plugins')) values.set('plugins', this.pluginValues(values.get('plugins'), domain => clone(values.get(domain.id))));
    if (this.validateDocument) {
      const resolved = clone(next);
      for (const domain of this.domains.values()) this.assignRaw(resolved, domain, values.get(domain.id));
      try { this.validateDocument(resolved); } catch { throw new ConfigServiceError('config_invalid'); }
    }
    return { raw: next, inputs,values };
  }
  private async read(): Promise<{ text: string; document: unknown } | null> {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try { handle = await this.io.open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new ConfigServiceError('config_invalid'); }
    try {
      const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) throw new ConfigServiceError('config_invalid');
      const text = await handle.readFile('utf8'), after = await handle.stat();
      if (Buffer.byteLength(text) > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new ConfigServiceError('config_conflict');
      const doc = parseDocument(text, { uniqueKeys: true });
      if (doc.errors.length) throw new ConfigServiceError('config_invalid');
      return { text, document: doc.toJS({ maxAliasCount: 0 }) };
    } catch (error) { if (error instanceof ConfigServiceError) throw error; throw new ConfigServiceError('config_invalid'); }
    finally { await handle.close(); }
  }
  initialize(): Promise<ConfigServiceView> {
    return this.serialize(async () => {
      if (this.raw) return this.view();
      await this.io.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const disk = await this.read();
      if (!disk && !this.options.initialDocument) throw new ConfigServiceError('config_invalid');
      const parsed = this.parse(disk?.document ?? this.options.initialDocument);
      const prepared: PreparedConfigChange[] = [];
      try {
        for (const domain of this.domains.values()) if (domain.prepare) prepared.push(await domain.prepare(clone(parsed.values.get(domain.id)), clone(parsed.values.get(domain.id))));
        if (!disk) await this.persist(parsed.raw, null);
        for (const candidate of prepared.sort((a, b) => (a.applyOrder ?? 0) - (b.applyOrder ?? 0))) {
          const result = candidate.apply(); if (result && typeof result.then === 'function') await result;
        }
        for (const candidate of prepared) this.publishCandidate(candidate,'configuration');
        this.raw = parsed.raw; this.effective = parsed.values; this.effectiveInputs=parsed.inputs; this.diskText = disk?.text ?? stringify(parsed.raw,{aliasDuplicateObjects:false,lineWidth:0}); this.lastError = null;
        for (const candidate of prepared) candidate.complete?.();
        return this.view();
      } catch (error) {
        for (const candidate of prepared.reverse()) { await cleanup(() => candidate.rollback?.()); await cleanup(() => candidate.dispose?.()); }
        throw error instanceof ConfigServiceError ? error : new ConfigServiceError('config_prepare_failed');
      }
    });
  }
  private effectiveCandidate(domain: ConfigDomainRegistration, next: unknown, previous: unknown): unknown {
    if (domain.restartRequired) {
      let value = clone(previous);
      for (const field of domain.fields ?? []) if (field.effect && !['restart', 'migration'].includes(field.effect)) {
        value = projectPath(value, next, field.path.split('.'));
      }
      return value;
    }
    let value = clone(next);
    for (const field of domain.fields ?? []) if (field.effect === 'restart' || field.effect === 'migration') value = projectPath(value, previous, field.path.split('.'));
    return value;
  }
  private async persist(next: ConfigDocument, expectedText: string | null): Promise<boolean> {
    let text:string;try{text=stringify(next,{aliasDuplicateObjects:false,lineWidth:0});}catch{throw new ConfigServiceError('config_invalid');}
    const temporary = join(dirname(this.path), `.mote-config-${randomUUID()}.tmp`);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new ConfigServiceError('config_invalid');
    let renameAttempted = false;
    try {
      const handle = await this.io.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      const observed = await this.read();
      if ((observed?.text ?? null) !== expectedText) throw new ConfigServiceError('config_conflict');
      renameAttempted = true; await this.io.rename(temporary, this.path);
      const directory = await this.io.open(dirname(this.path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      this.diskText = text; return false;
    } catch (error) {
      if (renameAttempted) {
        try {
          const observed = await this.read();
          if (observed?.text === text) { this.diskText = text; return true; }
          if ((observed?.text ?? null) === expectedText) throw new ConfigServiceError('config_save_failed');
        }
        catch (readError) { if (readError instanceof ConfigServiceError && readError.code === 'config_save_failed') throw readError; }
        this.unavailable = true; throw new ConfigServiceError('config_commit_uncertain');
      }
      if (error instanceof ConfigServiceError) throw error;
      throw new ConfigServiceError('config_save_failed');
    } finally { await this.io.unlink(temporary).catch(() => {}); }
  }
  private async commit(parsed: ReturnType<ConfigService['parse']>, observedText: string | null): Promise<ConfigServiceView> {
    const previous = this.state(), next = parsed.raw;
    const nextEffective=new Map<string,unknown>(),nextInputs=new Map<string,unknown>();
    for(const domain of this.domains.values()){
      const input=this.effectiveCandidate(domain,parsed.inputs.get(domain.id),this.effectiveInputs.get(domain.id));
      nextInputs.set(domain.id,input);
      const value=isDeepStrictEqual(input,this.effectiveInputs.get(domain.id))?this.effective.get(domain.id)
        :isDeepStrictEqual(input,parsed.inputs.get(domain.id))?parsed.values.get(domain.id):this.parseDomainInput(domain,input);
      nextEffective.set(domain.id,value);
    }
    if(nextEffective.has('plugins'))nextEffective.set('plugins',this.pluginValues(nextEffective.get('plugins'),domain=>clone(nextEffective.get(domain.id))));
    if(this.validateDocument){
      const resolved=clone(next);for(const domain of this.domains.values())this.assignRaw(resolved,domain,nextEffective.get(domain.id));
      try{this.validateDocument(resolved);}catch{throw new ConfigServiceError('config_invalid');}
    }
    const changes = [...this.domains.values()].filter(domain => !isDeepStrictEqual(this.saved(domain.id), parsed.values.get(domain.id)) || !isDeepStrictEqual(nextEffective.get(domain.id), this.effective.get(domain.id)));
    if (!changes.length) {
      const revisionChanged = next.revision !== previous.revision; next.revision = previous.revision;
      if (revisionChanged) await this.persist(next, observedText); else this.diskText = observedText;
      this.raw = next; this.effectiveInputs=nextInputs; this.lastError = null; this.notify(); return this.view();
    }
    if (previous.revision === Number.MAX_SAFE_INTEGER) throw new ConfigServiceError('config_unavailable');
    next.revision = previous.revision + 1;
    const candidates: Array<{ id: string; value: unknown; candidate: PreparedConfigChange; applied: boolean; published: boolean }> = [];
    let committed = false;
    try {
      for (const domain of changes) {
        const value = nextEffective.get(domain.id);
        if (!isDeepStrictEqual(value, this.effective.get(domain.id)) && domain.prepare) {
          let candidate: PreparedConfigChange;
          try { candidate = await domain.prepare(clone(value), clone(this.effective.get(domain.id))); }
          catch { throw new ConfigServiceError('config_prepare_failed', domain.id); }
          candidates.push({ id: domain.id, value, candidate, applied: false, published: false });
        }
      }
      const uncertain = await this.persist(next, observedText);
      try {
        candidates.sort((a, b) => (a.candidate.applyOrder ?? 0) - (b.candidate.applyOrder ?? 0));
        for (const item of candidates) {
          item.applied = true; const result = item.candidate.apply(); if (result && typeof result.then === 'function') await result;
        }
        // Runtime permissions, intake SQL and snapshots become visible in one
        // synchronous continuation with the authoritative effective map.
        for (const item of candidates) if (item.candidate.publish) { item.published = true; this.publishCandidate(item.candidate,item.id); }
      } catch {
        // The saved candidate remains visible as failed, while all effective domains retain their old values.
        let failedRollback: string | undefined;
        const undo=[...candidates.filter(item=>item.published).reverse(),...candidates.filter(item=>item.applied&&!item.published).reverse()];
        for (const item of undo) {
          if (!item.candidate.rollback) { if(item.published||!item.candidate.publish)failedRollback ??= item.id; continue; }
          try {
            const result=item.candidate.rollback();
            if(result&&typeof result.then==='function') {
              if(item.published) { failedRollback ??= item.id; void Promise.resolve(result).catch(()=>{}); }
              else await result;
            }
          } catch { failedRollback ??= item.id; }
        }
        if (failedRollback||this.unavailable) { this.unavailable = true; throw new ConfigServiceError('config_commit_uncertain', failedRollback); }
        this.raw = next; this.failedDomains = new Set(candidates.map(item => item.id)); this.lastError = { code: 'config_apply_failed' }; this.notify();
        throw new ConfigServiceError('config_apply_failed');
      }
      this.raw = next; this.effective = nextEffective; this.effectiveInputs=nextInputs; this.failedDomains.clear(); this.lastError = null;
      committed = true;
      for (const item of candidates) item.candidate.complete?.();
      this.notify();
      if (uncertain) { this.lastError = { code: 'config_commit_uncertain' }; throw new ConfigServiceError('config_commit_uncertain'); }
      return this.view();
    } finally {
      // Failed transactions also dispose resources installed before publication.
      // Successful activation transfers ownership to the domain runtime.
      for (const item of candidates) if (!committed || !item.applied) await cleanup(() => item.candidate.dispose?.());
    }
  }
  private publishCandidate(candidate:PreparedConfigChange,id:string):void {
    const result=candidate.publish?.() as unknown;
    if(result&&typeof (result as {then?:unknown}).then==='function') {
      this.unavailable=true; void Promise.resolve(result).catch(()=>{});
      throw new ConfigServiceError('config_commit_uncertain',id);
    }
  }
  update(id: string, patch: unknown, expectedRevision: number): Promise<ConfigServiceView> {
    return this.updateMany({ [id]: patch }, expectedRevision);
  }
  /** Domain editors submit a complete, validated replacement so deletions retain their meaning. */
  replace(id: string, value: unknown, expectedRevision: number): Promise<ConfigServiceView> {
    return this.updateMany({ [id]: value }, expectedRevision, true);
  }
  updateMany(patches: Record<string, unknown>, expectedRevision: number, replace = false): Promise<ConfigServiceView> {
    return this.serialize(async () => {
      try {
        if (!object(patches) || !Object.keys(patches).length || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ConfigServiceError('config_invalid');
        for (const [id, patch] of Object.entries(patches)) if (!this.domains.has(id) || !object(patch)) throw new ConfigServiceError('config_invalid');
        const disk = await this.read();
        if ((disk?.text ?? null) !== this.diskText) { await this.reloadInternal(disk); throw new ConfigServiceError('config_conflict'); }
        const state = this.state(); if (expectedRevision !== state.revision) throw new ConfigServiceError('config_conflict');
        const next = clone(state);
        for (const [id, patch] of Object.entries(patches)) {
          const domain = this.domains.get(id)!, saved = this.saved(id), value = replace ? clone(patch) : merge(this.domainRaw(state, domain) ?? domain.defaultValue, patch);
          if (id === 'plugins' && object(patch) && Object.hasOwn(patch, 'configuration')) throw new ConfigServiceError('config_invalid');
          if(domain.rejectUnknownUpdates){
            this.parseDomain(domain,value,state);
            if(!knownPatchPaths(patch,domain.rawInputSchema??domain.schema,value))throw new ConfigServiceError('config_invalid',id);
          }
          this.assignRaw(next, domain, preserveReferences(this.domainRaw(state, domain), saved, value));
        }
        return await this.commit(this.parse(next), disk?.text ?? null);
      } catch (error) { this.recordError(error); throw error; }
    });
  }
  private async reloadInternal(disk: Awaited<ReturnType<ConfigService['read']>>): Promise<ConfigServiceView> {
    if (!disk) throw new ConfigServiceError('config_invalid');
    if (disk.text === this.diskText) { if (this.lastError?.code !== 'config_apply_failed') { this.lastError = null; this.notify(); } return this.view(); }
    const parsed = this.parse(disk.document);
    const revision = this.state().revision;
    if (parsed.raw.revision !== revision && parsed.raw.revision !== revision + 1) throw new ConfigServiceError('config_conflict');
    return this.commit(parsed, disk.text);
  }
  reload(): Promise<ConfigServiceView> {
    return this.serialize(async () => { try { return await this.reloadInternal(await this.read()); } catch (error) { this.recordError(error); throw error; } });
  }
  private recordError(error: unknown): void {
    this.lastError = error instanceof ConfigServiceError ? { code: error.code, ...(error.domain ? { domain: error.domain } : {}) } : { code: 'config_unavailable' };
    this.notify();
  }
  async startWatching(): Promise<void> {
    if (this.closing || this.quiescing) throw new ConfigServiceError('config_unavailable');
    const generation=this.watcherGeneration;
    // Acquire ownership without yielding when no teardown is pending. A stop during a wait fences this start.
    if(this.watcherStopping)await this.watcherStopping;
    this.state(); if (this.closing||this.quiescing||generation!==this.watcherGeneration) throw new ConfigServiceError('config_unavailable');
    if (this.watcher || this.options.watch === false) return;
    this.watcherStopping=undefined;
    const watcher=this.watcher=watch(dirname(this.path), { depth: 0, ignoreInitial: true, followSymlinks: false, atomic: true, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 } });
    watcher.on('all', (_event, file) => { if (this.watcher===watcher && basename(file) === basename(this.path) && !this.closing && !this.quiescing) void this.reload().catch(() => {}); });
    watcher.on('error', () => { if(this.watcher===watcher&&!this.closing&&!this.quiescing){this.lastError = { code: 'config_unavailable' }; this.notify();} });
    try {
      await new Promise<void>((resolveReady, reject) => {
        this.cancelWatcherReady=()=>reject(new ConfigServiceError('config_unavailable'));
        watcher.once('ready', resolveReady); watcher.once('error', () => reject(new ConfigServiceError('config_unavailable')));
      });
    } finally { if(this.watcher===watcher)this.cancelWatcherReady=undefined; }
    if(this.closing||this.watcher!==watcher)throw new ConfigServiceError('config_unavailable');
    // Changes between the initial read and watcher readiness cannot be represented by ignoreInitial events.
    await this.reload().catch(() => {});
  }
  /** Stop file admissions during plugin quiescence without retiring accepted transactions. */
  stopWatching(): Promise<void> {
    this.watcherGeneration++;
    if(this.watcherStopping)return this.watcherStopping;
    const watcher=this.watcher;this.watcher=undefined;
    this.cancelWatcherReady?.();this.cancelWatcherReady=undefined;
    return this.watcherStopping=Promise.resolve().then(()=>watcher?.close());
  }
  view(): ConfigServiceView {
    const state = this.state();
    const domains = [...this.domains.values()].map(domain => {
      const saved = this.saved(domain.id), effective = this.current(domain.id);
      const redact = (value: unknown) => { let result = clone(value); for (const field of domain.fields ?? []) if (field.sensitive) result = editPath(result, field.path.split('.'), item => Boolean(item && (typeof item !== 'object' || Object.keys(item).length))); return result; };
      return { id: domain.id, saved: redact(saved), effective: redact(effective), fields: clone(domain.fields ?? []), status: this.failedDomains.has(domain.id) ? 'invalid' as const : isDeepStrictEqual(saved, effective) ? 'applied' as const : 'restart-required' as const, ...(this.failedDomains.has(domain.id) ? { error: 'config_apply_failed' } : {}) };
    });
    return { version: 1, revision: state.revision, configFile: this.path, domains, lastError: clone(this.lastError) };
  }
  /** Fence new raw file work synchronously, then retire the watcher and drain
   * operations already accepted by serialize(). Reads keep their current state;
   * private commit/reload helpers remain usable by those accepted operations. */
  quiesce(): Promise<void> {
    this.quiescing = true;
    return this.quiescePromise ??= (async () => {
      try { await this.stopWatching(); } finally { await this.tail; }
    })();
  }
  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closing = true;
      try { await this.quiesce(); } finally { this.listeners.clear(); }
    })();
  }
}
