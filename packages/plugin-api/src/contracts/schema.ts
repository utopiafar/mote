import {PluginContractError} from './errors.js';

export interface ContractSchema<T> { parse(input: unknown): T }
export type Parser<T> = (input: unknown, field: string) => T;
export const invalid = (field: string): never => { throw new PluginContractError('invalid_contract', field); };
export const schema = <T>(parse: Parser<T>): ContractSchema<T> => ({parse: input => parse(input, '$')});

/** Strict plain data only; accessors/classes/symbol fields must not be evaluated as DTOs. */
export function object<T>(input: unknown, field: string, shape: {[K in keyof T]-?: Parser<T[K]>}): T {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid(field);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return invalid(field);
  const properties = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(properties).some(key => typeof key !== 'string' || !Object.hasOwn(shape, key) || !('value' in properties[key]!))) return invalid(field);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(shape) as Array<keyof T & string>) {
    const value = shape[key](properties[key]?.value, `${field}.${key}`);
    if (value !== undefined) result[key] = value;
  }
  return result as T;
}
export const optional = <T>(parse: Parser<T>): Parser<T | undefined> => (input, field) => input === undefined ? undefined : parse(input, field);
export const token: Parser<string> = (input, field) => typeof input === 'string' && /^[\x21-\x7e]{1,256}$/.test(input) ? input : invalid(field);
/** Exact identifiers, not semver ranges or fallback negotiations. */
export const apiVersion: Parser<string> = (input, field) => typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(input) ? input : invalid(field);
export const integer: Parser<number> = (input, field) => typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : invalid(field);
export const boolean: Parser<boolean> = (input, field) => typeof input === 'boolean' ? input : invalid(field);
export const oneOf = <T extends string>(values: readonly T[]): Parser<T> => (input, field) => typeof input === 'string' && values.includes(input as T) ? input as T : invalid(field);
export const version: Parser<1> = (input, field) => {
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) return invalid(field);
  if (input !== 1) throw new PluginContractError('unsupported_contract_version', field);
  return input;
};
export function array<T>(parse: Parser<T>, maximum: number): Parser<T[]> {
  return (input, field) => {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > maximum) return invalid(field);
    const properties = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(properties).length !== input.length + 1) return invalid(field);
    const result: T[] = [];
    for (let index = 0; index < input.length; index++) {
      const descriptor = properties[String(index)];
      if (!descriptor || !('value' in descriptor)) return invalid(`${field}[${index}]`);
      result.push(parse(descriptor.value, `${field}[${index}]`));
    }
    return result;
  };
}
