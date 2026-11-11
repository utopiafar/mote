import assert from 'node:assert/strict';
import test from 'node:test';
import {meetingRecordingSessionSchema} from '../dist/meeting-recording.js';

const valid = {
  version: 1, id: '11111111-1111-4111-8111-111111111111',
  startedAt: '2026-11-11T09:00:00Z', endedAt: '2026-11-11T09:30:00Z',
  durationMs: 1_800_000, microphone: true, systemAudio: true,
  noticeAcknowledgedAt: '2026-11-11T08:59:00Z', platform: 'macos', warnings: [],
};

test('one meeting session is one bounded audio record with explicit capture sides', () => {
  assert.doesNotThrow(() => meetingRecordingSessionSchema.parse(valid));
  assert.throws(() => meetingRecordingSessionSchema.parse({...valid, microphone: false, systemAudio: false}));
  assert.throws(() => meetingRecordingSessionSchema.parse({...valid, endedAt: '2026-11-11T08:00:00Z'}));
  assert.throws(() => meetingRecordingSessionSchema.parse({...valid, platform: 'windows'}));
});
