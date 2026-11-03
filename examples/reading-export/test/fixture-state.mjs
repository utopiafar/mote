/** Test-only StateStore fixture. It implements the public SDK contract; the
 * production host binds the real instance namespace and table. */
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {StateError} from '@mote/plugin-sdk';

export function createFixtureStateStore({file} = {}) {
  const records = new Map();
  if (file && existsSync(file))
    for (const record of JSON.parse(readFileSync(file, 'utf8'))) records.set(record.key, record);

  const persist = () => {
    if (!file) return;
    mkdirSync(dirname(file), {recursive: true, mode: 0o700});
    writeFileSync(file, JSON.stringify([...records.values()], null, 2), {mode: 0o600});
  };

  return {
    get(key) {
      const record = records.get(key);
      return Promise.resolve(record ? structuredClone(record) : undefined);
    },
    list(prefix = '', limit = 100) {
      const values = [...records.values()]
        .filter(record => record.key.startsWith(prefix))
        .sort((left, right) => left.key.localeCompare(right.key))
        .slice(0, limit)
        .map(record => structuredClone(record));
      return Promise.resolve(values);
    },
    compareAndSet(key, expectedRevision, value) {
      const current = records.get(key);
      if (expectedRevision === null) {
        if (current) return Promise.reject(new StateError('conflict'));
        const record = {key, value: structuredClone(value), revision: 1, bytes: Buffer.byteLength(JSON.stringify(value)),
          updatedAt: new Date().toISOString()};
        records.set(key, record);
        persist();
        return Promise.resolve(structuredClone(record));
      }
      if (!current) return Promise.reject(new StateError('not_found'));
      if (current.revision !== expectedRevision) return Promise.reject(new StateError('conflict'));
      const record = {...current, value: structuredClone(value), revision: current.revision + 1,
        bytes: Buffer.byteLength(JSON.stringify(value)), updatedAt: new Date().toISOString()};
      records.set(key, record);
      persist();
      return Promise.resolve(structuredClone(record));
    },
    checkpoint() {
      const values = [...records.values()].sort((left, right) => left.key.localeCompare(right.key));
      return Promise.resolve({
        digest: createHash('sha256').update(JSON.stringify(values.map(record => [record.key, record.revision, record.value]))).digest('hex'),
        bytes: values.reduce((sum, record) => sum + record.bytes, 0),
        records: values.length,
      });
    },
  };
}
