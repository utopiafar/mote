/** Desktop plugin-host declarative model: the same strictly-parsed spec the
 * Web renderer consumes, kept renderer-free here so the Mac host can validate
 * a contribution's declared components before wiring a consumer. The parsing
 * contract matches plugin-host/declarative-view (web) exactly. */
import { strictDataArray, strictDataObject, isToken, type UiContributionDescriptor } from '@mote/shared/plugin-ui';

export type DesktopDeclarativeComponent =
  | { readonly type: 'status'; readonly state: 'pending' | 'error' | 'empty' | 'unavailable'; readonly textKey?: string }
  | { readonly type: 'list'; readonly itemKey: string; readonly fields: readonly string[] }
  | { readonly type: 'detail'; readonly fields: readonly string[] }
  | { readonly type: 'form'; readonly fields: readonly string[]; readonly submitCommand?: string }
  | { readonly type: 'action'; readonly command: string; readonly labelKey?: string };

/** Minimal structural validation for the desktop host: declared component
 * types and declared command references only; rendering consumes the web
 * spec model shared by contract. */
export function parseDesktopDeclarative(input: unknown, descriptor: UiContributionDescriptor): readonly DesktopDeclarativeComponent[] {
  const declared = new Set((descriptor.commands ?? []).map(c => c.id));
  const root = strictDataObject(input, ['components']);
  return strictDataArray(root.components, 64).map((raw, i) => {
    const c = strictDataObject(raw, ['type', 'state', 'textKey', 'itemKey', 'fields', 'submitCommand', 'command', 'labelKey', 'input', 'required']);
    switch (c.type) {
      case 'status':
        if (!['pending', 'error', 'empty', 'unavailable'].includes(c.state as string)) throw new Error(`components[${i}]: unknown state`);
        return c as DesktopDeclarativeComponent;
      case 'list': case 'detail': {
        strictDataArray(c.fields, 32).forEach((f, j) => { if (!isToken((f as Record<string, unknown>)?.key)) throw new Error(`components[${i}].fields[${j}]: token required`); });
        if (c.type === 'list' && !isToken(c.itemKey)) throw new Error(`components[${i}]: itemKey required`);
        return { type: c.type, itemKey: c.itemKey, fields: (c.fields as { key: string }[]).map(f => f.key) } as DesktopDeclarativeComponent;
      }
      case 'form': {
        strictDataArray(c.fields, 32).forEach((f, j) => {
          const o = f as Record<string, unknown>;
          if (!isToken(o?.key) || !['text', 'number', 'boolean'].includes(o.input as string)) throw new Error(`components[${i}].fields[${j}]: invalid form field`);
        });
        if (c.submitCommand !== undefined && !declared.has(c.submitCommand as string)) throw new Error(`components[${i}]: undeclared submitCommand`);
        return { type: 'form', fields: (c.fields as { key: string }[]).map(f => f.key), submitCommand: c.submitCommand as string | undefined };
      }
      case 'action':
        if (!isToken(c.command) || !declared.has(c.command as string)) throw new Error(`components[${i}]: undeclared command`);
        return c as DesktopDeclarativeComponent;
      default: throw new Error(`components[${i}]: unknown component type`);
    }
  });
}
