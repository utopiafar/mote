import {z} from 'zod';
import {routineLocalTimeSchema,routineTimeZoneSchema} from './routines-time.js';

/** Assistant alerts use the existing owner configuration transaction. These
 * settings do not control capture notifications or create any authorization. */
export const notificationSettingsSchema=z.object({
 enabled:z.boolean().default(true),
 timeZone:routineTimeZoneSchema.default('UTC'),
 quietHours:z.object({start:routineLocalTimeSchema,end:routineLocalTimeSchema}).strict()
  .refine(value=>value.start!==value.end,{message:'Quiet hours need different start and end times'}).nullable().default(null),
 minIntervalMinutes:z.number().int().min(1).max(10080).default(60),
}).strict();
export type NotificationSettings=z.infer<typeof notificationSettingsSchema>;
