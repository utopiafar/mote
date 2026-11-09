/** Treat model-supplied empty placeholders as an omitted optional argument.
 * Only declared, non-required properties are touched so required values and
 * unknown keys still fail through the existing validators unchanged. */
export function normalizeOptionalToolArguments(
  schema: Readonly<Record<string, unknown>> | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return args;
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  let normalized: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(args)) {
    if (required.has(key) || !Object.hasOwn(properties, key)) continue;
    if (value === null || typeof value === 'string' && value.trim() === '') {
      normalized ??= {...args};
      delete normalized[key];
    }
  }
  return normalized ?? args;
}

/** A crop is only meaningful when pinned to an exact original hash in image
 * view. Models sometimes echo the answer-schema placeholder region while
 * leaving expectedImageSha256 empty; that exact unverifiable placeholder is an
 * omitted optional argument, not a request for different pixels. Keep every
 * valid pinned crop, every metadata crop (which has no pixel meaning) and every
 * other unsupported value for the existing validators. */
export function normalizeImageReadArguments(args: Record<string, unknown>): Record<string, unknown> {
  const region = args.region;
  if (region === undefined) return args;
  if (region !== null && (typeof region !== 'object' || Array.isArray(region))) return args;
  const hash = args.expectedImageSha256;
  const emptyHash = hash === undefined || hash === null || typeof hash === 'string' && hash.trim() === '';
  const value = region as Record<string, unknown> | null;
  const placeholder = value === null || Object.keys(value).length === 4 && value.x === 0 && value.y === 0 && value.width === 1 && value.height === 1;
  if (!(args.view === 'metadata' || emptyHash && placeholder)) return args;
  const normalized = {...args};
  delete normalized.region;
  return normalized;
}
