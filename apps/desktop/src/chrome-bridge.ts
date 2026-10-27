import {createServer,Socket,Server} from 'node:net';
import {mkdir,mkdtemp,chmod,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {uiPageV3Schema,mediaMetadataSchema,type UiPageV3,type MediaMetadata} from '@mote/shared';
import {z} from 'zod';
import {runHelper} from './native';
import {browserNativeContextSchema,browserBindingSchema,canonicalBrowserUrl,browserContextMatches,type BrowserNativeContext} from './chrome-protocol';
import {CHROME_MESSAGE_LIMIT} from './chrome-constants';
import type {BrowserCaptureProvider,BrowserCaptureRequest,BrowserCaptureResult} from './browser-capture';
const normalizedMasksSchema=z.array(z.object({x:z.number().finite().min(0),y:z.number().finite().min(0),width:z.number().positive().max(1),height:z.number().positive().max(1)}).strict().refine(r=>r.x+r.width<=1&&r.y+r.height<=1)).max(100);
const replySchema=z.object({id:z.string().uuid(),status:z.enum(['ok','blocked','stale','unsupported','failed']),binding:browserBindingSchema.optional(),pages:z.array(uiPageV3Schema).max(16).optional(),media:mediaMetadataSchema.optional()}).strict();
type Reply=z.infer<typeof replySchema>;
type Peer={socket:Socket;ready:boolean;pending:Map<string,{resolve:(r:Reply|undefined)=>void}>};
/** A private per-process relay; disconnected, duplicate, or stale browser sessions never produce content. */
export class ChromeCaptureBridge implements BrowserCaptureProvider {
 private server?:Server;private directory?:string;private peers=new Set<Peer>();private epoch=0;private capability=randomBytes(32).toString('hex');
 private leases=new Map<string,{request:BrowserCaptureRequest;context:BrowserNativeContext;binding:NonNullable<Reply['binding']>;epoch:number;expires:number}>();
 constructor(private readonly options:{profileDirectory:string;helperPath:string}){}
 async start():Promise<void>{if(this.server)return;await mkdir(this.options.profileDirectory,{recursive:true,mode:0o700});await chmod(this.options.profileDirectory,0o700);this.directory=await mkdtemp(join(tmpdir(),'mote-chrome-'));await chmod(this.directory,0o700);const socketPath=join(this.directory,'relay.sock');
  this.server=createServer(socket=>this.accept(socket));await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(socketPath,resolve);});await chmod(socketPath,0o600);await writeFile(join(this.options.profileDirectory,'chrome-bridge.json'),JSON.stringify({socket:socketPath,capability:this.capability}),{mode:0o600});await chmod(join(this.options.profileDirectory,'chrome-bridge.json'),0o600);
 }
 private invalidate(){this.epoch++;this.leases.clear();}
 private accept(socket:Socket){if(this.peers.size>=8){socket.destroy();return;}const peer:Peer={socket,ready:false,pending:new Map()};this.peers.add(peer);this.invalidate();let buffer=Buffer.alloc(0);const auth=setTimeout(()=>{if(!peer.ready)socket.destroy();},2000);auth.unref();socket.on('error',()=>socket.destroy());socket.on('close',()=>{clearTimeout(auth);this.peers.delete(peer);this.invalidate();for(const p of peer.pending.values())p.resolve(undefined);peer.pending.clear();});
  socket.on('data',(chunk:Buffer)=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>CHROME_MESSAGE_LIMIT+1){socket.destroy();return;}let end:number;while((end=buffer.indexOf(10))>=0){const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);try{const raw=JSON.parse(line.toString('utf8'));if(!peer.ready){if(raw.type!=='hello'||typeof raw.capability!=='string'||raw.capability.length!==64||!timingSafeEqual(Buffer.from(raw.capability),Buffer.from(this.capability))){socket.destroy();return;}peer.ready=true;clearTimeout(auth);continue;}const parsed=replySchema.safeParse(raw);if(!parsed.success){socket.destroy();return;}const pending=peer.pending.get(parsed.data.id);if(pending){peer.pending.delete(parsed.data.id);pending.resolve(parsed.data);}}catch{socket.destroy();return;}}});
 }
 private async context(request:BrowserCaptureRequest,signal:AbortSignal):Promise<BrowserNativeContext|undefined>{const raw=await runHelper(this.options.helperPath,'browser-context',Buffer.from(JSON.stringify({appId:request.appId,pid:request.pid})),signal).catch(()=>undefined);const p=browserNativeContextSchema.safeParse(raw);return p.success&&p.data.appId===request.appId&&p.data.pid===request.pid?p.data:undefined;}
 private request(peer:Peer,request:BrowserCaptureRequest,context:BrowserNativeContext,signal:AbortSignal,binding?:Reply['binding']):Promise<Reply|undefined>{if(signal.aborted||peer.pending.size>=1)return Promise.resolve(undefined);const id=randomUUID();return new Promise(resolve=>{let timer:NodeJS.Timeout;const done=(reply:Reply|undefined)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);peer.pending.delete(id);resolve(reply);};const abort=()=>done(undefined);timer=setTimeout(()=>done(undefined),2500);signal.addEventListener('abort',abort,{once:true});peer.pending.set(id,{resolve:done});peer.socket.write(JSON.stringify({type:'sample',id,observationId:request.observationId,observedAt:request.observedAt,origins:request.origins,masks:request.masks.map(m=>({x:context.screen.x+m.x*context.screen.width,y:context.screen.y+m.y*context.screen.height,width:m.width*context.screen.width,height:m.height*context.screen.height})),structured:request.structured,context,...(binding?{binding}:{})})+'\n');});}
 private bound(reply:Reply,context:BrowserNativeContext):boolean {const b=reply.binding;return Boolean(b&&canonicalBrowserUrl(b.url)===canonicalBrowserUrl(context.url)&&canonicalBrowserUrl(b.url)&&JSON.stringify(b.window)===JSON.stringify(context.window)&&JSON.stringify(b.viewport)===JSON.stringify(context.viewport));}
 async sample(request:BrowserCaptureRequest,signal:AbortSignal):Promise<BrowserCaptureResult>{
  if(signal.aborted)return {status:'stale',pages:[]};if(!normalizedMasksSchema.safeParse(request.masks).success)return {status:'blocked',pages:[]};if(request.appId!=='com.google.Chrome')return {status:'unsupported',pages:[]};
  if(!request.origins.length)return {status:'blocked',pages:[]};
  const connected=[...this.peers].filter(p=>p.ready);if(connected.length!==1)return {status:connected.length?'blocked':'disconnected',pages:[]};
  const context=await this.context(request,signal);if(!context)return {status:'blocked',pages:[]};const url=canonicalBrowserUrl(context.url);if(!url||!request.origins.includes(new URL(url).origin))return {status:'blocked',pages:[]};
  const peers=[...this.peers].filter(p=>p.ready);if(peers.length!==1)return {status:peers.length?'blocked':'disconnected',pages:[]};const epoch=this.epoch,reply=await this.request(peers[0],request,context,signal);if(!reply)return {status:'disconnected',pages:[]};if(reply.status!=='ok'||!this.bound(reply,context))return {status:reply.status==='ok'?'stale':reply.status,pages:[]};
  const after=await this.context(request,signal);if(signal.aborted||epoch!==this.epoch||!after||!browserContextMatches(context,after))return {status:'stale',pages:[]};
  if(!request.structured&&((reply.pages?.length??0)>0||reply.media))return {status:'blocked',pages:[]};
  const identity=randomUUID();this.leases.clear();this.leases.set(identity,{request:{...request,structured:false},context,binding:reply.binding!,epoch,expires:Date.now()+10000});
  return {status:'ok',screenshotSafe:context.visibleBrowserWindows===1&&after.visibleBrowserWindows===1,pages:request.structured?reply.pages??[]:[],...(request.structured&&reply.media?{media:reply.media}:{}),identity};
 }
 async validate(identity:string,signal:AbortSignal):Promise<boolean>{const lease=this.leases.get(identity);if(!lease||lease.expires<Date.now()||lease.epoch!==this.epoch||signal.aborted)return false;const peers=[...this.peers].filter(p=>p.ready);if(peers.length!==1)return false;const before=await this.context(lease.request,signal);if(!before||!browserContextMatches(before,lease.context))return false;const reply=await this.request(peers[0],lease.request,before,signal,lease.binding);const after=await this.context(lease.request,signal);return !signal.aborted&&lease.epoch===this.epoch&&Boolean(reply&&reply.status==='ok'&&this.bound(reply,before)&&JSON.stringify(reply.binding)===JSON.stringify(lease.binding)&&!reply.pages?.length&&!reply.media&&after&&browserContextMatches(before,after));}
 async close():Promise<void>{this.invalidate();for(const p of this.peers)p.socket.destroy();if(this.server)await new Promise<void>(resolve=>this.server!.close(()=>resolve()));this.server=undefined;if(this.directory)await rm(this.directory,{recursive:true,force:true});await rm(join(this.options.profileDirectory,'chrome-bridge.json'),{force:true});}
}
