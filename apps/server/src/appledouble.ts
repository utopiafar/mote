/** AppleDouble is an archive sidecar, not the data fork named by its suffix.
 * Recognize the versioned binary header and bounded entry descriptors; names
 * such as `._photo.jpg` alone never exclude an original. */
export function isAppleDouble(prefix:Buffer,sizeBytes:number):boolean {
 if(prefix.length<26||prefix.readUInt32BE(0)!==0x00051607||![0x00010000,0x00020000].includes(prefix.readUInt32BE(4)))return false;
 const count=prefix.readUInt16BE(24),end=26+12*count;
 if(!count||end>prefix.length||end>sizeBytes)return false;
 for(let offset=26;offset<end;offset+=12){
  const start=prefix.readUInt32BE(offset+4),length=prefix.readUInt32BE(offset+8);
  if(start<end||start+length>sizeBytes)return false;
 }
 return true;
}
export const APPLEDOUBLE_REASON='appledouble_metadata';
