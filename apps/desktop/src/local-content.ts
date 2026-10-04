import {readFile} from 'node:fs/promises';

/** Format 3 stores content directly; credentials use the separate system secret store. */
export function encodeLocalContent(value:string|Uint8Array):Buffer{return typeof value==='string'?Buffer.from(value):Buffer.from(value);}
export function decodeLocalContent(bytes:Buffer):Buffer{return bytes;}
export async function readLocalContent(path:string):Promise<Buffer>{return decodeLocalContent(await readFile(path));}
