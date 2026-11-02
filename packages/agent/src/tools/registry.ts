import {createHash} from 'node:crypto';
import {validateCapabilityArguments} from '../capability-schema.js';
import {
  canonicalJson,
  defineToolDescriptor,
  isPlainRecord,
  TOOL_SNAPSHOT_SCHEMA_VERSION,
  toolContractError,
  toolSchemaFingerprint,
  type ToolDescriptor,
  type ToolDescriptorInput,
  type ToolExecutionHost,
  type ToolFields,
  type ToolPin,
  type ToolSnapshot,
  type ToolSnapshotEntry,
} from './descriptor.js';

interface Registration {
  readonly descriptor: ToolDescriptor;
  readonly fingerprint: string;
  readonly token: symbol;
}

const byName = (left: {readonly name: string}, right: {readonly name: string}) => left.name.localeCompare(right.name);

function unknownTool(name: string): never {
  throw toolContractError('unknown_tool', 'No pinned capability has this exact name.', {name});
}

function invalidArguments(message: string, details: Record<string, unknown> = {}): never {
  throw toolContractError('invalid_tool_arguments', message, details);
}

/** One bounded read-only contribution registry. It owns descriptions, exact
 * name/version selection, the immutable snapshot DTO and local liveness only.
 * It owns no reader, store, grant table, ledger, image quota, sender or confirm;
 * `execute` hands a call to a parent-bound ToolExecutionHost that decides every
 * actual read. A snapshot pin is not an authorization and does not survive
 * unload: the parent still re-checks its online grant on each call. */
export class ToolRegistry {
  private readonly entries = new Map<string, Registration>();

  /** Register one versioned descriptor. Names are unique so a runtime tool list
   * can never contain two definitions with the same name; replacing a version
   * requires unregistering first, which also retires the old pin. */
  register(input: ToolDescriptorInput): () => void {
    const descriptor = defineToolDescriptor(input);
    const existing = this.entries.get(descriptor.name);
    if (existing) throw toolContractError('duplicate_tool', 'This tool name is already registered; unregister it before replacing its version.', {name: descriptor.name, version: existing.descriptor.version});
    const registration: Registration = Object.freeze({
      descriptor,
      fingerprint: toolSchemaFingerprint(descriptor.description, descriptor.fields),
      token: Symbol(descriptor.name + '@' + descriptor.version),
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
   * same name and version is a new pin and cannot revive an old snapshot. */
  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  /** Process-local pins for the current registrations. These tokens never enter
   * a snapshot or a discovery document. */
  pins(): readonly ToolPin[] {
    return Object.freeze([...this.entries.values()].sort((left, right) => byName(left.descriptor, right.descriptor)).map(registration => this.pinFor(registration)));
  }

  /** Whether this exact registration still owns the name. Re-registering the
   * same name/version after unload yields a different token and therefore false. */
  isCurrent(pin: ToolPin): boolean {
    const registration = this.entries.get(pin.name);
    return Boolean(registration && registration.token === pin.token && registration.descriptor.version === pin.version && registration.fingerprint === pin.fingerprint);
  }

  /** Local liveness assertion. This is not an authorization check; the parent
   * still calls the Host port's assertCurrent() and its fresh grant check. */
  assertCurrent(pin: ToolPin): void {
    if (!this.isCurrent(pin)) throw toolContractError('stale_tool_pin', 'This capability registration was unloaded or replaced.', {name: pin.name, version: pin.version});
  }

  /** Resolve one exact name/version against a run's pinned selection. A name
   * outside the selection is an undiscovered capability; a different version is
   * an exact-version mismatch. Registration order never affects either result. */
  select(pins: readonly ToolPin[], name: string, version: string): ToolPin {
    const pin = pins.find(candidate => candidate.name === name);
    if (!pin) unknownTool(name);
    if (pin.version !== version) throw toolContractError('tool_version_mismatch', 'Use the exact pinned version of this capability.', {name, expected: pin.version, received: version});
    return pin;
  }

  /** Immutable wire manifest. With a selection, every selected name must be
   * registered; otherwise the whole manifest fails closed. */
  snapshot(selection?: readonly string[]): ToolSnapshot {
    let registrations: Registration[];
    if (selection === undefined) {
      registrations = [...this.entries.values()];
    } else {
      if (new Set(selection).size !== selection.length) throw toolContractError('invalid_tool_selection', 'A tool selection must not repeat a name.');
      registrations = selection.map(name => this.entries.get(name) ?? unknownTool(name));
    }
    const tools = Object.freeze(registrations.map(registration => this.entryFor(registration)).sort(byName));
    const fingerprint = createHash('sha256').update(canonicalJson({
      schemaVersion: TOOL_SNAPSHOT_SCHEMA_VERSION,
      tools: tools.map(({name, version, fingerprint, kind, requires}) => ({name, version, fingerprint, kind, requires})),
    })).digest('hex');
    return Object.freeze({schemaVersion: TOOL_SNAPSHOT_SCHEMA_VERSION, tools, fingerprint});
  }

  /** capability_discover without a name: brief, sorted metadata only. */
  discover(): Readonly<{schemaVersion: typeof TOOL_SNAPSHOT_SCHEMA_VERSION; capabilities: readonly Readonly<{name: string; version: string; description: string}>[]}>;
  /** capability_discover with an exact name: the pinned version and argument schema. */
  discover(name: string): Readonly<{schemaVersion: typeof TOOL_SNAPSHOT_SCHEMA_VERSION} & ToolSnapshotEntry>;
  discover(name?: string): Readonly<{schemaVersion: typeof TOOL_SNAPSHOT_SCHEMA_VERSION; capabilities: readonly Readonly<{name: string; version: string; description: string}>[]}> | Readonly<{schemaVersion: typeof TOOL_SNAPSHOT_SCHEMA_VERSION} & ToolSnapshotEntry> {
    if (name === undefined) {
      const capabilities = this.snapshot().tools.map(tool => Object.freeze({name: tool.name, version: tool.version, description: tool.description.split('. ')[0]!}));
      return Object.freeze({schemaVersion: TOOL_SNAPSHOT_SCHEMA_VERSION, capabilities: Object.freeze(capabilities)});
    }
    const registration = this.entries.get(name);
    if (!registration) unknownTool(name);
    return Object.freeze({schemaVersion: TOOL_SNAPSHOT_SCHEMA_VERSION, ...this.entryFor(registration)});
  }

  /** Execute one pinned capability with already-decoded arguments. The same
   * registration is verified before I/O and again after the await; a late result
   * from an unloaded or replaced registration is discarded. `host.assertCurrent()`
   * runs on both sides too, but the parent's online grant and confirm remain the
   * authority: this registry check never grants evidence or delivery. */
  async execute(pin: ToolPin, args: Readonly<Record<string, unknown>>, host: ToolExecutionHost): Promise<unknown> {
    const registration = this.requireCurrent(pin);
    if (!isPlainRecord(args)) invalidArguments('Capability arguments must be a plain object.');
    host.assertCurrent();
    validateCapabilityArguments(registration.descriptor.fields as Record<string, Record<string, unknown>>, args as Record<string, unknown>);
    const result = await registration.descriptor.execute(Object.freeze({...args}), host);
    this.requireCurrent(pin);
    host.assertCurrent();
    return result;
  }

  /** capability_execute transport shape: a bounded JSON object string, then the
   * exact same registration, schema and liveness checks as execute(). */
  async executeCapability(pin: ToolPin, argumentsJson: string, host: ToolExecutionHost): Promise<unknown> {
    if (typeof argumentsJson !== 'string' || argumentsJson.length > 65536) invalidArguments('Capability argumentsJson must be a bounded JSON object string.');
    let decoded: unknown;
    try {
      decoded = JSON.parse(argumentsJson);
    } catch {
      invalidArguments('Capability argumentsJson must be valid JSON.');
    }
    if (!isPlainRecord(decoded)) invalidArguments('Capability argumentsJson must be a JSON object.');
    return this.execute(pin, decoded, host);
  }

  private requireCurrent(pin: ToolPin): Registration {
    this.assertCurrent(pin);
    return this.entries.get(pin.name)!;
  }

  private pinFor(registration: Registration): ToolPin {
    return Object.freeze({name: registration.descriptor.name, version: registration.descriptor.version, fingerprint: registration.fingerprint, token: registration.token});
  }

  private entryFor(registration: Registration): ToolSnapshotEntry {
    const {descriptor, fingerprint} = registration;
    return Object.freeze({
      name: descriptor.name,
      version: descriptor.version,
      description: descriptor.description,
      kind: descriptor.kind,
      requires: descriptor.requires,
      fingerprint,
      fields: descriptor.fields as ToolFields,
    });
  }
}
