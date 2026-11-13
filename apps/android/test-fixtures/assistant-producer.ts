import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {QueryScope} from '@mote/shared';
import type {buildApp} from '../../server/src/app.js';
import {TaskRecords} from '../../server/src/task-records.js';
import type {MatterAuthority} from '../../server/src/assistant-matters.js';

/** Serialized production domain output for transports not exposed by the
 * baseline yet. Existing routes are exercised over HTTP by the Kotlin runner.
 * This file does not install a test-only route or fabricate a matching DTO. */
export async function assistantProducer(node: Awaited<ReturnType<typeof buildApp>>, directory: string, token: string) {
  const {assistantCards: cards, assistantMatters: matters, assistantCommitments: commitments} = node.featureServices;
  const tasks = new TaskRecords(node.store);
  const authority: MatterAuthority = {
    currentEvidence: ids => node.store.evidence([...ids]).map(row => ({id: row.id, title: row.windowTitle || row.appName,
      sourceId: row.provenance?.sourceId, deviceId: row.deviceId, at: row.capturedAt})),
    currentTask: id => { try { return tasks.get(id); } catch { return undefined; } },
  };
  const items = [];
  for (const kind of ['work', 'life']) {
    const evidenceId = randomUUID(), body = `Generated ${kind} source: a preparation decision still needs review.`;
    const note = await node.app.inject({method: 'POST', url: '/api/notes', headers: {authorization: 'Bearer ' + token}, payload: {
      id: evidenceId, deviceId: 'generated-kotlin-assistant', deviceName: 'Generated phone', platform: 'android', capturedAt: '2026-11-01T00:00:00Z', text: body,
    }});
    assert.equal(note.statusCode, 201, 'Generated assistant note intake');
    const scope: QueryScope = {kind: 'selection', evidenceIds: [evidenceId]};
    const matter = matters.command({type: 'create', requestId: randomUUID(), goal: `Generated ${kind} matter`, scope, evidenceIds: [evidenceId]}, authority);
    const cardId = randomUUID();
    const publication = {id: cardId, kind: 'suggestion' as const, matterId: matter.id, version: 'one', state: 'open' as const,
      title: `Generated ${kind} preparation`, body: `Generated ${kind} observation, relevance and offered help`, evidence: [{id: evidenceId, quote: body}],
      evidenceDependencies: {version: 1 as const, complete: true, ids: [evidenceId]}};
    const first = cards.publish(publication, undefined, scope, () => {});
    const updated = cards.publish({...publication, version: 'two', body: `Generated ${kind} later update`}, first.revision, scope, () => {});
    const request = {requestId: randomUUID(), goal: `Generated ${kind} owner goal`, scope};
    const ref = {cardId, expectedRevision: updated.revision};
    const accepted = node.assistantTasks.acceptSuggestion(request, ref, authority);
    const replay = node.assistantTasks.acceptSuggestion(request, ref, authority);
    assert.equal(accepted.id, replay.id, 'Production acceptance retry keeps one task');
    const commitment = commitments.publish({commitmentId: randomUUID(), eventId: randomUUID(), kind: 'commitment', occurredAt: null,
      summary: body, changes: {title: `Generated ${kind} commitment`, status: 'confirmed', deadline: {text: 'Generated approximate deadline', at: null}, matterId: matter.id},
      evidence: [{id: evidenceId, quote: body, offset: 0}], evidenceDependencies: {version: 1, complete: true, ids: [evidenceId]}}, undefined, scope, () => {});
    const routine = node.assistantRoutines.create({requestId: randomUUID(), goal: `Generated ${kind} daily review`, scope, timeZone: 'Asia/Shanghai',
      trigger: {kind: 'daily', localTime: '09:00'}, matterId: matter.id});
    items.push({kind, scope, cardId, evidenceId, taskId: accepted.id, matter: matters.detail(matter.id, authority), commitment, routine});
  }
  const path = join(directory, 'generated-assistant-projections.json');
  await writeFile(path, JSON.stringify({items}), {mode: 0o600});
  return path;
}
