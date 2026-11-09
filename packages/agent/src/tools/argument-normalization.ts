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
 * view. Models sometimes echo the answer-schema placeholder region (including
 * its description), the directImages metadata object, or a `hash` alias for the
 * declared pin. Those lossless shape normalizations are omitted optional
 * arguments, not requests for different pixels. Keep every valid pinned crop,
 * every metadata crop (which has no pixel meaning) and every other unsupported
 * value for the existing validators. */
const imageReadEchoKeys=new Set(['name','mimeType','hash','sizeBytes']);
const imageRegionKeys=new Set(['x','y','width','height']);
const imageFullViewAliases=new Set(['full','original']);
export function normalizeImageReadArguments(args: Record<string, unknown>): Record<string, unknown> {
  let normalized: Record<string, unknown> | undefined;
  const copy=()=>normalized??={...args};
  const hashAlias=args.expectedImageSha256===undefined&&typeof args.hash==='string'&&args.hash.trim()!==''?args.hash.trim():undefined;
  for(const key of imageReadEchoKeys)if(args[key]!==undefined){copy();delete normalized![key];}
  // `full`/`original` are unambiguous aliases for the declared full-image view.
  if(typeof args.view==='string'&&imageFullViewAliases.has(args.view)){copy();delete normalized!.view;}
  if(args.view==='metadata'){copy();delete normalized!.region;return normalized!;}
  const region=args.region;
  if(region===undefined){
    // expectedImageSha256 pins a crop; without one it only makes a full read
    // fail against readers that cannot verify views.
    if(args.expectedImageSha256!==undefined){copy();delete normalized!.expectedImageSha256;}
    return normalized??args;
  }
  if(region!==null&&(typeof region!=='object'||Array.isArray(region)))return normalized??args;
  const value=region as Record<string,unknown>|null;
  const pinned=args.expectedImageSha256??hashAlias;
  const emptyHash=pinned===undefined||pinned===null||typeof pinned==='string'&&pinned.trim()==='';
  const annotated=value!==null&&Object.keys(value).some(key=>!imageRegionKeys.has(key));
  const placeholder=value===null||value.x===0&&value.y===0&&value.width===1&&value.height===1;
  // The 1x1 origin region is the interpretation-schema placeholder when it is
  // unpinned or carries annotation fields such as description. An exact pinned
  // 1x1 crop without annotations remains a valid requested region.
  if(placeholder&&(emptyHash||annotated||value===null)){copy();delete normalized!.region;delete normalized!.expectedImageSha256;return normalized!;}
  if(hashAlias){copy();normalized!.expectedImageSha256=hashAlias;}
  if(annotated&&value){copy();normalized!.region=Object.fromEntries(Object.entries(value).filter(([key])=>imageRegionKeys.has(key)));}
  return normalized??args;
}
