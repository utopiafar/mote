/** Desktop plugin-host declarative model: the complete five-component wire
 * schema shared with the web renderer and Kotlin mirror — same strictness,
 * same field metadata. Kept renderer-free so the Mac host validates a
 * contribution's declared components before wiring a consumer. */
import { strictDataArray, strictDataObject, isToken, type UiContributionDescriptor } from '@mote/shared/plugin-ui';

export interface DesktopFieldRef { readonly key: string; readonly labelKey?: string; readonly format?: 'text' | 'number' | 'date' | 'badge' }
export interface DesktopFormField extends DesktopFieldRef { readonly input: 'text' | 'number' | 'boolean'; readonly required?: boolean }
export type DesktopDeclarativeComponent =
  | { readonly type: 'status'; readonly state: 'pending' | 'error' | 'empty' | 'unavailable'; readonly textKey?: string }
  | { readonly type: 'list'; readonly itemKey: string; readonly fields: readonly DesktopFieldRef[] }
  | { readonly type: 'detail'; readonly fields: readonly DesktopFieldRef[] }
  | { readonly type: 'form'; readonly fields: readonly DesktopFormField[]; readonly submitCommand?: string }
  | { readonly type: 'action'; readonly command: string; readonly labelKey?: string };

const optToken = (o: Record<string, unknown>, name: string, path: string): void => {
  if (o[name] !== undefined && (typeof o[name] !== 'string' || !isToken(o[name]))) throw new Error(`${path}: ${name} must be a token string`);
};
const fields = (input: unknown, path: string): readonly DesktopFieldRef[] =>
  strictDataArray(input, 32).map((raw, j) => {
    const f = strictDataObject(raw, ['key', 'labelKey', 'format']);
    if (!isToken(f.key)) throw new Error(`${path}[${j}]: key must be a token`);
    if (f.format !== undefined && !['text', 'number', 'date', 'badge'].includes(f.format as string)) throw new Error(`${path}[${j}]: unknown format`);
    optToken(f, 'labelKey', `${path}[${j}]`);
    return f as unknown as DesktopFieldRef;
  });
const formFields = (input: unknown, path: string): readonly DesktopFormField[] =>
  strictDataArray(input, 32).map((raw, j) => {
    const f = strictDataObject(raw, ['key', 'labelKey', 'input', 'required']);
    if (!isToken(f.key) || !['text', 'number', 'boolean'].includes(f.input as string)) throw new Error(`${path}[${j}]: invalid form field`);
    if (f.required !== undefined && typeof f.required !== 'boolean') throw new Error(`${path}[${j}]: required must be boolean`);
    optToken(f, 'labelKey', `${path}[${j}]`);
    return f as unknown as DesktopFormField;
  });

export function parseDesktopDeclarative(input: unknown, descriptor: UiContributionDescriptor): readonly DesktopDeclarativeComponent[] {
  const declared = new Set((descriptor.commands ?? []).map(c => c.id));
  const root = strictDataObject(input, ['components']);
  return strictDataArray(root.components, 64).map((raw, i): DesktopDeclarativeComponent => {
    const path = `components[${i}]`;
    const c = strictDataObject(raw, ['type', 'state', 'textKey', 'itemKey', 'fields', 'submitCommand', 'command', 'labelKey']);
    switch (c.type) {
      case 'status':
        if (!['pending', 'error', 'empty', 'unavailable'].includes(c.state as string)) throw new Error(`${path}: unknown state`);
        optToken(c, 'textKey', path);
        return c as DesktopDeclarativeComponent;
      case 'list':
        if (!isToken(c.itemKey)) throw new Error(`${path}: itemKey required`);
        return { type: 'list', itemKey: c.itemKey as string, fields: fields(c.fields, `${path}.fields`) };
      case 'detail':
        return { type: 'detail', fields: fields(c.fields, `${path}.fields`) };
      case 'form': {
        const parsed = formFields(c.fields, `${path}.fields`);
        if (c.submitCommand !== undefined && !declared.has(c.submitCommand as string)) throw new Error(`${path}: undeclared submitCommand`);
        return { type: 'form', fields: parsed, submitCommand: c.submitCommand as string | undefined };
      }
      case 'action':
        if (!isToken(c.command) || !declared.has(c.command as string)) throw new Error(`${path}: undeclared command`);
        optToken(c, 'labelKey', path);
        return c as DesktopDeclarativeComponent;
      default: throw new Error(`${path}: unknown component type`);
    }
  });
}
