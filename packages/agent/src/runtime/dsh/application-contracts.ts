import type {EvidenceDependencies} from '@mote/shared';
import type {QueryInput} from '../../types.js';

/** Potential native persistence, distinct from model-delivered/citable evidence.
 * A receipt is retained before bytes leave the Host even if ACK/run later fails. */
export interface NativeApplicationExposure {
  readonly version: 1;
  readonly evidenceDependencies: EvidenceDependencies;
  /** Actual original bodies/pixels cannot borrow a Memory's retained-body proof. */
  readonly originalEvidenceIds: readonly string[];
  readonly sourceContextDependencies: readonly {sourceId: string; version: number; fingerprint: string}[];
  readonly memoryPins: readonly {id: string; fingerprint: string; version?: number}[];
  readonly interactionId?: string;
  readonly interactionFingerprint?: string;
  /** A past Host-verified restriction, never a retained permission grant. */
  readonly grantScope?: {kind:'all'|'selection';sourceIds?:string[];evidenceIds?:string[];after?:string;before?:string;deviceId?:string;timeZone?:string};
  readonly history?: NonNullable<QueryInput['historyContext']>;
}

/** Prepared by the real Mote conversation/model authorization consumer, never
 * accepted in the public query DTO or interpreted from model/native output. */
export interface NativeApplicationContext {
  readonly conversationId: string;
  readonly interactionId: string;
  readonly initialExposures: readonly NativeApplicationExposure[];
  captureExposure(receipt: NativeApplicationExposure): NativeApplicationExposure;
  assertExposure(receipt: NativeApplicationExposure): void;
}

/** Host-only private state/receipt lifecycle. The provider still creates a new
 * immutable run channel and model lease for every interaction. */
export interface NativeDshApplication {
  readonly sessionId: string;
  readonly home: string;
  readonly workspace: string;
  prepare(seed: NativeApplicationExposure): Promise<void>;
  retainExposure(receipt: NativeApplicationExposure): Promise<void>;
  assertCurrent(): void;
  /** Called only after the SDK child is closed and Host output was accepted. */
  finish(): Promise<void>;
  /** Releases admission after child quiescence; never publishes late products. */
  release(): Promise<void>;
}
