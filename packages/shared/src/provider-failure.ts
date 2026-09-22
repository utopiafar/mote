/** Transport facts only. Never classify free-form provider messages or evidence. */
export type ProviderFailureDetails={category:'transient'|'permanent'|'blocked';code:string;retryAfterMs?:number};
export class ProviderFailure extends Error {
 readonly statusCode=502;
 constructor(readonly details:ProviderFailureDetails,message='The configured processing service did not complete the request.'){super(message);this.name='ProviderFailure';}
}
export function retryAfterMilliseconds(value:string|null|undefined,now=Date.now()):number|undefined{
 if(!value||value.length>128)return;
 const text=value.trim(),ms=/^\d+$/.test(text)?Number(text)*1000:/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)?Date.parse(text)-now:NaN;
 if(!Number.isFinite(ms))return;return Math.min(7*86400000,Math.max(0,Math.ceil(ms)));
}
export function providerHttpFailure(status:number,retryAfter?:string|null,now=Date.now()):ProviderFailureDetails{
 const delay=retryAfterMilliseconds(retryAfter,now),retry=delay===undefined?{}:{retryAfterMs:delay};
 if(status===401||status===403)return {category:'blocked',code:'provider_authentication'};
 if(status===404)return {category:'blocked',code:'provider_endpoint'};
 if(status>=300&&status<400)return {category:'blocked',code:'provider_redirect'};
 if(status===429)return {category:'transient',code:'rate_limited',...retry};
 if(status===408||status===504)return {category:'transient',code:'provider_timeout',...retry};
 if(status===425||status>=500)return {category:'transient',code:'provider_unavailable',...retry};
 return {category:'permanent',code:status===413?'processing_limit':status===415?'unsupported_format':'provider_request_invalid'};
}
