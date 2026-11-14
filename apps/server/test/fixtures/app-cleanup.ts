import type {TestContext} from 'node:test';
import type {FastifyInstance} from 'fastify';
import {rm} from 'node:fs/promises';

/** Own every app started in a temporary profile, including replacements. */
export function appCleanup(t:TestContext,directory:string){
  const apps:FastifyInstance[]=[],releases:Array<()=>void|Promise<void>>=[];
  // Node runs after hooks in registration order and a failed hook can prevent
  // later hooks from running. Keep the whole ownership chain in one hook.
  t.after(async()=>{
    const errors:unknown[]=[];
    const attempt=async(work:()=>unknown)=>{try{await work();}catch(error){errors.push(error);}};
    for(const release of releases)await attempt(release);
    for(const app of [...apps].reverse())await attempt(()=>app.close());
    await attempt(()=>rm(directory,{recursive:true,force:true}));
    if(errors.length)throw new AggregateError(errors,'Generated app fixture cleanup failed');
  });
  return {
    own<T extends {app:FastifyInstance}>(node:T):T{apps.push(node.app);return node;},
    beforeClose(release:()=>void|Promise<void>){releases.push(release);},
  };
}
