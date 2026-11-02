import type {StopReason} from '@mote/plugin-api/contracts';

/** The source-facing platform chain, in the order its authority is retired.
 * Each member is the real platform; only the stop surface is used here. */
export interface SourcePlatformChain {
  readonly authorization:{quiesce(reason?:StopReason):void};
  readonly capture:{quiesce(reason?:StopReason):void;close():Promise<void>};
  readonly files:{close():Promise<void>};
  readonly source:{quiesce(reason?:StopReason):void;close():Promise<void>};
  readonly execution:{stop(reason?:StopReason):Promise<void>};
}

/** Ordered shutdown of the source-facing platform chain.
 *
 * C04 stops admitting new requests first; already accepted request pins stay
 * valid until their response release. C10A then stops new intake and drains
 * what it accepted before C11's borrows close. C09 is only quiesced here: fresh
 * admission stops, while its Memory authority stays valid until C05 has
 * interrupted and drained accepted execution work. Retiring C09 before C05
 * would turn a completing Memory operation into a permanent
 * `memory_authorization_revoked` failure instead of restartable interrupted
 * work, so the runtime is closed last. */
export async function closeSourcePlatforms(platforms:SourcePlatformChain,reason:StopReason='shutdown'):Promise<void>{
  platforms.authorization.quiesce(reason);
  platforms.capture.quiesce(reason);
  await platforms.capture.close();
  await platforms.files.close();
  platforms.source.quiesce(reason);
  await platforms.execution.stop(reason);
  await platforms.source.close();
}
