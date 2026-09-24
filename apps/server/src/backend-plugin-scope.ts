import {Context,type Plugin} from '@deepseek-ai/cordis';

/**
 * A runtime can be tested on its own or mounted below the server's one Cordis
 * root. In the latter case it only releases the plugins and services it owns;
 * closing one runtime must not dispose its siblings.
 */
export class BackendPluginScope {
  readonly context:Context;
  private readonly ownsRoot:boolean;
  private readonly plugins:Array<{dispose():Promise<void>}>=[];
  private readonly services:Array<()=>Promise<void>|void>=[];
  private closed=false;

  constructor(root?:Context){
    this.context=root??new Context();
    this.ownsRoot=!root;
  }

  provide(name:string,value:unknown){
    if(this.closed)throw new Error('Plugin scope is closed');
    this.services.push(this.context.provide(name,value));
  }

  async install(plugin:Plugin){
    if(this.closed)throw new Error('Plugin scope is closed');
    const fiber=this.context.plugin(plugin);
    this.plugins.push(fiber);
    await fiber;
  }

  async close(){
    if(this.closed)return;
    this.closed=true;
    if(this.ownsRoot){await this.context.fiber.dispose();return;}
    const errors:unknown[]=[];
    for(const plugin of this.plugins.reverse())try{await plugin.dispose();}catch(error){errors.push(error);}
    for(const service of this.services.reverse())try{await service();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Plugin scope disposal failed');
  }
}
