export type EvidenceRefKind = 'capture' | 'memory';
export type EvidenceRef = {kind:EvidenceRefKind;id:string};

/** UUID resource identities are distinct from typed public evidence references. */
export function parseEvidenceId(value:string):string|undefined {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value.toLowerCase():undefined;
}
/** Public references always carry a namespace; a bare UUID never chooses one. */
export function parseEvidenceRef(value:string):EvidenceRef|undefined {
  const match=/^(capture|memory):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value);
  return match?{kind:match[1].toLowerCase() as EvidenceRefKind,id:match[2].toLowerCase()}:undefined;
}
export function evidenceRefId(value:string,kind:EvidenceRefKind):string|undefined {
  const parsed=parseEvidenceRef(value);
  return parsed?.kind===kind?parsed.id:undefined;
}
export function formatEvidenceRef(kind:EvidenceRefKind,id:string):string {
  const parsed=parseEvidenceId(id);
  if(!parsed)throw new Error('Invalid evidence identity');
  return `${kind}:${parsed}`;
}

export type ArtifactRef={id:string;revision:string};
/** Derived artifacts have mutable logical IDs, so public refs always pin the produced revision. */
export function formatArtifactRef(id:string,revision:string):string {
  if(!id||!revision||id.length>128||revision.length>128)throw new Error('Invalid artifact reference');
  return `artifact:${encodeURIComponent(id)}:${encodeURIComponent(revision)}`;
}
export function parseArtifactRef(ref:string):ArtifactRef|undefined {
  if(ref.length>1600)return;
  const match=/^artifact:([^:]+):([^:]+)$/.exec(ref);if(!match)return;
  try{const id=decodeURIComponent(match[1]),revision=decodeURIComponent(match[2]);return formatArtifactRef(id,revision)===ref?{id,revision}:undefined;}catch{return;}
}
