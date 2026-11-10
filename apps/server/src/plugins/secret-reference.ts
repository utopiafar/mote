/** A plugin instance stores only an opaque secret reference. The reference is
 * an exact `${ENV_NAME}` pointer into the deployment's existing secret
 * environment, the same location mote.yaml credential references use.
 * Bootstrap variables are refused so a package cannot repoint its own host. */
const blocked = new Set([
  'MOTE_CONFIG_FILE', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS',
  'PATH', 'HOME', 'ENV', 'BASH_ENV', 'PYTHONPATH', 'PYTHONHOME',
]);
export function resolvePluginSecretReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (!match) return undefined;
  const name = match[1]!;
  if (blocked.has(name) || /^(?:DOCKER_|COMPOSE_|LD_|DYLD_)/.test(name)) return undefined;
  const resolved = process.env[name];
  return resolved === undefined || resolved === '' ? undefined : resolved;
}
