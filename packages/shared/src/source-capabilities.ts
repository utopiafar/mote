import type {SourceConnection} from './sources.js';

/** Transport capabilities describe installed adapters, never the meaning of their contents.
 * Availability and authorization remain separate checks at execution time. */
export type SourceCapabilities={
  version:1;
  lifecycle:'continuous'|'one-shot'|'external-push';
  discovery:'local-selection'|'provider-list'|'explicit-selection';
  listening:'filesystem'|'polling'|'none';
  readOriginal:'collector-request'|'explicit-provider-read'|'none';
  synchronization:'revisions'|'import-only'|'push-only';
  externalWrite:false;
  initialBody:'metadata-only'|'snapshot';
};
export type SourceCapabilityDescriptor=Omit<SourceCapabilities,'version'|'initialBody'>;
export class SourceCapabilityRegistry {
  private adapters=new Map<SourceConnection['kind'],Readonly<SourceCapabilityDescriptor>>();
  register(kind:SourceConnection['kind'],descriptor:SourceCapabilityDescriptor){
    if(this.adapters.has(kind))throw Error('Source adapter is already registered');
    this.adapters.set(kind,Object.freeze({...descriptor}));
  }
  has(kind:SourceConnection['kind']){return this.adapters.has(kind);}
  unregister(kind:SourceConnection['kind']){this.adapters.delete(kind);}
  clone(){const registry=new SourceCapabilityRegistry();for(const [kind,descriptor] of this.adapters)registry.register(kind,descriptor);return registry;}
  describe(source:Pick<SourceConnection,'kind'|'platform'|'retention'>):SourceCapabilities {
    const adapter=this.adapters.get(source.kind);
    if(!adapter)throw Error('Source adapter is not registered');
    const desktop=source.platform==='macos';
    return {version:1,...adapter,
      // Filesystem notifications and on-demand Shadow reads are implemented by the Mac collector.
      ...(adapter.listening==='filesystem'&&!desktop?{listening:'polling' as const}:{}),
      ...(adapter.readOriginal==='collector-request'&&!desktop?{readOriginal:'none' as const}:{}),
      initialBody:source.retention==='reference'?'metadata-only':'snapshot'};
  }
}
export const sourceCapabilities=new SourceCapabilityRegistry();
const local:SourceCapabilityDescriptor={lifecycle:'continuous',discovery:'local-selection',listening:'polling',readOriginal:'none',synchronization:'revisions',externalWrite:false};
const provider:SourceCapabilityDescriptor={...local,discovery:'provider-list',readOriginal:'explicit-provider-read'};
sourceCapabilities.register('local-files',{...local,listening:'filesystem',readOriginal:'collector-request'});
sourceCapabilities.register('coding-agent',{...local,listening:'filesystem'});
sourceCapabilities.register('local-calendar',local);
for(const kind of ['gmail','google-calendar','lark-docs','lark-calendar'] as const)sourceCapabilities.register(kind,provider);
sourceCapabilities.register('mcp',{lifecycle:'one-shot',discovery:'provider-list',listening:'none',readOriginal:'explicit-provider-read',synchronization:'import-only',externalWrite:false});
sourceCapabilities.register('upload',{lifecycle:'one-shot',discovery:'explicit-selection',listening:'none',readOriginal:'none',synchronization:'import-only',externalWrite:false});
sourceCapabilities.register('custom',{lifecycle:'external-push',discovery:'explicit-selection',listening:'none',readOriginal:'none',synchronization:'push-only',externalWrite:false});
