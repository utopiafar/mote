/** Resources acquired by one server startup, released in reverse acquisition order. */
const failures=(error:unknown):unknown[]=>error instanceof AggregateError?error.errors.flatMap(failures):[error];
export class ServerResources {
  private disposers:Array<()=>unknown|Promise<unknown>>=[];
  private interrupts:Array<()=>unknown|Promise<unknown>>=[];
  private stopping?:Promise<PromiseSettledResult<unknown>[]>;
  private closing?:Promise<void>;
  defer(dispose:()=>unknown|Promise<unknown>){
    if(this.closing)throw Error('Server resources are closing');
    this.disposers.push(dispose);
  }
  /** Stop admission/transports while every handler, plugin and store is still live. */
  beforeClose(interrupt:()=>unknown|Promise<unknown>){this.interrupts.push(interrupt);}
  stop(){return this.stopping??=Promise.allSettled(this.interrupts.map(interrupt=>Promise.resolve().then(interrupt)));}
  close(){return this.closing??=(async()=>{
    const errors:unknown[]=(await this.stop()).flatMap(result=>result.status==='rejected'?failures(result.reason):[]);
    for(const dispose of this.disposers.reverse())try{await dispose();}catch(error){errors.push(...failures(error));}
    if(errors.length)throw new AggregateError(errors,'Server resource disposal failed');
  })();}
}
