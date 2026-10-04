import {formatEvidenceRef} from '@mote/shared';
/** Fixture resource UUIDs become explicit tool references at the reader boundary. */
export const fixtureCaptureRefs=(ids:string[])=>ids.map(id=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)?formatEvidenceRef('capture',id):id);
