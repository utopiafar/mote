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
