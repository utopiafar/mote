// One current diagnostics policy, shared by Central and its native supervisor.
export const MiB = 1024 * 1024;
export const MAX_LOG_FILE_BYTES = 100 * MiB;
export const MAX_TRACE_EVENT_BYTES = 8 * MiB;
export const LOG_CHANNELS = Object.freeze(['error', 'warn', 'info', 'debug', 'trace']);
export const DEFAULT_LOG_RETENTION = Object.freeze({
  error: {
    days: 30,
    maxBytes: 128 * MiB
  },
  warn: {
    days: 14,
    maxBytes: 64 * MiB
  },
  info: {
    days: 7,
    maxBytes: 256 * MiB
  },
  debug: {
    days: 2,
    maxBytes: 128 * MiB
  },
  trace: {
    days: 1,
    maxBytes: 1024 * MiB
  }
});
export function defaultLogMaxBytes() {
  return 16 * MiB;
}
export class LogRetentionError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
    this.name = 'LogRetentionError';
  }
}
export function logRetentionFromDocument(document) {
  const d = document.diagnostics ?? {};
  const number = (field, value, fallback, min, max, integer = false) => {
    const n = value === undefined ? fallback : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || integer && !Number.isInteger(n)) throw new LogRetentionError('diagnostics.' + field, 'Invalid diagnostics.' + field);
    return n;
  };
  const retention = {};
  for (const channel of LOG_CHANNELS) {
    const value = d.retention?.[channel] ?? {},
      defaults = DEFAULT_LOG_RETENTION[channel];
    retention[channel] = {
      days: number('retention.' + channel + '.days', value.days, defaults.days, 1 / 24, 3650),
      maxBytes: Math.floor(number('retention.' + channel + '.maxBytes', value.maxBytes, defaults.maxBytes, 1024, 8 * 1024 * MiB))
    };
  }
  return {
    maxBytes: Math.floor(number('maxBytes', d.maxBytes, defaultLogMaxBytes(), Math.floor(.1 * MiB), MAX_LOG_FILE_BYTES)),
    maxEntries: number('maxEntries', d.maxEntries, 2000, 100, 5000, true),
    maxTotalBytes: Math.floor(number('maxTotalBytes', d.maxTotalBytes, 2048 * MiB, 1024, 16 * 1024 * MiB)),
    retention,
    source: d.maxBytes === undefined ? 'profile-default' : 'explicit'
  };
}
export function logRetentionFromEnv(env, profile) {
  return logRetentionFromDocument({
    server: {
      profile
    },
    diagnostics: {
      ...(env.MOTE_LOG_MAX_MB === undefined || env.MOTE_LOG_MAX_MB === 'auto' ? {} : {
        maxBytes: Number(env.MOTE_LOG_MAX_MB) * MiB
      }),
      ...(env.MOTE_LOG_MAX_ENTRIES === undefined ? {} : {
        maxEntries: Number(env.MOTE_LOG_MAX_ENTRIES)
      })
    }
  });
}
