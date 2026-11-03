export const REPORT_SIZE_MESSAGE='mote:insight-size';
export const REPORT_SOURCE_MESSAGE='mote:insight-source';
export const REPORT_MAX_HEIGHT=16000;
export function newReportSizeToken(){return Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,'0')).join('');}
export function reportSizeScript(token:string,parentOrigin:string){
 if(!/^[a-f0-9]{32}$/.test(token))throw Error('Invalid report size token');
 const origin=new URL(parentOrigin);if(!['http:','https:'].includes(origin.protocol)||origin.origin!==parentOrigin)throw Error('Invalid report parent origin');
 // The srcdoc inherits the parent's self-only CSP as well as its own nonce
 // policy. A fixed same-origin classic asset satisfies both without inline JS.
 const source=new URL('/insight-report-bridge.js',origin).href;
 return `<script nonce="${token}" src="${source}"></script>`;
}
export function acceptedReportSource(event:MessageEvent,source:Window|null,token:string,citationCount:number):number|undefined{
 if(!source||event.source!==source||!event.data||event.data.type!==REPORT_SOURCE_MESSAGE||event.data.token!==token||!Number.isSafeInteger(event.data.index)||event.data.index<0||event.data.index>=citationCount)return;
 return event.data.index;
}
export function acceptedReportHeight(event:MessageEvent,source:Window|null,token:string):number|undefined{
 if(!source||event.source!==source||!event.data||event.data.type!==REPORT_SIZE_MESSAGE||event.data.token!==token||typeof event.data.height!=='number'||!Number.isFinite(event.data.height)||event.data.height<=0)return;
 return Math.min(REPORT_MAX_HEIGHT,Math.max(100,Math.ceil(event.data.height)));
}
