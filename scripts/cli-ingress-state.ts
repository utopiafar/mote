import type {SourceSync} from '../apps/desktop/src/source-sync.js';

/** Open only the current CLI outbox format. Old states and their private originals
 * remain untouched and require an explicit backup/reset. */
export async function initializeCliIngressState(_statePath:string,engine:SourceSync):Promise<void> {
  await engine.initialize();
}
