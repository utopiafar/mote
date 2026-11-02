import {Context,type Plugin} from '@deepseek-ai/cordis';
import {PluginResourceScope} from '@mote/plugin-host';

/**
 * A runtime can be tested on its own or mounted below the server's one Cordis
 * root. In the latter case it only releases the plugins and services it owns;
 * closing one runtime must not dispose its siblings.
 */
export class BackendPluginScope {
  readonly context:Context;
  private readonly resources=new PluginResourceScope(undefined,'Plugin scope disposal failed',true);
  private closed=false;

  constructor(root?:Context){
    this.context=root??new Context();
    if(!root)this.resources.retire(()=>this.context.fiber.dispose());
  }

  provide(name:string,value:unknown){
    if(this.closed)throw new Error('Plugin scope is closed');
    const remove=this.context.provide(name,value);
    this.resources.retire(()=>remove());
  }

  async install(plugin:Plugin){
    if(this.closed)throw new Error('Plugin scope is closed');
    const fiber=this.context.plugin(plugin);
    this.resources.defer(()=>fiber.dispose());
    await this.resources.join((async()=>{
      try{await fiber;if(this.closed)throw new Error('Plugin scope is closed');}
      catch(error){
        try{await fiber.dispose();}catch(cleanup){throw new AggregateError([error,cleanup],'Plugin initialization and disposal failed',{cause:error});}
        throw error;
      }
    })());
  }

  close(){this.closed=true;return this.resources.close();}
}
