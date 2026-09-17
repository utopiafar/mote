import {moteText} from '@mote/shared/i18n';
import sharp from 'sharp';
export interface CompressionPreview {original:string;compressed:string;originalBytes:number;compressedBytes:number;width:number;height:number;originalWidth:number;originalHeight:number}
/** Generated input only: this debug action never captures a screen or reads the queue. */
export async function compressionPreview(quality:number,maxSide:number):Promise<CompressionPreview>{
  if(!Number.isInteger(quality)||quality<40||quality>95||!Number.isInteger(maxSide)||maxSide<640||maxSide>2560)throw new Error(moteText("质量范围 40–95，最长边范围 640–2560"));
  const originalWidth=2560,originalHeight=1440;
  const lines=Array.from({length:24},(_,i)=>`<text x="480" y="${260+i*38}" font-size="${14+i%4*3}" fill="#263c40">${String(i+1).padStart(2,'0')}  Mote · 图片清晰度预览 / Small text: Aa 0123456789 → 阅读与记录</text>`).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="2560" height="1440"><defs><linearGradient id="g"><stop stop-color="#487f94"/><stop offset=".5" stop-color="#e7b478"/><stop offset="1" stop-color="#876890"/></linearGradient></defs><rect width="2560" height="1440" fill="#f4f1ea"/><rect x="48" y="48" width="360" height="1344" rx="24" fill="#e6dfd2"/><text x="96" y="135" font-size="56" fill="#5c5141">mote</text><text x="480" y="154" font-size="48" fill="#283b3c">把细节留在记录里</text>${lines}<rect x="1680" y="240" width="800" height="680" rx="24" fill="url(#g)"/>${Array.from({length:70},(_,i)=>`<circle cx="${1740+(i*97)%680}" cy="${300+(i*61)%530}" r="${3+i%8}" fill="#ffffff" opacity=".55"/>`).join('')}<text x="1680" y="1010" font-size="28" fill="#394952">生成示例 · 文字 / 渐变 / 细线</text><path d="M1680 1080h800 M1680 1090h800 M1680 1100h800" stroke="#305966"/><text x="480" y="1350" font-size="22" fill="#667572">不读取屏幕 · 不上传 · 仅用于比较 JPEG 与缩放效果</text></svg>`;
  const original=await sharp(Buffer.from(svg)).png().toBuffer();
  const {data,info}=await sharp(original).resize(maxSide,maxSide,{fit:'inside',withoutEnlargement:true}).removeAlpha().jpeg({quality}).toBuffer({resolveWithObject:true});
  return {original:`data:image/png;base64,${original.toString('base64')}`,compressed:`data:image/jpeg;base64,${data.toString('base64')}`,originalBytes:original.length,compressedBytes:data.length,width:info.width,height:info.height,originalWidth,originalHeight};
}
