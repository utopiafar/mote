/** Generated AppleDouble v2 sidecar; no captured personal content. */
export function generatedAppleDouble(){
 const bytes=Buffer.alloc(163);bytes.writeUInt32BE(0x00051607,0);bytes.writeUInt32BE(0x00020000,4);
 bytes.write('Mac OS X',8);bytes.writeUInt16BE(2,24);
 bytes.writeUInt32BE(9,26);bytes.writeUInt32BE(50,30);bytes.writeUInt32BE(113,34);
 bytes.writeUInt32BE(2,38);bytes.writeUInt32BE(163,42);bytes.writeUInt32BE(0,46);
 return bytes;
}
