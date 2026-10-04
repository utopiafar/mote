import {createHash} from 'node:crypto';
/** Generated capture identities only; unrelated source/job/model identifiers stay literal. */
export function fixtureCaptureId(label){const hex=createHash('sha256').update('mote-agent-generated-capture:'+label).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;}
