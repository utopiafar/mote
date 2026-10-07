import {randomUUID} from 'node:crypto';

/** A registration instance, separate from persisted versions and execution leases. */
export class InstallationEpochs {
  private readonly host=randomUUID();
  private sequence=0;
  private current=new Map<string,string>();
  install(id:string){const epoch=`${this.host}:${++this.sequence}`;this.current.set(id,epoch);return ()=>{if(this.current.get(id)===epoch)this.current.delete(id);};}
  get(id:string){return this.current.get(id);}
  matches(id:string,epoch:string|undefined){return epoch!==undefined&&this.current.get(id)===epoch;}
}
