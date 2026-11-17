import {createHash} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';

export class LocalRateLimitError extends Error {
  readonly statusCode=429;
  constructor(readonly retryAfterMs:number){super('Local admission is busy');}
}

/** Fixed windows are per entry point and verified identity. Never evict a live
 * entry to admit a new key: rotating untrusted identities cannot reset a limit. */
export class LocalRateLimit {
  private readonly entries=new Map<string,{until:number;used:number}>();
  private closed=false;
  constructor(private readonly limit:number,private readonly clock=Date.now,private readonly maxKeys=1024,private readonly windowMs=60_000){}
  take(key:string){
    if(this.closed)throw Object.assign(new Error('Local admission is closed'),{statusCode:503});
    const now=this.clock();
    for(const [id,entry] of this.entries)if(entry.until<=now)this.entries.delete(id);
    let entry=this.entries.get(key);
    if(!entry){
      if(this.entries.size>=this.maxKeys)throw new LocalRateLimitError(Math.max(1,Math.min(...[...this.entries.values()].map(value=>value.until))-now));
      entry={until:now+this.windowMs,used:0};this.entries.set(key,entry);
    }
    if(entry.used>=this.limit)throw new LocalRateLimitError(Math.max(1,entry.until-now));
    entry.used++;
  }
  close(){this.closed=true;this.entries.clear();}
}

export function localRetryHeader(reply:FastifyReply,error:LocalRateLimitError){
  reply.header('Retry-After',String(Math.max(1,Math.ceil(error.retryAfterMs/1000))));
}
export function localRateLimitErrors(app:FastifyInstance){
  app.addHook('onError',async(_request,reply,error)=>{if(error instanceof LocalRateLimitError)localRetryHeader(reply,error);});
}

/** Only call behind the existing owner/collector HTTP authentication hook.
 * Hash the verified bearer rather than trusting a device ID in a request body.
 * No credential or address is persisted, logged, or returned to the caller. */
export const verifiedCredentialIdentity=(request:FastifyRequest)=>createHash('sha256').update(request.headers.authorization??'').digest('hex');

class LocalSlots {
  private readonly active=new Map<string,number>();
  private total=0;
  private closed=false;
  constructor(private readonly perIdentity:number,private readonly maximum:number){}
  acquire(key:string){
    if(this.closed)throw Object.assign(new Error('Local admission is closed'),{statusCode:503});
    const count=this.active.get(key)??0;
    if(count>=this.perIdentity||this.total>=this.maximum)throw new LocalRateLimitError(1000);
    this.active.set(key,count+1);this.total++;
    let released=false;
    return ()=>{
      if(released||this.closed)return;released=true;
      const remaining=(this.active.get(key)??1)-1;
      if(remaining)this.active.set(key,remaining);else this.active.delete(key);
      this.total--;
    };
  }
  close(){this.closed=true;this.active.clear();this.total=0;}
}

/** Each upload transport owns one scope. Admission counts new multi-part
 * sessions only; part/replay/receipt counts never spend the admission budget.
 * At most 16 bodies (4 per credential, each <=4 MiB) and 4 commit tasks (2 per
 * credential) are in flight. The limits bound work, not retained data. */
export class UploadHttpProtection {
  private readonly admissions:LocalRateLimit;
  private readonly parts=new LocalSlots(4,16);
  private readonly commits=new LocalSlots(2,4);
  private readonly receiving=new Map<FastifyRequest,()=>void>();
  constructor(clock=Date.now){this.admissions=new LocalRateLimit(120,clock);}
  install(app:FastifyInstance){
    localRateLimitErrors(app);
    const release=(request:FastifyRequest)=>{this.receiving.get(request)?.();this.receiving.delete(request);};
    app.addHook('onResponse',async request=>release(request));
    app.addHook('onRequestAbort',async request=>release(request));
    app.addHook('onTimeout',async request=>release(request));
    app.addHook('onError',async request=>release(request));
    app.addHook('onClose',async()=>this.close());
  }
  admit(request:FastifyRequest){this.admissions.take(verifiedCredentialIdentity(request));}
  /** Route onRequest runs before Fastify buffers the binary body. */
  readonly receive=async(request:FastifyRequest)=>{this.receiving.set(request,this.parts.acquire(verifiedCredentialIdentity(request)));};
  async commit<T>(request:FastifyRequest,work:()=>Promise<T>){
    const release=this.commits.acquire(verifiedCredentialIdentity(request));
    // Keep the slot until the producer actually settles, including aborts.
    try{return await work();}finally{release();}
  }
  close(){this.admissions.close();this.parts.close();this.commits.close();this.receiving.clear();}
}
