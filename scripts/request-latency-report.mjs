import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { filterBlockingJobLabels, isDiagnosticRouteTemplate } from '../apps/server/src/blocking-monitor.ts';

const centralSegment = /^central\.(?:debug|info|warn|error)\.\d{13}\.\d{13}\.([a-f0-9-]{36})\.ndjson$/;

async function openCentralSegment(directory, name, id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await open(join(directory, name), 'r');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // The writer can rename a segment on append. Its ID is stable.
      name = (await readdir(directory)).find(entry => centralSegment.exec(entry)?.[1] === id);
      if (!name) return;
    }
  }
  throw new Error('Diagnostic segment changed while opening');
}

async function* logSegments(path) {
  const info = await stat(path);
  if (info.isFile()) {
    yield await open(path, 'r');
    return;
  }
  if (!info.isDirectory()) throw new Error('Expected a diagnostic log file or directory');

  for (const entry of await readdir(path, { withFileTypes: true })) {
    const segment = entry.isFile() && centralSegment.exec(entry.name);
    if (!segment) continue;
    const file = await openCentralSegment(path, entry.name, segment[1]);
    if (file) yield file;
  }
}

function overlappingBlocks(requests, blocks, p95Ms) {
  const slow = requests.filter(request => request.durationMs >= p95Ms).sort((a, b) => a.start - b.start);
  const latestEnd = new Map();
  let next = 0;
  return blocks.filter(block => {
    // Blocks are sorted by end time. Consider each slow request once per route.
    while (next < slow.length && slow[next].start <= block.end) {
      const { instanceId, end } = slow[next++];
      latestEnd.set(instanceId, Math.max(end, latestEnd.get(instanceId) ?? -Infinity));
    }
    return (latestEnd.get(block.instanceId) ?? -Infinity) >= block.start;
  }).map(({ durationMs, jobLabels }) => ({ durationMs, jobLabels }));
}

async function requestLatencyReport(path) {
  const requestsByRoute = new Map();
  const blocks = [];

  for await (const file of logSegments(path)) {
    try {
      const { size } = await file.stat();
      if (!size) continue;
      for await (const line of file.readLines({ end: size - 1 })) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.event !== 'request.completed' && record?.event !== 'event-loop.blocked') continue;
        const { at, instanceId, durationMs, routeTemplate } = record;
        if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > Number.MAX_SAFE_INTEGER) continue;
        const end = typeof at === 'string' ? Date.parse(at) : NaN;
        if (!Number.isFinite(end)) continue;
        const interval = { start: end - durationMs, end, instanceId, durationMs };
        if (record.event === 'event-loop.blocked') {
          blocks.push({ ...interval, jobLabels: filterBlockingJobLabels(record.jobLabels) ?? [] });
        } else if (isDiagnosticRouteTemplate(routeTemplate)) {
          if (!requestsByRoute.has(routeTemplate)) requestsByRoute.set(routeTemplate, []);
          requestsByRoute.get(routeTemplate).push(interval);
        }
      }
    } finally {
      await file.close();
    }
  }

  blocks.sort((a, b) => a.end - b.end);
  return [...requestsByRoute].sort(([a], [b]) => a.localeCompare(b)).map(([routeTemplate, requests]) => {
    const durations = requests.map(request => request.durationMs).sort((a, b) => a - b);
    const p50Ms = durations[Math.ceil(durations.length * 0.5) - 1];
    const p95Ms = durations[Math.ceil(durations.length * 0.95) - 1];
    return {
      routeTemplate, p50Ms, p95Ms,
      maxMs: durations.at(-1),
      overlappingBlocks: overlappingBlocks(requests, blocks, p95Ms),
    };
  });
}

if (process.argv.length !== 3) {
  console.error('Run node scripts/request-latency-report.mjs <diagnostic-log-path>');
  process.exitCode = 1;
} else {
  try {
    const report = await requestLatencyReport(process.argv[2]);
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.error('Unable to read the diagnostic logs.');
    process.exitCode = 1;
  }
}
