import React,{useEffect,useState} from 'react';
import {ExternalLink} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';

/** Shared by the existing Feishu panels and owned recording connections. */
export function ProviderAuthorization({url,expiresAt,provider='lark'}:{url:string;expiresAt?:string;provider?:'lark'|'dingtalk'}){
 const [qr,setQr]=useState(''),[qrError,setQrError]=useState(false),[copyState,setCopyState]=useState(''),[now,setNow]=useState(Date.now());
 useEffect(()=>{let disposed=false;setQr('');setQrError(false);setCopyState('');void import('qrcode').then(({default:QRCode})=>QRCode.toDataURL(url,{width:220,margin:2})).then(value=>{if(!disposed)setQr(value);}).catch(()=>{if(!disposed)setQrError(true);});return()=>{disposed=true;};},[url]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 let valid=false;try{const target=new URL(url),domains=provider==='lark'?['feishu.cn','larksuite.com','larkoffice.com']:['dingtalk.com','dingtalk.cn','dingtalk.io'];valid=target.protocol==='https:'&&!target.username&&!target.password&&!target.port&&domains.some(domain=>target.hostname===domain||target.hostname.endsWith('.'+domain));}catch{}
 if(!valid)return <p role="alert">{moteText('授权链接无效，请重新发起授权。')}</p>;
 if(expiresAt&&Date.parse(expiresAt)<=now)return <p role="alert">{moteText('授权链接已过期，请重新发起授权。')}</p>;
 return <div className="lark-authorization"><p>{moteText('在你的手机或当前浏览器完成授权，页面会自动更新。')}</p><a className="button" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{provider==='lark'?moteText('打开飞书授权页面'):moteText('打开钉钉授权页面')}<ExternalLink size={15}/></a><button type="button" className="button subtle" onClick={async()=>{try{await navigator.clipboard.writeText(url);setCopyState(moteText('授权链接已复制。'));}catch{setCopyState(moteText('复制失败，请使用二维码或授权链接。'));}}}>{moteText('复制授权链接')}</button><p className="fine-print">{copyState||moteText('如果无法打开，可复制链接到浏览器，或扫码。')}</p>{qr&&<img src={qr} alt={moteText('账号授权二维码')} width={220} height={220}/>} {qrError&&<p>{moteText('二维码生成失败，请使用上方授权链接。')}</p>}{expiresAt&&<p className="fine-print">{moteText('链接有效至')} {new Date(expiresAt).toLocaleTimeString()}</p>}</div>;
}
