import type {BuiltinWebPlugin} from '../types';

/**
 * The reader package owns exact evidence reading: typed route identity,
 * pinned Material revisions, bounded page/range continuation, archived file
 * bytes and explicitly requested audio. It contributes no standalone page or
 * collection; the shell consumes these entries inside the existing reader
 * surfaces.
 */
export const reader: BuiltinWebPlugin = {id: 'mote.reader'};

export {ReferenceDetail} from './ReferenceDetail';
export {SourceDocumentDetails} from './SourceDocumentDetails';
export {ArchivedFileReader} from './ArchivedFileReader';
export {ArchivedAudio} from './ArchivedAudio';
export {changeEvidenceRoute,evidenceRoute,readEvidenceRoute} from './evidence-route';
