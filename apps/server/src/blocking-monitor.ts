import {performance} from 'node:perf_hooks';

const sampleIntervalMs = 20;
const blockingThresholdMs = 50;
const jobLabels = [
  'assistant-changes',
  'assistant-followup',
  'assistant-onboarding',
  'assistant-routines',
  'material-organizer',
  'processing',
  'source-pipelines',
] as const;

export type BlockingJobLabel = typeof jobLabels[number];
type BlockingSample = {durationMs: number; jobLabels: BlockingJobLabel[]};

export function filterBlockingJobLabels(value: unknown): BlockingJobLabel[] | undefined {
  return Array.isArray(value) ? jobLabels.filter(label => value.includes(label)) : undefined;
}

const routeSegment = String.raw`(?:[a-z]+(?:-[a-z]+)*|v[0-9]+|:[A-Za-z][A-Za-z0-9_]*|\.well-known)`;
const routeTemplatePattern = new RegExp(`^(?:/${routeSegment})*(?:/\\*|/)?$`);

/** Accept the shape of a registered route. The host supplies only Fastify's route metadata. */
export function isDiagnosticRouteTemplate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && value.startsWith('/') && routeTemplatePattern.test(value);
}

export function createBlockingMonitor(record: (sample: BlockingSample) => void) {
  let deadline = performance.now() + sampleIntervalMs;
  const active = new Map<BlockingJobLabel, number>();
  const finishedAfterDeadline = new Set<BlockingJobLabel>();

  const timer = setInterval(() => {
    const now = performance.now();
    const durationMs = now - deadline;
    deadline = now + sampleIntervalMs;
    if (durationMs > blockingThresholdMs) {
      record({durationMs, jobLabels: jobLabels.filter(label => active.has(label) || finishedAfterDeadline.has(label))});
    }
    finishedAfterDeadline.clear();
  }, sampleIntervalMs).unref();

  return {
    run<T>(label: BlockingJobLabel, work: () => T): T {
      active.set(label, (active.get(label) ?? 0) + 1);
      const finish = () => {
        const count = active.get(label)!;
        if (count === 1) active.delete(label);
        else active.set(label, count - 1);
        // A synchronous job can finish before the overdue timer gets to run.
        if (performance.now() >= deadline) finishedAfterDeadline.add(label);
      };

      let pending = false;
      try {
        const result = work();
        if (result instanceof Promise) {
          void result.then(finish, finish);
          pending = true;
        }
        return result;
      } finally {
        if (!pending) finish();
      }
    },
    close() {
      clearInterval(timer);
    },
  };
}
