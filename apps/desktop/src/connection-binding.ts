import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Config } from './contracts';
import { atomicSourceJson } from './source-sync';
type Connection = Pick<Config, 'serverUrl' | 'token'>;
export type Binding = { kind: 'unbound' | 'unknown' } | { kind: 'bound'; origin: string; credentialHash: string };
export function connectionBinding(config: Connection): Binding {
  return config.serverUrl && config.token ? { kind: 'bound', origin: config.serverUrl, credentialHash: createHash('sha256').update(config.token).digest('hex') } : { kind: 'unbound' };
}
/** Independent of editable config: clearing a URL cannot make old personal data unbound. */
export class ConnectionBindingStore {
  private value: Binding = { kind: 'unknown' };
  constructor(private path: string) {}
  async initialize(config: Connection, hasLegacyData: boolean): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Binding;
      if (!['bound', 'unbound', 'unknown'].includes(value.kind) || (value.kind === 'bound' && (typeof value.origin !== 'string' || !/^https?:\/\//.test(value.origin) || !/^[a-f0-9]{64}$/.test(value.credentialHash)))) throw new Error('本地记录的节点绑定信息无效');
      this.value = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const current = connectionBinding(config);
      this.value = current.kind === 'unbound' && hasLegacyData ? { kind: 'unknown' } : current;
      await atomicSourceJson(this.path, this.value);
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
    throw new Error('本地待上传记录已绑定原节点或凭据，不能重新归属；请恢复原连接完成同步');
  }
  async commit(config: Connection, pending: boolean, confirmedInitial = false, sameNodeReauthorization = false): Promise<void> {
    this.assertChange(config, pending, confirmedInitial, sameNodeReauthorization);
    const next = connectionBinding(config);
    await atomicSourceJson(this.path, next); this.value = next;
  }
}
