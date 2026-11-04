import type {FastifyRequest} from 'fastify';
import type {FilesFeatureSource} from '../features/files.js';
import type {FileEvidence} from '../file-evidence.js';
import type {FileStore} from '../files.js';

/** C11 files members. */
export interface FilesFeatureServices {
  files:FileStore;
  fileEvidence:FileEvidence;
  setPlaybackAuthorization:(authorize:(request:FastifyRequest)=>boolean)=>void;
  filesSource?:FilesFeatureSource;
}

export const filesFeatureServiceMembers = ['files','fileEvidence','setPlaybackAuthorization','filesSource'] as const satisfies readonly (keyof FilesFeatureServices)[];
