import {appendFileSync} from 'node:fs';

/** Append one machine-readable observation. The trace path is owned by the test. */
export function trace(event, details = {}) {
  const path = process.env.PROBE_TRACE;
  if (!path) return;
  appendFileSync(path, `${JSON.stringify({event, ...details, pid: process.pid})}\n`);
}
