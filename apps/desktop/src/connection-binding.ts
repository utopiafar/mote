import {RESET_REQUIRED} from './storage-format';
import { moteText } from '@mote/shared/i18n';
import { connectionServerUrl, type MoteLinkScope } from '@mote/shared';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Config } from './contracts';
import { atomicSourceJson } from './source-sync';
type Connection = Pick<Config, 'serverUrl' | 'token'>;
type ScopeOrigin = MoteLinkScope['origin'];
export type Binding = { kind: 'unbound' | 'unknown' } | { kind: 'bound'; origin: ScopeOrigin; credentialHash: string };
function scopeOrigin(serverUrl: string): ScopeOrigin { return connectionServerUrl(serverUrl); }
function storedScopeOrigin(value: string): ScopeOrigin | undefined {
  try { const origin = scopeOrigin(value); return origin === value ? origin : undefined; }
  catch { return undefined; }
}
export function connectionBinding(config: Connection): Binding {
  return config.serverUrl && config.token ? { kind: 'bound', origin: scopeOrigin(config.serverUrl), credentialHash: createHash('sha256').update(config.token).digest('hex') } : { kind: 'unbound' };
}
/** Independent of editable config: clearing a URL cannot make old personal data unbound. */
export class ConnectionBindingStore {
  private value: Binding = { kind: 'unknown' };
  constructor(private path: string, private readonly write: (path: string, value: unknown) => Promise<void> = atomicSourceJson) {}
  async initialize(config: Connection, hasData: boolean): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Binding;
      if (!['bound', 'unbound', 'unknown'].includes(value.kind) || (value.kind === 'bound' && (typeof value.origin !== 'string' || storedScopeOrigin(value.origin) === undefined || !/^[a-f0-9]{64}$/.test(value.credentialHash)))) throw new Error(moteText("本地记录的节点绑定信息无效"));
      this.value = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if(hasData)throw Error(RESET_REQUIRED);
      this.value = connectionBinding(config);
      await this.write(this.path, this.value);
    }
  }
  unbound(): boolean { return this.value.kind === 'unbound'; }
  snapshot(): Binding { return { ...this.value }; }
  matches(config: Connection): boolean { return JSON.stringify(this.value) === JSON.stringify(connectionBinding(config)); }
  assertChange(config: Connection, pending: boolean, confirmedInitial = false, sameNodeReauthorization = false): void {
    const target = connectionBinding(config);
    if (!pending || this.matches(config)) return;
    if (this.unbound() && target.kind === 'bound' && confirmedInitial) return;
    if (sameNodeReauthorization && this.value.kind === 'bound' && target.kind === 'bound' && this.value.origin === target.origin) return;
    throw new Error(moteText("本地待上传记录已绑定原节点或凭据，不能重新归属；请恢复原连接完成同步"));
  }
  async commit(config: Connection, pending: boolean, confirmedInitial = false, sameNodeReauthorization = false): Promise<void> {
    this.assertChange(config, pending, confirmedInitial, sameNodeReauthorization);
    const next = connectionBinding(config);
    await this.write(this.path, next); this.value = next;
  }
}
