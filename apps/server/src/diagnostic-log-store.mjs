import { constants, lstatSync, chmodSync } from 'node:fs';
import { mkdir, open, readdir, rename, lstat, unlink, statfs, link } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LOG_CHANNELS, logRetentionFromDocument, MAX_LOG_FILE_BYTES } from './log-retention-config.mjs';
const pattern = /^(central|supervisor)\.(error|warn|info|debug|trace)\.(\d{13})\.(\d{13})\.([a-f0-9-]{36})\.ndjson$/;
const priority = ['trace', 'debug', 'info', 'warn', 'error'];
const lockProtocol = JSON.stringify({protocol:'mote-retention-sqlite'}) + '\n';
const offlineRecovery = 'Diagnostic retention lock unavailable; existing retention.lock requires offline recovery after all log writers are stopped';

/** Publish a complete, immutable protocol marker. It remains in place between
 * operations so an old wx/PID writer cannot enter through a different mutex.
 * Unknown/legacy locks are never removed, even if empty, old or apparently dead. */
async function retentionProtocol(directory) {
  const path = join(directory, 'retention.lock');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    return info.isFile() && info.size === Buffer.byteLength(lockProtocol) && await handle.readFile('utf8') === lockProtocol;
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'EISDIR') return false;
    if (error.code !== 'ENOENT') throw error;
  } finally {
    await handle?.close();
  }
  const temporary = join(directory, 'retention.' + randomUUID() + '.tmp');
  let candidate, created = false;
  try {
    candidate = await open(temporary, 'wx', 0o600);
    created = true;
    await candidate.writeFile(lockProtocol);
    await candidate.sync();
    await candidate.close();candidate = undefined;
    // link is create-if-absent. Neither a partial marker nor an overwrite is
    // visible at retention.lock; a crash leaves at most an unused private temp.
    try { await link(temporary, path); return true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; return false; }
  } finally {
    try { await candidate?.close(); }
    finally { if (created) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}

/** A zero-byte, persistent SQLite file needs no schema, journal or owner data.
 * BEGIN IMMEDIATE holds its OS-backed reserved lock until rollback/close/death.
 * Never unlink it or open/close it outside SQLite: POSIX close would release
 * another connection's process locks. Creation is performed by SQLite itself. */
function retentionMutex(directory) {
  const path = join(directory, 'retention-mutex.sqlite');
  const inspect = () => {
    let info;
    try { info = lstatSync(path); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isFile() || info.nlink !== 1 || info.size !== 0 || process.getuid && info.uid !== process.getuid()) throw Error('Invalid diagnostic retention mutex');
    return info;
  };
  const prior = inspect();
  const database = new DatabaseSync(path, {timeout:0});
  try {
    const current = inspect();
    if (!current || prior && (prior.dev !== current.dev || prior.ino !== current.ino)) throw Error('Diagnostic retention mutex changed');
    if ((current.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    return database;
  } catch (error) { database.close(); throw error; }
}
const conflict = () => Object.assign(new Error('Log cleanup selection changed; preview again'), {
  statusCode: 409
});
/** Both writers use the same short directory lock. No append handle survives it;
 * cleanup can never unlink a file while another writer has it open for append. */
export class DiagnosticLogStore {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.family = options.family ?? 'central';
    if (!['central', 'supervisor'].includes(this.family)) throw Error('Invalid log family');
    const defaults = logRetentionFromDocument({});
    this.policy = {
      ...defaults,
      ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
      retention: {
        ...defaults.retention,
        ...options.retention
      }
    };
    this.now = options.now ?? (() => new Date());
    this.serial = Promise.resolve();
    this.files = [];
    this.lastCleanup = null;
    this.deletedFiles = 0;
    this.deletedBytes = 0;
    this.dropped = 0;
    this.diskPressure = false;
    this.current = new Map();
    this.otherBytes = 0;
  }
  exclusive(task) {
    const result = this.serial.then(async () => {
      await mkdir(this.directory, {
        recursive: true,
        mode: 0o700
      });
      let database, acquired = false, protocol = false;
      try {
        for (let attempt = 0; attempt < 500; attempt++) {
          protocol = await retentionProtocol(this.directory);
          if (protocol) {
            database ??= retentionMutex(this.directory);
            try { database.exec('BEGIN IMMEDIATE'); acquired = true; break; }
            catch (error) { if (error.code !== 'ERR_SQLITE_ERROR' || error.errcode !== 5) throw error; }
          }
          // A synchronous busy timeout would block another writer on this same
          // event loop from finishing its asynchronous filesystem operations.
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!acquired) throw Error(protocol ? 'Diagnostic retention lock unavailable' : offlineRecovery);
        return await task();
      } finally {
        try { if (acquired) database.exec('ROLLBACK'); }
        finally { database?.close(); }
      }
    });
    this.serial = result.catch(() => {});
    return result;
  }
  async inventory() {
    const files = [];
    this.otherBytes = 0;
    for (const name of await readdir(this.directory)) {
      const m = pattern.exec(name);
      if (!m) {
        if (/\.(?:log|ndjson|gz|tmp)$/.test(name) || ['central.lock', 'retention.lock', 'retention-mutex.sqlite', 'retention-state.json'].includes(name)) {
          try {
            const s = await lstat(join(this.directory, name));
            if (s.isFile()) this.otherBytes += s.size;
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }
        }
        continue;
      }
      try {
        const f = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const s = await f.stat();
          if (s.isFile() && (s.mode & 0o777) !== 0o600) await f.chmod(0o600);
          if (s.isFile()) files.push({
            name,
            family: m[1],
            channel: m[2],
            firstAt: new Date(Number(m[3])).toISOString(),
            lastAt: new Date(Number(m[4])).toISOString(),
            bytes:s.size,modifiedAt:s.mtimeMs
          });
        } finally {
          await f.close();
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    files.sort((a, b) => b.lastAt.localeCompare(a.lastAt)||(b.modifiedAt??0)-(a.modifiedAt??0)||b.name.localeCompare(a.name));
    this.files = files;
    return files;
  }
  async readState() {
    let file;
    try {
      file = await open(join(this.directory, 'retention-state.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      if ((await file.stat()).size > 1024) return null;
      const v = JSON.parse(await file.readFile('utf8')).lastCleanup;
      if (v && ['expired', 'channel_capacity', 'total_capacity', 'disk_pressure', 'manual'].includes(v.reason) && LOG_CHANNELS.includes(v.channel) && typeof v.at === 'string' && /^\d{4}-\d\d-\d\dT/.test(v.at) && Number.isFinite(Date.parse(v.at)) && Number.isSafeInteger(v.files) && v.files >= 0 && Number.isSafeInteger(v.bytes) && v.bytes >= 0) return {
        at: v.at,
        reason: v.reason,
        channel: v.channel,
        files: v.files,
        bytes: v.bytes
      };
      return null;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    } finally {
      await file?.close();
    }
  }
  async init() {
    await this.exclusive(async () => {
      await this.inventory();
      this.lastCleanup = await this.readState();
      await this.prune();
      if (this.deletedFiles) await this.saveState();
    });
  }
  async remove(file, reason) {
    try {
      await unlink(join(this.directory, file.name));
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    this.files = this.files.filter(f => f.name !== file.name);
    for (const [channel, current] of this.current) if (current.name === file.name) this.current.delete(channel);
    this.deletedFiles++;
    this.deletedBytes += file.bytes;
    this.lastCleanup = {
      at: this.now().toISOString(),
      reason,
      channel: file.channel,
      files: this.deletedFiles,
      bytes: this.deletedBytes
    };
  }
  async prune(incoming) {
    const now = this.now().getTime();
    for (const file of [...this.files]) if (Date.parse(file.lastAt) <= now - this.policy.retention[file.channel].days * 86400000) await this.remove(file, 'expired');
    for (const channel of LOG_CHANNELS) {
      let bytes = this.files.filter(f => f.channel === channel).reduce((n, f) => n + f.bytes, 0) + (incoming?.channel === channel ? incoming.bytes : 0);
      for (const file of [...this.files].reverse().filter(f => f.channel === channel)) {
        if (bytes <= this.policy.retention[channel].maxBytes) break;
        await this.remove(file, 'channel_capacity');
        bytes -= file.bytes;
      }
    }
    let bytes = this.files.reduce((n, f) => n + f.bytes, 0) + this.otherBytes + Math.min(4096, Math.floor(this.policy.maxTotalBytes / 4)) + (incoming?.bytes ?? 0);
    for (const channel of priority) for (const file of [...this.files].reverse().filter(f => f.channel === channel && (!incoming || priority.indexOf(channel) <= priority.indexOf(incoming.channel)))) {
      if (bytes <= this.policy.maxTotalBytes) break;
      await this.remove(file, 'total_capacity');
      bytes -= file.bytes;
    }
    // Free disk is an independent bound. Reserve space for tiny failure summaries.
    const fs = await statfs(this.directory);
    this.diskPressure = fs.bavail * fs.bsize < (this.policy.minFreeBytes ?? 1024 * 1024 * 1024);
    if (this.diskPressure) for (const file of [...this.files].reverse().filter(f => f.channel === 'trace' || f.channel === 'debug')) await this.remove(file, 'disk_pressure');
    return this.files.reduce((n, f) => n + f.bytes, 0) + this.otherBytes + Math.min(4096, Math.floor(this.policy.maxTotalBytes / 4)) + (incoming?.bytes ?? 0) <= this.policy.maxTotalBytes;
  }
  async append(records) {
    return this.exclusive(async () => {
      const written = [];
      await this.inventory();
      await this.prune();
      for (const record of records) {
        const {
          channel,
          line,
          at
        } = record;
        if (!LOG_CHANNELS.includes(channel) || !Number.isFinite(Date.parse(at)) || !line.endsWith('\n')) throw Error('Invalid diagnostic record');
        const bytes = Buffer.byteLength(line),
          limit = Math.min(this.policy.maxBytes, this.policy.retention[channel].maxBytes, this.policy.maxTotalBytes);
        if (bytes > limit || this.diskPressure && (channel === 'trace' || channel === 'debug')) {
          this.dropped++;
          written.push(null);
          continue;
        }
        if (!(await this.prune({
          channel,
          bytes
        }))) {
          this.dropped++;
          written.push(null);
          continue;
        }
        let current = this.current.get(channel);
        if (!current) current = this.files.find(f => f.family === this.family && f.channel === channel);
        if (current && !this.files.some(f => f.name === current.name)) current = undefined;
        if (current) {
          const tail = await open(join(this.directory, current.name), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const byte = Buffer.alloc(1);
            const size = (await tail.stat()).size;
            if (size && (await tail.read(byte, 0, 1, size - 1)).bytesRead && byte[0] !== 10) current = undefined;
          } finally {
            await tail.close();
          }
        }
        if (current && (current.bytes + bytes > limit || current.lastAt.slice(0, 10) !== at.slice(0, 10))) current = undefined;
        const time = Date.parse(at),
          first = current ? Math.min(time, Date.parse(current.firstAt)) : time,
          last = Math.max(time, current ? Date.parse(current.lastAt) : time),
          id = current ? pattern.exec(current.name)[5] : randomUUID();
        const name = [this.family, channel, first, last, id, 'ndjson'].join('.'),
          path = join(this.directory, current?.name ?? name);
        let modifiedAt;
        const file = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          await file.chmod(0o600);
          await file.writeFile(line);modifiedAt=(await file.stat()).mtimeMs;
        } finally {
          await file.close();
        }
        if (current && current.name !== name) await rename(path, join(this.directory, name));
        const next = {
          name,
          family: this.family,
          channel,
          firstAt: new Date(first).toISOString(),
          lastAt: new Date(last).toISOString(),
          bytes:(current?.bytes??0)+bytes,modifiedAt
        };
        this.files = this.files.filter(f => f.name !== current?.name && f.name !== name);
        this.files.unshift(next);
        this.files.sort((a, b) => b.lastAt.localeCompare(a.lastAt)||(b.modifiedAt??0)-(a.modifiedAt??0)||b.name.localeCompare(a.name));
        this.current.set(channel, next);
        written.push(id);
      }
      await this.prune();
      await this.saveState();
      return written;
    });
  }
  async saveState() {
    const previous = await this.readState();
    if (previous && (!this.lastCleanup || previous.at > this.lastCleanup.at)) this.lastCleanup = previous;
    const path = join(this.directory, 'retention-state.json'),
      temp = path + '.tmp';
    const before = await lstat(path).then(s => s.isFile() ? s.size : 0, e => {
      if (e.code === 'ENOENT') return 0;
      throw e;
    });
    const text = JSON.stringify({
      lastCleanup: this.lastCleanup
    });
    const file = await open(temp, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(text);
    } finally {
      await file.close();
    }
    await rename(temp, path);
    this.otherBytes += Buffer.byteLength(text) - before;
  }
  async refresh() {
    await this.exclusive(async () => {
      await this.inventory();
      await this.prune();
      await this.saveState();
    });
    return this.snapshot();
  }
  snapshot() {
    return {
      totalBytes: this.files.reduce((n, f) => n + f.bytes, 0) + this.otherBytes,
      unmanagedBytes: this.otherBytes,
      maxTotalBytes: this.policy.maxTotalBytes,
      files: this.files.map((f, index) => ({
        ...f,
        index
      })),
      channels: LOG_CHANNELS.map(channel => {
        const files = this.files.filter(f => f.channel === channel);
        return {
          channel,
          ...this.policy.retention[channel],
          bytes: files.reduce((n, f) => n + f.bytes, 0),
          oldestAt: files.length ? files.reduce((a, f) => f.firstAt < a ? f.firstAt : a, files[0].firstAt) : null,
          newestAt: files[0]?.lastAt ?? null
        };
      }),
      lastCleanup: this.lastCleanup,
      deletedFiles: this.deletedFiles,
      deletedBytes: this.deletedBytes,
      droppedEvents: this.dropped,
      diskPressure: this.diskPressure
    };
  }
  async preview(kind) {
    if (!['trace', 'all'].includes(kind)) throw Error('Invalid cleanup kind');
    return this.exclusive(async () => {
      await this.inventory();
      const files = this.files.filter(f => kind === 'all' || f.channel === 'trace').map(f => ({
        ...f
      }));
      return {
        kind,
        files,
        bytes: files.reduce((n, f) => n + f.bytes, 0),
        oldestAt: files.length ? files.reduce((value, file) => file.firstAt < value ? file.firstAt : value, files[0].firstAt) : null,
        newestAt: files[0]?.lastAt ?? null
      };
    });
  }
  async clear(plan) {
    if (!plan || !['trace', 'all'].includes(plan.kind) || !Array.isArray(plan.files) || plan.files.length > 100000) throw conflict();
    return this.exclusive(async () => {
      await this.inventory();
      const selected = [],
        seen = new Set();
      for (const file of plan.files) {
        if (!file || seen.has(file.name) || !pattern.test(file.name) || plan.kind === 'trace' && !file.name.startsWith('central.trace.') && !file.name.startsWith('supervisor.trace.')) throw conflict();
        const actual = this.files.find(f => f.name === file.name);
        if (!actual || actual.bytes !== file.bytes || actual.firstAt !== file.firstAt || actual.lastAt !== file.lastAt) throw conflict();
        seen.add(file.name);
        selected.push(actual);
      }
      for (const file of selected) await this.remove(file, 'manual');
      await this.saveState();
      return {
        deletedFiles: selected.length,
        deletedBytes: selected.reduce((n, f) => n + f.bytes, 0)
      };
    });
  }
  settled() {
    return this.serial;
  }
  async read(index, read, missing) {
    const opened = await this.exclusive(async () => {
      await this.inventory();
      if (typeof index === 'number' ? !Number.isSafeInteger(index) || index < 0 : !pattern.test(index) && !/^[a-f0-9-]{36}$/.test(index)) throw Object.assign(new Error('Invalid log file'), {
        statusCode: 400
      });
      const info = typeof index === 'number' ? this.files[index] : this.files.find(f => f.name === index || f.name.split('.')[4] === index);
      if (!info) return null;
      const file = await open(join(this.directory, info.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const s = await file.stat();
        if (s.size > MAX_LOG_FILE_BYTES) throw Error('Log exceeds read limit');
        return {
          file,
          size: s.size
        };
      } catch (e) {
        await file.close();
        throw e;
      }
    });
    if (!opened) return missing();
    try {
      return await read(opened.file, opened.size);
    } finally {
      await opened.file.close();
    }
  }
}
