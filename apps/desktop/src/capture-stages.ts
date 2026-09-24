import { createHash } from 'node:crypto';
import { extendState, stateOnly } from '@mote/shared/state-series';
import type { CaptureEvent } from './contracts';

export interface CapturePacket { event: CaptureEvent; image?: Buffer; reviewHeld?: boolean }
export interface StageCheckpoint { version: number; value?: unknown; held: boolean }
export interface CapturePipelineCheckpoint {
  version: 1; order: string[]; stages: Record<string, StageCheckpoint>;
  heldPrivacy?: { activity: boolean; redacted: boolean; reviewHeld: boolean };
  lastInputTransaction?: string;
}
export interface StageContext {
  readonly flush: boolean;
  /** Stable UUID for split or merged outputs; member IDs and key are chosen by the stage. */
  deriveId(memberIds: readonly string[], key: string): string;
}
export interface CaptureStage {
  readonly id: string;
  readonly version: number;
  /** JSON configuration is part of the durable checkpoint identity. */
  readonly configuration?: unknown;
  /** Held input must be JSON metadata/text only; the host rejects held image bytes. */
  consume(inputs: readonly CapturePacket[], checkpoint: unknown, context: StageContext): { outputs: CapturePacket[]; checkpoint?: unknown; held: boolean };
}

function deterministicId(stage: CaptureStage, members: readonly string[], key: string): string {
  if (!members.length || members.length > 64 || members.some(id => !/^[0-9a-f-]{36}$/i.test(id)) || !key || key.length > 128) throw new Error('Invalid stage output identity');
  const hex = createHash('sha256').update(JSON.stringify([stage.id, stage.version, stage.configuration??null, members, key])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The host persists the returned checkpoint with every output before accepting another input. */
export class CaptureStageRegistry {
  private readonly stages: CaptureStage[] = [];
  register(stage: CaptureStage): this {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(stage.id) || !Number.isSafeInteger(stage.version) || stage.version < 1 || this.stages.some(value => value.id === stage.id)) throw new Error('Invalid or duplicate capture stage');
    this.stages.push(stage);
    return this;
  }
  versions(): ReadonlyArray<{ id: string; version: number }> { return this.stages.map(({ id, version }) => ({ id, version })); }
  consume(inputs: readonly CapturePacket[], previous?: CapturePipelineCheckpoint, flush = false): { outputs: CapturePacket[]; checkpoint: CapturePipelineCheckpoint } {
    const order = this.stages.map(stage => {
      const config=JSON.stringify(stage.configuration??null);
      if(Buffer.byteLength(config)>8192)throw new Error('Capture stage configuration exceeds 8 KiB');
      return `${stage.id}@${stage.version}:${createHash('sha256').update(config).digest('hex')}`;
    });
    if (previous && (previous.version !== 1 || !Array.isArray(previous.order) || !previous.stages)) throw new Error('Invalid capture pipeline checkpoint');
    if (previous && JSON.stringify(previous.order) !== JSON.stringify(order) && Object.values(previous.stages).some(state => state.held)) throw new Error('Capture pipeline version changed with held inputs; migration is required');
    const prior = previous && JSON.stringify(previous.order) === JSON.stringify(order) ? previous.stages : {};
    const states: Record<string, StageCheckpoint> = {};
    let outputs = [...inputs];
    for (const stage of this.stages) {
      const state = prior[stage.id];
      if (state && (state.version !== stage.version || typeof state.held !== 'boolean')) throw new Error('Invalid capture stage checkpoint');
      const result = stage.consume(outputs, state?.value, { flush, deriveId: (members, key) => deterministicId(stage, members, key) });
      if (!result || !Array.isArray(result.outputs) || result.outputs.length > 64 || typeof result.held !== 'boolean') throw new Error('Invalid capture stage result');
      outputs = result.outputs;
      states[stage.id] = { version: stage.version, value: result.checkpoint, held: result.held };
    }
    const checkpoint: CapturePipelineCheckpoint = { version: 1, order, stages: states };
    const encoded = JSON.stringify(checkpoint);
    if (!encoded || Buffer.byteLength(encoded) > 1_000_000) throw new Error('Capture stage checkpoint exceeds 1 MiB');
    return { outputs, checkpoint: JSON.parse(encoded) as CapturePipelineCheckpoint };
  }
}

export function builtInCaptureStages(): CaptureStageRegistry {
  return new CaptureStageRegistry().register({
    id: 'state-series', version: 1,
    consume(inputs, checkpoint) {
      let head = (checkpoint as { head?: CaptureEvent } | undefined)?.head;
      const outputs = inputs.map(packet => {
        const event = extendState(head, packet.event);
        head = stateOnly(event) ? event : undefined;
        return { ...packet, event };
      });
      return { outputs, checkpoint: head ? { head } : {}, held: false };
    },
  });
}
