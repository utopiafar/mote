import type {CaptureInput} from '@mote/shared';
import type {NotesCapture} from '../features/notes.js';
import type {IngressService} from '../ingress.js';
import type {NotesSourceAssembly} from '../plugins/notes-source.js';
import type {SourceStore} from '../sources.js';

/** C10 capture members. */
export interface CaptureFeatureServices {
  sources:SourceStore;
  ingress:IngressService;
  parseCaptureBundle:(body:unknown)=>CaptureInput[];
  notesSource:NotesSourceAssembly;
  notesCapture?:NotesCapture;
}

export const captureFeatureServiceMembers = ['sources','ingress','parseCaptureBundle','notesSource','notesCapture'] as const satisfies readonly (keyof CaptureFeatureServices)[];
