import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { connectionServerUrl } from '@mote/shared';
import { ConnectionError, type Connections } from './connections.js';
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const loginDeviceSchema = z.object({serverUrl:z.string().transform((v,ctx)=>{try{return connectionServerUrl(v);}catch{ctx.addIssue({code:'custom',message:'Invalid server URL'});return z.NEVER;}}),deviceId:z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),deviceName:z.string().trim().min(1).max(128),platform:z.enum(['android','macos','windows','linux','other']),challenge:z.string().regex(/^[a-f0-9]{64}$/),durationMs:z.union([z.literal(0),z.literal(86400000),z.literal(604800000),z.literal(2592000000)]).default(2592000000)}).strict();
type Grant = Awaited<ReturnType<Connections['session']>>;
type Request = {input:z.infer<typeof loginDeviceSchema>;deadline:number;grant?:Grant;approval?:Promise<Grant>;authorize?:()=>void};
/** Short-lived authorization exchanges. Never put long-lived bearer credentials in links. */
export class LoginHandoffs {
  private tickets = new Map<string,{token:string;deadline:number;expiresAt?:number;authorize:()=>void}>();
  private requests = new Map<string,Request>();
  constructor(private connections:Connections,private clock=Date.now) {}
  private prune(){for(const [k,v] of this.tickets)if(v.deadline<=this.clock())this.tickets.delete(k);for(const [k,v] of this.requests)if(v.deadline<=this.clock())this.requests.delete(k);}
  private capacity(){this.prune();if(this.tickets.size+this.requests.size>=100)throw new ConnectionError('login_limit',429,'Too many pending logins');}
  ticket(token:string,authorize:()=>void,expiresAt?:number){
    authorize();this.capacity();const code=randomBytes(32).toString('base64url');
    this.tickets.set(hash(code),{token,authorize,deadline:this.clock()+60000,expiresAt});return {code};
  }
  exchange(raw:unknown){
    const {code}=z.object({code:secret}).strict().parse(raw);this.prune();const key=hash(code),ticket=this.tickets.get(key);
    if(!ticket)throw new ConnectionError('login_expired',410,'Login link expired');
    this.tickets.delete(key);if(ticket.expiresAt&&ticket.expiresAt<=this.clock())throw new ConnectionError('login_expired',410,'Login link expired');ticket.authorize();return {token:ticket.token,...(ticket.expiresAt?{expiresAt:ticket.expiresAt}:{})};
  }
  create(raw:unknown){this.capacity();const input=loginDeviceSchema.parse(raw),id=randomBytes(32).toString('base64url');this.requests.set(hash(id),{input,deadline:this.clock()+10*60000});return {id};}
  private request(id:string){secret.parse(id);this.prune();const request=this.requests.get(hash(id));if(!request)throw new ConnectionError('login_expired',410,'Login request expired');return request;}
  detail(id:string){const r=this.request(id);return {deviceName:r.input.deviceName,platform:r.input.platform,serverUrl:r.input.serverUrl,expiresAt:r.deadline};}
  async approve(id:string,authorize:()=>void){
    const r=this.request(id);authorize();if(r.grant)return {approved:true};
    r.approval??=(async()=>{const {serverUrl,deviceId,deviceName,platform,durationMs}=r.input;const grant=await this.connections.session(serverUrl,deviceName,{deviceId,deviceName,platform},durationMs);
      try{authorize();if(r.deadline<=this.clock())throw new ConnectionError('login_expired',410,'Login request expired');}
      catch(e){await this.connections.revoke(grant.credentialId);throw e;}
      r.grant=grant;r.authorize=()=>{const c=this.connections.authenticate('Bearer '+grant.token);if(!c)throw new ConnectionError('unauthorized',401,'Login revoked');this.connections.assertActive(c);};return grant;
    })();try{await r.approval;}catch(e){r.approval=undefined;throw e;}return {approved:true};
  }
  poll(raw:unknown,ack=false){const {id,verifier}=z.object({id:secret,verifier:secret}).strict().parse(raw),r=this.request(id);
    if(hash(verifier)!==r.input.challenge)throw new ConnectionError('unauthorized',401,'Invalid login verifier');
    if(ack){if(!r.grant)throw new ConnectionError('login_pending',409,'Login pending');this.requests.delete(hash(id));return {acknowledged:true};}
    r.authorize?.();return r.grant?{ready:true,...r.grant}:{ready:false};
  }
}
