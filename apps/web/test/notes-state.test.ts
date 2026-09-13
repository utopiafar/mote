import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NoteOutbox, type NoteStorage } from '../src/notes-state.js';
class MemoryStorage implements NoteStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, value); }
  removeItem(key: string) { this.entries.delete(key); }
}
const note = () => ({ id: randomUUID(), deviceId: 'web:synthetic-fixture', deviceName: 'Synthetic notes fixture', platform: 'import' as const, capturedAt: '2026-09-12T12:00:00.000Z', text: '  合成原文\n不改写。 ', mood: '用户自行标注' });

test('draft and immutable pending notes survive reopening, separately per central node', () => {
  const storage = new MemoryStorage(); const outbox = new NoteOutbox(storage, 'https://node-a.example'); const event = note();
  outbox.saveDraft({ text: '  草稿\n ', mood: '' }); outbox.enqueue(event);
  const reopened = new NoteOutbox(storage, 'https://node-a.example');
  assert.deepEqual(reopened.draft(), { text: '  草稿\n ', mood: '' }); assert.deepEqual(reopened.items()[0].note, event);
  assert.deepEqual(new NoteOutbox(storage, 'https://node-b.example').items(), []);
});
test('two views append without replacing each other and identical retries do not alter original events', () => {
  const storage = new MemoryStorage(), a = new NoteOutbox(storage, 'same-node'), b = new NoteOutbox(storage, 'same-node');
  const first = note(), second = note(); a.enqueue(first); b.enqueue(second); a.enqueue(first);
  assert.equal(a.items().length, 2);
  assert.throws(() => b.enqueue({ ...first, text: 'conflicting text' }), /ID/);
  b.mark(first.id, 'HTTP 409', true); assert.deepEqual(a.items().find(item => item.note.id === first.id)?.note, first);
});
test('only a matching central ACK removes local content; offline errors leave evidence intact', () => {
  const storage = new MemoryStorage(), outbox = new NoteOutbox(storage, 'node'), event = note(); outbox.enqueue(event);
  outbox.mark(event.id, 'offline', false); assert.equal(outbox.items()[0].error, 'offline');
  assert.throws(() => outbox.acknowledge(event.id, { id: randomUUID() }), /ID/); assert.equal(outbox.items().length, 1);
  outbox.acknowledge(event.id, { id: event.id }); assert.equal(outbox.items().length, 0);
  outbox.mark(event.id, 'late failing response', true); assert.equal(outbox.items().length, 0, 'late failures do not resurrect an acknowledged event');
});
test('invalid or exhausted local storage never claims successful persistence and preserves existing entries', () => {
  const storage = new MemoryStorage(), outbox = new NoteOutbox(storage, 'node');
  outbox.enqueue(note()); const original = [...storage.entries];
  const failing = new NoteOutbox({ get length() { return storage.length; }, key: i => storage.key(i), getItem: key => storage.getItem(key), setItem() { throw new Error('quota'); }, removeItem: key => storage.removeItem(key) }, 'node');
  assert.throws(() => failing.enqueue(note()), /quota/); assert.deepEqual([...storage.entries], original);
  assert.throws(() => outbox.enqueue({ ...note(), text: '  ' }));
});
test('corrupt local event is retained and reported instead of silently disappearing', () => {
  const storage = new MemoryStorage(), outbox = new NoteOutbox(storage, 'node'); outbox.enqueue(note());
  const key = [...storage.entries.keys()][0]; storage.setItem(key, '{broken');
  assert.throws(() => outbox.items(), /损坏/); assert.equal(storage.getItem(key), '{broken');
});


test('a crash before draft clearing reuses the exact submission, even after its central ACK', () => {
  const storage = new MemoryStorage(), outbox = new NoteOutbox(storage, 'node');
  const original = note(), draft = { text: original.text, mood: original.mood };
  outbox.saveDraft(draft);
  const prepared = outbox.prepareSubmission(draft, original);
  outbox.enqueue(prepared);
  const reopened = new NoteOutbox(storage, 'node');
  assert.deepEqual(reopened.prepareSubmission(reopened.draft(), note()), prepared);
  reopened.enqueue(reopened.prepareSubmission(reopened.draft(), note()));
  assert.equal(reopened.items().length, 1);
  reopened.acknowledge(prepared.id, { id: prepared.id });
  // A lost draft-clear write must not generate a different ID after an ACK.
  const afterAck = new NoteOutbox(storage, 'node');
  const retried = afterAck.prepareSubmission(afterAck.draft(), note());
  assert.deepEqual(retried, prepared);
  afterAck.enqueue(retried); afterAck.completeSubmission(retried.id);
  assert.deepEqual(afterAck.draft(), { text: '', mood: '' });
});

test('draft edits invalidate prepared identity while intentional later identical notes remain distinct', () => {
  const storage = new MemoryStorage(), outbox = new NoteOutbox(storage, 'node');
  const draft = { text: '合成原文', mood: '' };
  const first = outbox.prepareSubmission(draft, note());
  outbox.saveDraft(draft);
  assert.equal(outbox.prepareSubmission(draft, note()).id, first.id, 'unchanged autosave retains identity');
  const changed = { ...draft, mood: '用户更改的心情' };
  outbox.saveDraft(changed);
  const second = outbox.prepareSubmission(changed, note());
  assert.notEqual(second.id, first.id);
  outbox.completeSubmission(first.id);
  assert.deepEqual(outbox.draft(), changed, 'a late completion cannot erase a newer draft');
  outbox.completeSubmission(second.id);
  const third = outbox.prepareSubmission(changed, note());
  assert.notEqual(third.id, second.id, 'a new intentional note may repeat exactly the same text');
});

test('failed draft clearing retains its submission ID without losing queued content', () => {
  const storage = new MemoryStorage(), outbox = new NoteOutbox(storage, 'node');
  const draft = { text: '合成待同步', mood: '' }, prepared = outbox.prepareSubmission(draft, note());
  outbox.enqueue(prepared);
  const failedClear = new NoteOutbox({
    get length() { return storage.length; }, key: i => storage.key(i), getItem: key => storage.getItem(key),
    setItem() { throw new Error('write failed'); }, removeItem: key => storage.removeItem(key),
  }, 'node');
  assert.throws(() => failedClear.completeSubmission(prepared.id), /write failed/);
  assert.equal(outbox.items().length, 1);
  assert.equal(outbox.prepareSubmission(outbox.draft(), note()).id, prepared.id);
});
