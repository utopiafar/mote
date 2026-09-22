export type EvidenceRefKind = 'capture' | 'memory';
export type EvidenceRef = {kind:EvidenceRefKind;id:string};

/** Immutable evidence identities. Navigation cards and mutable source IDs are not evidence. */
export function parseEvidenceRef(value:string,bareKind:EvidenceRefKind='capture'):EvidenceRef|undefined {
  const match=/^(?:(capture|memory):)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value);
  return match?{kind:match[1]?.toLowerCase() as EvidenceRefKind??bareKind,id:match[2].toLowerCase()}:undefined;
}

/** Legacy ID-only endpoints choose the bare-ID namespace; an explicit wrong kind never falls back. */
export function evidenceRefId(value:string,kind:EvidenceRefKind):string|undefined {
  const parsed=parseEvidenceRef(value,kind);
  return parsed?.kind===kind?parsed.id:undefined;
}

export function formatEvidenceRef(kind:EvidenceRefKind,id:string):string {
  const parsed=evidenceRefId(id,kind);
  if(!parsed)throw new Error('Invalid evidence reference');
  return `${kind}:${parsed}`;
}
