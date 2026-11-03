import type {Cancellation} from '@mote/plugin-api/contracts';

export const HOST_RUN_PHASES = ['prepare', 'idle', 'running', 'closing', 'closed'] as const;
export type HostRunPhase = (typeof HOST_RUN_PHASES)[number];

/** One-way gate for runtime-originated event commits. A controlled
 * cancellation or shutdown releases it before abort listeners run, so a
 * provider cannot commit a tool, attempt terminal or usage sample from the
 * cancellation turn or after it. The Host's own final terminal is emitted
 * outside this gate because it records the cancellation outcome itself. */
export class HostRunEventBarrier {
  private open = true;

  get released(): boolean { return !this.open; }

  release(): void { this.open = false; }

  /** Run the commit only while the barrier is open. */
  commit<T>(commit: () => T): {readonly committed: true; readonly value: T} | {readonly committed: false} {
    if (!this.open) return {committed: false};
    return {committed: true, value: commit()};
  }
}

export function createHostRunEventBarrier(): HostRunEventBarrier {
  return new HostRunEventBarrier();
}

/** Single state owner for one Host run. The first cancellation cause wins; all
 * later cancellation points still release the event barrier but cannot replace
 * the original classification. */
export class HostRunLifecycle {
  private currentPhase: HostRunPhase = 'prepare';
  private cancellationCause?: Cancellation;
  private readonly barrier = new HostRunEventBarrier();

  get phase(): HostRunPhase { return this.currentPhase; }
  get cancellation(): Cancellation | undefined { return this.cancellationCause; }
  get eventsOpen(): boolean { return !this.barrier.released; }

  setPhase(phase: HostRunPhase): void {
    this.currentPhase = phase;
  }

  /** Record a controlled cancellation. The barrier is released before the
   * caller aborts its signal or starts cleanup, so later runtime events are
   * already excluded when abort listeners execute. */
  cancel(cause: Cancellation): Cancellation {
    this.cancellationCause ??= Object.freeze({...cause});
    this.barrier.release();
    return this.cancellationCause;
  }

  /** Release the barrier for a non-cancellation shutdown or failed run. */
  releaseEvents(): void { this.barrier.release(); }

  commitEvent<T>(commit: () => T): T | undefined {
    const result = this.barrier.commit(commit);
    return result.committed ? result.value : undefined;
  }
}

export function createHostRunLifecycle(): HostRunLifecycle {
  return new HostRunLifecycle();
}
