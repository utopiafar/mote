/** Padded base64 without a repeated-group regex stack proportional to file size. */
export function validBase64(value:string):boolean {
  return value.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
