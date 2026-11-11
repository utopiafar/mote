import { z } from 'zod';

const timestamp = z.string().max(64).datetime({ offset: true });

/** One explicit user-started meeting. This is local session evidence, not a
 *  vendor recording selection and not a note attachment. */
export const meetingRecordingSessionSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  startedAt: timestamp,
  endedAt: timestamp,
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  microphone: z.boolean(),
  systemAudio: z.boolean(),
  noticeAcknowledgedAt: timestamp,
  platform: z.enum(['macos', 'android']),
  warnings: z.array(z.string().max(500)).max(20).default([]),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) ctx.addIssue({ code: 'custom', message: 'A meeting cannot end before it starts' });
  if (!value.microphone && !value.systemAudio) ctx.addIssue({ code: 'custom', message: 'A meeting recording needs at least one captured audio source' });
});

export type MeetingRecordingSession = z.infer<typeof meetingRecordingSessionSchema>;

/** Bounded untrusted evidence stored with the uploaded original. */
export const meetingRecordingProvenanceSchema = z.object({
  version: z.literal(1),
  startedAt: timestamp,
  endedAt: timestamp,
  durationMs: z.number().int().min(0),
  microphone: z.boolean(),
  systemAudio: z.boolean(),
  noticeAcknowledgedAt: timestamp,
  platform: z.enum(['macos', 'android']),
  warnings: z.array(z.string().max(500)).max(20).default([]),
}).strict();

export type MeetingRecordingProvenance = z.infer<typeof meetingRecordingProvenanceSchema>;
