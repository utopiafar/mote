export const INGRESS_VERSION_HEADERS={'X-Mote-Ingress-Version':'2'} as const;
export type IngressKind='capture'|'source-item'|'file-revision';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface IngressReceipt {
  version:2;
  id:string;
  kind:IngressKind;
  state:'received';
  duplicate:boolean;
  sourceId?:string;
  externalId?:string;
  revision?:string;
}

/** A successful HTTP status is not a durable-ingress acknowledgement by itself. */
export function requireIngressReceipt(value:unknown,expected:{kind:IngressKind;id?:string;sourceId?:string;externalId?:string;revision?:string}):IngressReceipt {
  if(!value||typeof value!=='object')throw Error('Invalid v2 ingress receipt');
  const envelope=value as Record<string,unknown>,raw=envelope.receipt;
  if(!raw||typeof raw!=='object')throw Error('Invalid v2 ingress receipt');
  const receipt=raw as Record<string,unknown>;
  if(receipt.version!==2||receipt.state!=='received'||receipt.kind!==expected.kind||typeof receipt.id!=='string'||!uuid.test(receipt.id)||typeof receipt.duplicate!=='boolean'||
    envelope.id!==receipt.id||expected.id!==undefined&&receipt.id!==expected.id||
    envelope.duplicate!==undefined&&envelope.duplicate!==receipt.duplicate)throw Error('Invalid v2 ingress receipt');
  if(expected.kind==='capture'){
    if(receipt.sourceId!==undefined||receipt.externalId!==undefined||receipt.revision!==undefined)throw Error('Invalid v2 ingress receipt');
  }else if(typeof receipt.sourceId!=='string'||typeof receipt.externalId!=='string'||typeof receipt.revision!=='string'||
    envelope.sourceId!==receipt.sourceId||envelope.externalId!==receipt.externalId||envelope.revision!==receipt.revision||
    expected.sourceId!==receipt.sourceId||expected.externalId!==receipt.externalId||expected.revision!==receipt.revision)throw Error('Invalid v2 ingress receipt');
  return receipt as unknown as IngressReceipt;
}
