import {createHash} from 'node:crypto';
import {validateJsonSchemaValue, type JsonSchemaNode} from '@deepseek-ai/dsh-tools';
import type {RuntimeToolIdentity} from '../runtime/contracts.js';
import {
  canonicalJson,
  defineToolDescriptor,
  isPlainRecord,
  TOOL_SNAPSHOT_SCHEMA_VERSION,
  toolContractError,
  toolFingerprint,
  type ToolDescriptor,
  type ToolSelection,
  type ToolSnapshotEntry,
} from './descriptor.js';
import type {HostReadOperation, HostSessionPort} from './host-session.js';
import {toolInputSchema} from './runtime-schema.js';

/** Registration lifecycle supplied by the parent. The signal and callback are
 * checked by every local liveness assertion, before I/O and after the await. */
export interface ToolLifecycle {
  readonly signal?: AbortSignal;
  readonly assertCurrent?: () => void;
}

interface Registration {
  readonly descriptor: ToolDescriptor;
  readonly fingerprint: string;
  readonly token: symbol;
  readonly lifecycle: ToolLifecycle;
  /** The same compiled schema the runtime adapters publish. */
  readonly schema: JsonSchemaNode;
}

/** Serializable snapshot body. It is a pure DTO: no callback, token, reader or
 * other local capability can be serialized from it. */
export interface ToolSnapshotWire {
  readonly schemaVersion: typeof TOOL_SNAPSHOT_SCHEMA_VERSION;
  readonly entries: readonly ToolSnapshotEntry[];
  readonly fingerprint: string;
}

/** Local snapshot handle. The enumerable wire fields serialize as a pure DTO
 * (see toJSON); assertActive/resolve are non-enumerable local capabilities
 * closed over the exact registrations this snapshot was taken from. `resolve`
 * is the parent execution entry and must never be wired. */
export interface ToolSnapshot extends ToolSnapshotWire {
  /** Local liveness: throws unless the exact registration that produced this
   * snapshot still owns the pin's name/version/fingerprint. */
  assertActive(pin: RuntimeToolIdentity): void;
  /** Local dispatch bound to the original registration. Not serializable. */
  resolve(pin: RuntimeToolIdentity): ResolvedTool;
  toJSON(): ToolSnapshotWire;
}

/** Parent-only execution entry. It carries no reader, ledger, sender, confirm
 * or discard; every read goes through the parent-bound HostSessionPort. */
export interface ResolvedTool {
  readonly identity: RuntimeToolIdentity;
  execute(args: Readonly<Record<string, unknown>>, port: HostSessionPort): Promise<unknown>;
}

export interface ToolSnapshotDiff {
  readonly added: readonly ToolSnapshotEntry[];
  readonly removed: readonly ToolSnapshotEntry[];
  readonly changed: readonly Readonly<{name: string; before: ToolSnapshotEntry; after: ToolSnapshotEntry}>[];
}

type SnapshotLike = Readonly<{entries: readonly ToolSnapshotEntry[]}>;

const byName = (left: {readonly name: string}, right: {readonly name: string}) => left.name.localeCompare(right.name);

function unknownTool(name: string): never {
  throw toolContractError('unknown_tool', 'No pinned capability has this exact name.', {name});
}

function invalidArguments(message: string, details: Record<string, unknown> = {}): never {
  throw toolContractError('invalid_tool_arguments', message, details);
}

function identityFor(registration: Registration): RuntimeToolIdentity {
  return {name: registration.descriptor.name, version: registration.descriptor.version, fingerprint: registration.fingerprint};
}

/** Wrap the parent port so a pack can reach only the operations it declared.
 * This is a refusal facade, not a grant: the parent port still performs the
 * fresh scope/grant checks for every admitted call. */
function restrictPort(port: HostSessionPort, registration: Registration): HostSessionPort {
  const allowed = registration.descriptor.requires;
  const deny = (operation: string): never => {
    throw toolContractError('tool_permission_denied', 'This tool did not declare the Host operation it attempted.', {name: registration.descriptor.name, operation});
  };
  return {
    tool: port.tool,
    scope: port.scope,
    signal: port.signal,
    assertCurrent: () => port.assertCurrent(),
    read: ((operation: HostReadOperation, ...args: unknown[]) => {
      if (!allowed.includes(operation)) deny(operation);
      return (port.read as unknown as (operation: HostReadOperation, ...args: unknown[]) => Promise<unknown>)(operation, ...args);
    }) as HostSessionPort['read'],
    actionCatalog: args => {
      if (!allowed.includes('actionCatalog')) deny('actionCatalog');
      return port.actionCatalog(args);
    },
    progress: message => {
      if (!allowed.includes('progress')) deny('progress');
      port.progress(message);
    },
  };
}

const entryChange = (entry: ToolSnapshotEntry) => canonicalJson({version: entry.version, fingerprint: entry.fingerprint, kind: entry.kind, exposure: entry.exposure, requires: [...entry.requires].sort()});

/** Compare two wire snapshots by name. Schema identity is covered by fingerprint;
 * kind/exposure/requires are compared explicitly because they change the
 * declared Host surface without changing the schema. */
export function diffToolSnapshots(before: SnapshotLike, after: SnapshotLike): ToolSnapshotDiff {
  const previous = new Map(before.entries.map(entry => [entry.name, entry]));
  const next = new Map(after.entries.map(entry => [entry.name, entry]));
  const added = after.entries.filter(entry => !previous.has(entry.name));
  const removed = before.entries.filter(entry => !next.has(entry.name));
  const changed = after.entries.flatMap(entry => {
    const old = previous.get(entry.name);
    return old && entryChange(old) !== entryChange(entry) ? [{name: entry.name, before: old, after: entry}] : [];
  });
  return Object.freeze({
    added: Object.freeze([...added].sort(byName)),
    removed: Object.freeze([...removed].sort(byName)),
    changed: Object.freeze([...changed].sort(byName)),
  });
}

/** One read-only contribution registry. It owns descriptions, explicit
 * selection, snapshots, local liveness and local dispatch only. It owns no
 * reader, store, grant table, ledger, discovered set, receipt, sender, confirm
 * or discard; the parent Host still decides every read and citation. */
export class ToolRegistry {
  private readonly entries = new Map<string, Registration>();

  /** Register one versioned descriptor and return its unregister function.
   * Names are unique so a runtime tool list cannot contain two definitions with
   * the same name; replacing a version requires unregistering first, which also
   * retires the old registration identity. */
  register(input: ToolDescriptor, lifecycle: ToolLifecycle = {}): () => void {
    const descriptor = defineToolDescriptor(input);
    const existing = this.entries.get(descriptor.name);
    if (existing) throw toolContractError('duplicate_tool', 'This tool name is already registered; unregister it before replacing its version.', {name: descriptor.name, version: existing.descriptor.version});
    const registration: Registration = Object.freeze({
      descriptor,
      fingerprint: toolFingerprint(descriptor.description, descriptor.fields, descriptor.kind, descriptor.exposure, descriptor.requires),
      token: Symbol(descriptor.name + '@' + descriptor.version),
      lifecycle: this.lifecycleFor(lifecycle),
      schema: toolInputSchema(descriptor.fields) as JsonSchemaNode,
    });
    this.entries.set(descriptor.name, registration);
    let removed = false;
    return () => {
      if (removed || this.entries.get(descriptor.name) !== registration) return;
      removed = true;
      this.entries.delete(descriptor.name);
    };
  }

  /** Remove the current registration for a name. A later registration with the
   * same name and version is a new identity and cannot revive an old snapshot. */
  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  /** All registrations as an explicit selection, sorted for display. Callers
   * still pass an explicit selection to snapshot(); this is not a run order. */
  registered(): ToolSelection {
    return Object.freeze([...this.entries.values()].sort((left, right) => byName(left.descriptor, right.descriptor)).map(registration => Object.freeze({name: registration.descriptor.name, version: registration.descriptor.version})));
  }

  /** Build one immutable snapshot for an explicit selection. Every selected
   * name/version must be registered exactly; a missing, unsupported or repeated
   * selection fails closed. Entry order is the selection order, never
   * registration order. */
  snapshot(selection: ToolSelection): ToolSnapshot {
    if (!Array.isArray(selection)) throw toolContractError('invalid_tool_selection', 'A tool selection must be an array of exact name/version pairs.');
    const seen = new Set<string>();
    const registrations = selection.map(({name, version}) => {
      if (typeof name !== 'string' || typeof version !== 'string') throw toolContractError('invalid_tool_selection', 'Every tool selection needs a string name and version.');
      if (seen.has(name)) throw toolContractError('invalid_tool_selection', 'A tool selection must not repeat a name.', {name});
      seen.add(name);
      const registration = this.entries.get(name);
      if (!registration) unknownTool(name);
      if (registration.descriptor.version !== version) throw toolContractError('tool_version_mismatch', 'Use the exact registered version of this capability.', {name, expected: registration.descriptor.version, received: version});
      return registration;
    });
    const entries = Object.freeze(registrations.map(registration => this.entryFor(registration)));
    const fingerprint = createHash('sha256').update(canonicalJson({
      schemaVersion: TOOL_SNAPSHOT_SCHEMA_VERSION,
      entries: entries.map(({name, version, fingerprint, kind, exposure, requires}) => ({name, version, fingerprint, kind, exposure, requires: [...requires].sort()})),
    })).digest('hex');
    const captured = new Map(registrations.map(registration => [registration.descriptor.name, registration]));
    const assertActive = (pin: RuntimeToolIdentity): void => {
      const registration = captured.get(pin.name);
      if (!registration || registration.descriptor.version !== pin.version || registration.fingerprint !== pin.fingerprint) {
        throw toolContractError('stale_tool_pin', 'This pin is not part of this snapshot.', {name: pin.name, version: pin.version});
      }
      if (this.entries.get(pin.name) !== registration) {
        throw toolContractError('stale_tool_pin', 'This capability registration was unloaded or replaced.', {name: pin.name, version: pin.version});
      }
      registration.lifecycle.signal?.throwIfAborted();
      registration.lifecycle.assertCurrent?.();
    };
    const resolve = (pin: RuntimeToolIdentity): ResolvedTool => {
      assertActive(pin);
      const registration = captured.get(pin.name)!;
      return Object.freeze({
        identity: Object.freeze(identityFor(registration)),
        async execute(args: Readonly<Record<string, unknown>>, port: HostSessionPort): Promise<unknown> {
          // Re-check before I/O and after the await. A result from an unloaded or
          // replaced registration must not reach the parent or the model.
          assertActive(pin);
          port.assertCurrent();
          if (!isPlainRecord(args)) invalidArguments('Tool arguments must be a plain object.');
          // The production validator runs against the same compiled schema the
          // runtime adapters publish, including const/oneOf/null and the closed
          // root, so an invalid call can never reach parse or execute.
          const violations = validateJsonSchemaValue(registration.schema, args);
          if (violations.length) throw toolContractError('invalid_tool_arguments', 'Capability arguments must match the discovered schema.', {violations: violations.slice(0, 8)});
          const parsed = registration.descriptor.parse(Object.freeze({...args}));
          if (!isPlainRecord(parsed)) invalidArguments('Tool parse must return a plain argument object.');
          const value = await registration.descriptor.execute(Object.freeze({...parsed}), restrictPort(port, registration));
          assertActive(pin);
          port.assertCurrent();
          return value;
        },
      });
    };
    const wire = () => Object.freeze({schemaVersion: TOOL_SNAPSHOT_SCHEMA_VERSION, entries, fingerprint});
    const snapshot = {schemaVersion: TOOL_SNAPSHOT_SCHEMA_VERSION, entries, fingerprint} as unknown as ToolSnapshot;
    Object.defineProperties(snapshot, {
      assertActive: {value: assertActive, enumerable: false},
      resolve: {value: resolve, enumerable: false},
      toJSON: {value: wire, enumerable: false},
    });
    return Object.freeze(snapshot);
  }

  private lifecycleFor(lifecycle: ToolLifecycle): ToolLifecycle {
    if (!isPlainRecord(lifecycle)) throw toolContractError('invalid_tool_descriptor', 'Registration lifecycle must be a plain object.');
    const signal = lifecycle.signal as unknown;
    const assertCurrent = lifecycle.assertCurrent as unknown;
    if (signal !== undefined && (typeof signal !== 'object' || signal === null || typeof (signal as AbortSignal).throwIfAborted !== 'function')) {
      throw toolContractError('invalid_tool_descriptor', 'Registration lifecycle signal must be an AbortSignal.');
    }
    if (assertCurrent !== undefined && typeof assertCurrent !== 'function') {
      throw toolContractError('invalid_tool_descriptor', 'Registration lifecycle assertCurrent must be a function.');
    }
    return Object.freeze({
      ...(signal ? {signal: signal as AbortSignal} : {}),
      ...(assertCurrent ? {assertCurrent: assertCurrent as () => void} : {}),
    });
  }

  private entryFor(registration: Registration): ToolSnapshotEntry {
    const {descriptor, fingerprint} = registration;
    return Object.freeze({
      name: descriptor.name,
      version: descriptor.version,
      description: descriptor.description,
      fields: descriptor.fields,
      kind: descriptor.kind,
      exposure: descriptor.exposure,
      requires: descriptor.requires,
      fingerprint,
    });
  }
}
