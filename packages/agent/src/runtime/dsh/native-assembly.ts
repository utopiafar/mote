import {existsSync, realpathSync, statSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Public assembly contract for native DSH packages. The host resolves the package and
 * passes only an explicit selection; a query never supplies a path or entry. */
export const NATIVE_DSH_ASSEMBLY_VERSION = '1';

export type NativeDshAssemblyErrorCode =
  | 'native_manifest_invalid'
  | 'native_entry_missing'
  | 'native_entry_escape'
  | 'native_factory_duplicate'
  | 'native_capability_denied';

export class NativeDshAssemblyError extends Error {
  readonly code: NativeDshAssemblyErrorCode;

  constructor(code: NativeDshAssemblyErrorCode, message: string) {
    super(message);
    this.name = 'NativeDshAssemblyError';
    this.code = code;
  }
}

export interface NativeDshManifest {
  readonly name: string;
  readonly version: string;
  readonly type: 'module';
  /** Public subpath exports only. Conditions are collapsed to their import/default
   * target because DSH loads an ESM entry, not a type declaration. */
  readonly exports: Readonly<Record<string, string>>;
  /** Capabilities the package declares. A selection may request a subset, but never
   * more than the manifest declares or the host grants. */
  readonly capabilities: readonly string[];
}

export interface NativeDshSelection {
  readonly id: string;
  /** Public export subpath: "." or "./name". */
  readonly subpath: string;
  /** At most one selection may own the agent factory slot. */
  readonly factory?: boolean;
  readonly capabilities?: readonly string[];
}

export interface NativeDshAssemblyEntry {
  readonly id: string;
  readonly subpath: string;
  readonly specifier: string;
  readonly factory: boolean;
}

export interface NativeDshAssembly {
  readonly apiVersion: typeof NATIVE_DSH_ASSEMBLY_VERSION;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly entries: readonly NativeDshAssemblyEntry[];
  readonly factory: NativeDshAssemblyEntry | undefined;
}

const subpathPattern = /^\.(?:\/[A-Za-z0-9._-]+)*$/;

/** Read the package manifest without executing package code. */
export async function readNativeDshManifest(packageRoot: string): Promise<NativeDshManifest> {
  const manifestPath = resolve(packageRoot, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new NativeDshAssemblyError('native_manifest_invalid', 'Native package manifest is not readable JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NativeDshAssemblyError('native_manifest_invalid', 'Native package manifest must be an object');
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.name !== 'string' || !value.name || typeof value.version !== 'string' || !value.version) {
    throw new NativeDshAssemblyError('native_manifest_invalid', 'Native package name and version are required');
  }
  if (value.type !== 'module') {
    throw new NativeDshAssemblyError('native_manifest_invalid', 'Native package must be an ES module package');
  }
  const exportsValue = value.exports;
  const exportsMap: Record<string, string> = {};
  if (typeof exportsValue === 'string') {
    exportsMap['.'] = exportsValue;
  } else if (exportsValue && typeof exportsValue === 'object' && !Array.isArray(exportsValue)) {
    const entries = Object.entries(exportsValue as Record<string, unknown>);
    if (entries.some(([subpath]) => subpath.startsWith('.'))) {
      for (const [subpath, target] of entries) {
        if (!subpath.startsWith('.')) {
          throw new NativeDshAssemblyError('native_manifest_invalid', 'Native package exports cannot mix subpaths and conditions');
        }
        const resolved = exportTarget(target);
        if (resolved === undefined) {
          throw new NativeDshAssemblyError('native_entry_missing', `Export ${subpath} has no runtime entry`);
        }
        exportsMap[subpath] = resolved;
      }
    } else {
      const rootTarget = exportTarget(exportsValue);
      if (rootTarget === undefined) {
        throw new NativeDshAssemblyError('native_entry_missing', 'Native package root has no runtime entry');
      }
      exportsMap['.'] = rootTarget;
    }
  } else {
    throw new NativeDshAssemblyError('native_manifest_invalid', 'Native package exports are required');
  }
  if (!exportsMap['.']) throw new NativeDshAssemblyError('native_entry_missing', 'Native package has no "." entry');
  const native = value.dsh;
  const declared = native && typeof native === 'object' && !Array.isArray(native)
    ? (native as Record<string, unknown>).native
    : undefined;
  const rawCapabilities = declared && typeof declared === 'object' && !Array.isArray(declared)
    ? (declared as Record<string, unknown>).capabilities
    : undefined;
  const capabilities = rawCapabilities === undefined
    ? []
    : Array.isArray(rawCapabilities) && rawCapabilities.every(item => typeof item === 'string')
      ? [...rawCapabilities]
      : (() => { throw new NativeDshAssemblyError('native_manifest_invalid', 'Native capabilities must be a string array'); })();
  return {
    name: value.name,
    version: value.version,
    type: 'module',
    exports: exportsMap,
    capabilities,
  };
}

function exportTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const conditions = target as Record<string, unknown>;
  // Resolve only conditions this loader can actually satisfy. Unknown keys are
  // private to another consumer and must not select an executable target.
  for (const key of ['import', 'node', 'default']) {
    if (!Object.hasOwn(conditions, key)) continue;
    const resolved = exportTarget(conditions[key]);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** Resolve one public export to a file URL that the DSH loader can import. */
export function nativeDshEntrySpecifier(packageRoot: string, target: string): string {
  if (!target.startsWith('./')) {
    throw new NativeDshAssemblyError('native_entry_escape', 'Native entry must be a relative ./ path');
  }
  const root = resolve(packageRoot);
  const resolved = resolve(root, target);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new NativeDshAssemblyError('native_entry_escape', 'Native entry escapes the package root');
  }
  if (isAbsolute(target)) {
    throw new NativeDshAssemblyError('native_entry_escape', 'Native entry must not be absolute');
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new NativeDshAssemblyError('native_entry_missing', 'Native entry file does not exist');
  }
  const realRoot = realpathSync(root);
  const realResolved = realpathSync(resolved);
  const realRelative = relative(realRoot, realResolved);
  if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new NativeDshAssemblyError('native_entry_escape', 'Native entry resolves outside the package root');
  }
  return pathToFileURL(realResolved).href;
}

/**
 * Plan one native assembly. Duplicate entries, unknown subpaths, path escapes,
 * duplicate factories and ungranted capabilities fail before a runtime starts.
 */
export function planNativeDshAssembly(
  packageRoot: string,
  manifest: NativeDshManifest,
  selections: readonly NativeDshSelection[],
  grantedCapabilities: readonly string[],
): NativeDshAssembly {
  const granted = new Set(grantedCapabilities);
  for (const capability of manifest.capabilities) {
    if (!granted.has(capability)) {
      throw new NativeDshAssemblyError('native_capability_denied', `Native package capability is not granted: ${capability}`);
    }
  }
  const ids = new Set<string>();
  const subpaths = new Set<string>();
  const specifiers = new Set<string>();
  const entries: NativeDshAssemblyEntry[] = [];
  let factory: NativeDshAssemblyEntry | undefined;
  for (const selection of selections) {
    if (!selection.id || ids.has(selection.id)) {
      throw new NativeDshAssemblyError('native_manifest_invalid', `Native selection id is missing or duplicated: ${selection.id}`);
    }
    ids.add(selection.id);
    if (!subpathPattern.test(selection.subpath)) {
      throw new NativeDshAssemblyError('native_entry_missing', `Native subpath is not public: ${selection.subpath}`);
    }
    if (subpaths.has(selection.subpath)) {
      throw new NativeDshAssemblyError('native_manifest_invalid', `Native export is selected more than once: ${selection.subpath}`);
    }
    subpaths.add(selection.subpath);
    const target = manifest.exports[selection.subpath];
    if (target === undefined) {
      throw new NativeDshAssemblyError('native_entry_missing', `Native package has no export ${selection.subpath}`);
    }
    for (const capability of selection.capabilities ?? []) {
      if (!manifest.capabilities.includes(capability) || !granted.has(capability)) {
        throw new NativeDshAssemblyError('native_capability_denied', `Native capability is not declared and granted: ${capability}`);
      }
    }
    const specifier = nativeDshEntrySpecifier(packageRoot, target);
    if (specifiers.has(specifier)) {
      throw new NativeDshAssemblyError('native_manifest_invalid', 'Native package entry is selected more than once');
    }
    specifiers.add(specifier);
    const entry: NativeDshAssemblyEntry = {
      id: selection.id,
      subpath: selection.subpath,
      specifier,
      factory: selection.factory === true,
    };
    if (entry.factory) {
      if (factory !== undefined) {
        throw new NativeDshAssemblyError('native_factory_duplicate', 'Native assembly selects more than one agent factory');
      }
      factory = entry;
    }
    entries.push(entry);
  }
  return {
    apiVersion: NATIVE_DSH_ASSEMBLY_VERSION,
    packageName: manifest.name,
    packageVersion: manifest.version,
    entries,
    factory,
  };
}
