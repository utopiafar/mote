import type {BuildInstance,BuildSelection,PluginControlStore} from './plugins/plugin-control-store.js';

/** Optional connectors shipped with Central. MCP's host transport remains under
 * AI Access; archive/storage/authorization are required platform components.
 * These are existing native build selections, never downloadable packages. */
export const bundledConnectors = [
  {id:'gmail',name:'Gmail'},
  {id:'google-calendar',name:'Google Calendar'},
  {id:'lark',name:'Lark / Feishu'},
  {id:'feishu-recordings',name:'Feishu Minutes'},
  {id:'dingtalk-recordings',name:'DingTalk Recordings'},
] as const;

export function bundledConnector(buildId:string){return bundledConnectors.find(value=>buildId==='bundled:'+value.id);}
export function bundledConnectorSelection(id:string):BuildSelection{return {packageId:'mote.connector.'+id,version:'1',configurationRevision:0};}

/** Read the persisted selection before creating any provider, timer or route. */
export function prepareBundledConnectors(control:PluginControlStore,manifestIds:readonly string[]){
  const disabled:string[]=[];
  for(const connector of bundledConnectors){
    if(!manifestIds.includes(connector.id))continue;
    const id='bundled:'+connector.id;
    let record=control.build(id);
    if(!record){
      const selection=bundledConnectorSelection(connector.id);
      record={id,packageId:selection.packageId,version:selection.version,installationId:id,kind:'native',revision:1,
        desired:selection,retired:false,observed:'starting',blockers:[],operationId:'bootstrap:'+id} satisfies BuildInstance;
      control.saveBuild(record);
    }
    if(!record.desired)disabled.push(connector.id);
  }
  return disabled;
}
