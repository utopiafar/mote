import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateProcess } from '../../../test-fixtures/native-plugins/process.mjs';
import { generatedNote } from '../../../test-fixtures/native-plugins/runs.mjs';

// G1 shortest server journey through the real startup entry (src/index.ts in a
// private generated profile): no hand-assembled buildApp internals.
test('plugin architecture startup: owner auth, note original and restart reread', { timeout: 90000 }, async t => {
  const run = await createPrivateProcess();
  t.after(async () => { await run.close({ strict:false }); });

  // Owner authentication on the real loopback listener.
  assert.equal((await fetch(run.url + '/api/status')).status, 401);
  const status = await run.request('/api/status') as { storage?:{ captures?:number } };
  assert.equal(typeof status.storage?.captures, 'number');

  const note = generatedNote('startup-contract');
  const written = await run.writeNote(note) as { receipt?:{ state?:string } };
  assert.equal(written.receipt?.state, 'received');
  assert.equal((await run.readNote(note.id) as { ocrText?:string }).ocrText, note.text);

  const stopped = await run.stop();
  assert.equal(stopped.exited, true);
  assert.equal(stopped.code, 0);

  await run.restart();
  assert.equal((await run.readNote(note.id) as { ocrText?:string }).ocrText, note.text);
  assert.equal((await fetch(run.url + '/api/status')).status, 401);
  await run.close();
});
