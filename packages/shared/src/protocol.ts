import { z } from 'zod';

/** Wire compatibility is independent of every product's release version. */
export const MOTE_PROTOCOL_RANGE = Object.freeze({ min: 1, max: 1 });
export const MOTE_PROTOCOL_HEADER = 'X-Mote-Protocol-Version';
export const MOTE_PROTOCOL_HEADERS = Object.freeze({ [MOTE_PROTOCOL_HEADER]: String(MOTE_PROTOCOL_RANGE.max) });
export const protocolRangeSchema = z.object({
  min: z.number().int().min(1).max(2147483647),
  max: z.number().int().min(1).max(2147483647),
}).strict().refine(value => value.min <= value.max, 'Protocol range is reversed');
export type ProtocolRange = z.infer<typeof protocolRangeSchema>;

export class ProtocolCompatibilityError extends Error {
  constructor(readonly code: 'invalid_protocol_range' | 'incompatible_protocol') {
    super(code);
  }
}

/** Missing metadata is the existing v1 API, with its existing endpoint guards. */
export function requireCompatibleProtocol(value: unknown, supported: Readonly<ProtocolRange> = MOTE_PROTOCOL_RANGE): ProtocolRange {
  const parsed = protocolRangeSchema.safeParse(value === undefined ? MOTE_PROTOCOL_RANGE : value);
  if (!parsed.success) throw new ProtocolCompatibilityError('invalid_protocol_range');
  if (Math.max(parsed.data.min, supported.min) > Math.min(parsed.data.max, supported.max)) throw new ProtocolCompatibilityError('incompatible_protocol');
  return parsed.data;
}
