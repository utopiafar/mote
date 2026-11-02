import {pluginErrorCodes, type PluginErrorCode} from './errors.js';
import {invalid, object, oneOf, schema, type Parser} from './schema.js';

export type UnavailableState = 'unavailable' | 'requires-build' | 'unsupported' | 'revoked' | 'waiting-device';
/** Independent of installed/desired/verified facts and of whether an upgrade requires restart. */
export type Availability = {readonly state: 'active'} | {readonly state: UnavailableState; readonly reason: PluginErrorCode};
export const parseAvailability: Parser<Availability> = (input, field) => {
  // Inspect only a data descriptor, so malformed DTOs cannot execute an accessor.
  const state = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'state')?.value : undefined;
  if (state === 'active') return object(input, field, {state: oneOf(['active'])});
  if (state === undefined) return invalid(field);
  return object(input, field, {state: oneOf(['unavailable', 'requires-build', 'unsupported', 'revoked', 'waiting-device']), reason: oneOf(pluginErrorCodes)});
};
export const availabilitySchema = schema(parseAvailability);
