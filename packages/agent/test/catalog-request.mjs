import {CONTEXT_TOOLS} from '../dist/context-tools.js';
import {NATIVE_CONTEXT_TOOLS} from '../dist/tool-contributions.js';
const special=new Set(CONTEXT_TOOLS.map(([name])=>name).filter(name=>!NATIVE_CONTEXT_TOOLS.has(name)&&name!=='action_catalog'));
const manifests=new WeakMap();
/** Fixture clients use the actual on-demand gateway, never hidden endpoints. */
export async function catalogRequest(bridge,tool,args={}){
 const send=(name,body)=>fetch(bridge.url+'/'+name,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(body)});
 if(!special.has(tool))return send(tool,args);
 let pinned=manifests.get(bridge);if(!pinned){pinned=new Map();manifests.set(bridge,pinned);}
 if(!pinned.has(tool)){const discovery=await send('capability_discover',{name:tool});if(!discovery.ok)return discovery;pinned.set(tool,(await discovery.json()).data.version);}
 return send('capability_execute',{name:tool,version:pinned.get(tool),argumentsJson:JSON.stringify(args)});
}
