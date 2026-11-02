/** Declarative plugin view runtime: renders a strictly-parsed component spec
 * bound to the U01 contribution descriptor. The spec carries only declared
 * components, field references and command IDs — never executable callbacks,
 * SQL or URLs. Commands fire only through the host's typed invoker, gated by
 * the U02 view lifetime so stale-generation results are dropped. */
import React from 'react';
import { ViewLifetime } from '@mote/shared/plugin-view-lifetime';
import { strictDataArray, strictDataObject, isToken, type UiContributionDescriptor } from '@mote/shared/plugin-ui';

export const declarativeStates = ['pending', 'error', 'empty', 'unavailable'] as const;
export type DeclarativeState = typeof declarativeStates[number];
export type FieldFormat = 'text' | 'number' | 'date' | 'badge';
export interface FieldRef { readonly key: string; readonly labelKey?: string; readonly format?: FieldFormat }
export interface FormFieldSpec extends FieldRef { readonly input: 'text' | 'number' | 'boolean'; readonly required?: boolean }
export type DeclarativeComponent =
  | { readonly type: 'status'; readonly state: DeclarativeState; readonly textKey?: string }
  | { readonly type: 'list'; readonly itemKey: string; readonly fields: readonly FieldRef[] }
  | { readonly type: 'detail'; readonly fields: readonly FieldRef[] }
  | { readonly type: 'form'; readonly fields: readonly FormFieldSpec[]; readonly submitCommand?: string }
  | { readonly type: 'action'; readonly command: string; readonly labelKey: string };
export interface DeclarativeViewSpec { readonly components: readonly DeclarativeComponent[] }
export type DeclarativeRejection = { readonly reason: string; readonly path: string };

const MAX_COMPONENTS = 64, MAX_FIELDS = 32, MAX_ITEMS = 500;
const field = (input: unknown, path: string): FieldRef => {
  const o = strictDataObject(input, ['key', 'labelKey', 'format']);
  if (!isToken(o.key)) throw new Error(`${path}: field key must be a token`);
  if (o.format !== undefined && !['text', 'number', 'date', 'badge'].includes(o.format as string)) throw new Error(`${path}: unknown format`);
  return o as unknown as FieldRef;
};

/** Strict wire parsing: extra keys, executable values, oversized arrays and
 * undeclared command references are rejected with a located reason. */
export function parseDeclarativeView(input: unknown, descriptor: UiContributionDescriptor): DeclarativeViewSpec {
  const declared = new Set((descriptor.commands ?? []).map(c => c.id));
  const root = strictDataObject(input, ['components']);
  const components = strictDataArray(root.components, MAX_COMPONENTS).map((raw, i): DeclarativeComponent => {
    const path = `components[${i}]`;
    const c = strictDataObject(raw, ['type', 'state', 'textKey', 'itemKey', 'fields', 'submitCommand', 'command', 'labelKey']);
    switch (c.type) {
      case 'status':
        if (!declarativeStates.includes(c.state as DeclarativeState)) throw new Error(`${path}: unknown state`);
        return { type: 'status', state: c.state, textKey: c.textKey } as DeclarativeComponent;
      case 'list':
        if (!isToken(c.itemKey)) throw new Error(`${path}: itemKey must be a token`);
        return { type: 'list', itemKey: c.itemKey, fields: strictDataArray(c.fields, MAX_FIELDS).map((f, j) => field(f, `${path}.fields[${j}]`)) };
      case 'detail':
        return { type: 'detail', fields: strictDataArray(c.fields, MAX_FIELDS).map((f, j) => field(f, `${path}.fields[${j}]`)) };
      case 'form': {
        const fields = strictDataArray(c.fields, MAX_FIELDS).map((f, j) => {
          const o = strictDataObject(f, ['key', 'labelKey', 'input', 'required']);
          if (!isToken(o.key) || !['text', 'number', 'boolean'].includes(o.input as string)) throw new Error(`${path}.fields[${j}]: invalid form field`);
          return o as unknown as FormFieldSpec;
        });
        if (c.submitCommand !== undefined && !declared.has(c.submitCommand as string)) throw new Error(`${path}: undeclared submitCommand`);
        return { type: 'form', fields, submitCommand: c.submitCommand as string | undefined };
      }
      case 'action':
        if (!isToken(c.command) || !declared.has(c.command as string)) throw new Error(`${path}: undeclared action command`);
        return { type: 'action', command: c.command, labelKey: c.labelKey } as DeclarativeComponent;
      default: throw new Error(`${path}: unknown component type`);
    }
  });
  return { components };
}

export type CommandInvoker = (command: { id: string; apiVersion: string }, input?: unknown) => Promise<unknown>;

/** One declarative view session: reads/callbacks are gated by the issuing
 * lifetime generation so a hidden or remounted view never applies stale
 * results, and commands resolve only declared IDs. */
export class DeclarativeViewSession {
  readonly descriptor: UiContributionDescriptor;
  readonly spec: DeclarativeViewSpec;
  readonly lifetime: ViewLifetime;
  #invoke: CommandInvoker;
  #commands = new Map<string, string>();

  constructor(descriptor: UiContributionDescriptor, spec: DeclarativeViewSpec, invoke: CommandInvoker, lifetime = new ViewLifetime()) {
    this.descriptor = descriptor; this.spec = spec; this.#invoke = invoke; this.lifetime = lifetime;
    for (const c of descriptor.commands ?? []) this.#commands.set(c.id, c.apiVersion);
  }

  /** Fire a declared command; results only apply while the issuing view
   * generation is still current — a hidden view drops the late answer. */
  async command(id: string, input?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'undeclared' | 'stale' | 'failed' }> {
    const apiVersion = this.#commands.get(id);
    if (apiVersion === undefined) return { ok: false, reason: 'undeclared' };
    const generation = this.lifetime.generation, signal = this.lifetime.viewSignal;
    if (signal.aborted) return { ok: false, reason: 'stale' };
    try {
      const value = await this.#invoke({ id, apiVersion }, input);
      if (!this.lifetime.admits(generation)) return { ok: false, reason: 'stale' };
      return { ok: true, value };
    } catch { return { ok: false, reason: 'failed' }; }
  }
}

const fieldValue = (row: Record<string, unknown>, ref: FieldRef): React.ReactNode => {
  const v = row[ref.key];
  if (v === null || v === undefined) return '—';
  if (ref.format === 'badge') return <span className="badge">{String(v)}</span>;
  if (ref.format === 'date') return new Date(String(v)).toLocaleDateString();
  return String(v);
};

/** Render one spec into React nodes. Only declared commands are wired;
 * results flow through the session's generation gate. */
export function DeclarativeView({ session, data, translate, onResult }: {
  session: DeclarativeViewSession;
  data?: Record<string, unknown>;
  translate: (key: string) => string;
  onResult?: (command: string, ok: boolean) => void;
}) {
  const t = (k?: string) => (k ? translate(k) : '');
  const run = (id: string, input?: unknown) => {
    const generation = session.lifetime.generation;
    // Stale outcomes never reach onResult: only results admitted by the
    // issuing generation may update the view.
    void session.command(id, input).then(r => { if ((r.ok || r.reason !== 'stale') && session.lifetime.admits(generation)) onResult?.(id, r.ok); });
  };
  return <>
    {session.spec.components.map((c, i) => {
      switch (c.type) {
        case 'status': return <p key={i} role="status" className={`declarative-status ${c.state}`}>{t(c.textKey) || c.state}</p>;
        case 'list': {
          const raw = data?.[c.itemKey];
          // Absent data is pending; a malformed present array is an explicit
          // error state — never a render crash.
          if (raw === undefined) return <p key={i} role="status" className="declarative-status pending">{t() || 'pending'}</p>;
          const rows = (() => { try { return strictDataArray(raw, MAX_ITEMS) as Record<string, unknown>[]; } catch { return null; } })();
          if (rows === null) return <p key={i} role="status" className="declarative-status error">{t() || 'error'}</p>;
          if (rows.length === 0) return <p key={i} role="status" className="declarative-status empty">{t() || 'empty'}</p>;
          return <ul key={i} className="declarative-list">{rows.map((row, j) => <li key={j}>{c.fields.map((f, k) => <span key={k}>{t(f.labelKey)}{fieldValue(row, f)} </span>)}</li>)}</ul>;
        }
        case 'detail': return <dl key={i} className="declarative-detail">{c.fields.map((f, k) => <div key={k}><dt>{t(f.labelKey) || f.key}</dt><dd>{fieldValue(data ?? {}, f)}</dd></div>)}</dl>;
        case 'form': return <form key={i} className="declarative-form" onSubmit={e => {
          e.preventDefault();
          if (!c.submitCommand) return;
          const input: Record<string, unknown> = {};
          for (const f of c.fields) {
            const el = e.currentTarget.elements.namedItem(f.key) as HTMLInputElement | null;
            // Serialize per declared input type: checked for booleans, a
            // numeric conversion for numbers, the raw string for text.
            input[f.key] = f.input === 'boolean' ? el?.checked === true
              : f.input === 'number' ? (el?.value === '' || el === null ? undefined : Number(el.value))
              : el?.value;
          }
          run(c.submitCommand, input);
        }}>
          {c.fields.map((f, k) => <label key={k}>{t(f.labelKey) || f.key}<input name={f.key} type={f.input === 'boolean' ? 'checkbox' : f.input === 'number' ? 'number' : 'text'} required={f.required} /></label>)}
          {c.submitCommand && <button type="submit">{t('submit') || 'submit'}</button>}
        </form>;
        case 'action': return <button key={i} className="declarative-action" onClick={() => run(c.command)}>{t(c.labelKey) || c.command}</button>;
      }
    })}
  </>;
}
