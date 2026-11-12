import {z} from 'zod';
import type {AutomaticTopics} from './automatic-topics.js';
import {publishOperationChange} from './operation-projection.js';
import type {Store} from './store.js';
import {moteText} from './i18n.js';
import type {FastifyInstance} from 'fastify';
import type {MemoryRead,MemoryReadSnapshots} from './evidence-read-ports.js';
import type {Memory} from './memory-schema.js';
import {navigationScopeSchema} from './context-navigation.js';
import {StoreError,sha256} from './store.js';
import {formatEvidenceRef} from '@mote/shared';
type TreeMemoryRead=Pick<MemoryRead,'memoryPageAsync'> & Pick<MemoryReadSnapshots,'memoryBindings'>;

const identity=z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/);
const selector=z.object({domain:z.enum(['personal','coding']).optional(),kind:z.enum(['episodic','semantic','procedural']).optional(),codingKind:z.enum(['pitfall','decision','principle','preference']).optional(),memoryIds:z.array(z.string().uuid()).max(20000).optional()}).strict();
const treeSchema=z.object({id:identity,version:z.string().regex(/^\d+$/),label:z.string().min(1).max(100),nodes:z.array(z.object({id:identity,label:z.string().min(1).max(100),parentId:identity.optional(),select:selector}).strict()).min(1).max(500)}).strict();
export type ContextTree=z.infer<typeof treeSchema>;
const querySchema=z.object({...navigationScopeSchema.shape,query:z.string().max(500).optional(),tier:z.enum(['episode','consolidated']).optional(),kind:z.enum(['episodic','semantic','procedural']).optional(),status:z.enum(['proposed','published','stale']).optional(),layer:z.enum(['observation','memory']).optional(),includeHistory:z.enum(['true','false']).optional(),includeStale:z.enum(['true','false']).optional(),asOf:z.string().datetime({offset:true}).optional(),cursor:z.string().max(8192).optional(),limit:z.coerce.number().int().min(1).max(100).default(30)}).strict();
const positionSchema=z.object({signature:z.string(),start:z.string().nullable(),offset:z.number().int().min(0).max(100),page:z.string()}).strict();

/** A tree indexes existing model-assigned fields or explicitly supplied identities.
 * It never classifies prose or creates another copy of a Memory. Trusted plugins
 * register disposable contributions through the same host service. */
export class ContextTreeRegistry {
  private readonly trees=new Map<string,ContextTree>();
  private revision=0;
  constructor(private readonly scopeIndependentTrees:readonly string[]=[]){ }
  private store?:Store;
  private canPublish=()=>true;
  automatic?:AutomaticTopics;
  private publishChange(kind:'registry'|'classifier'){
    if(this.store?.db.isOpen&&this.canPublish())publishOperationChange(this.store,'context-trees:'+kind);
  }
  /** Attach the plugin-owned automatic topic index. The registry never
   * constructs it; classifier changes flow back through this catalog. */
  attachAutomatic(automatic:AutomaticTopics,options:{store?:Store;canPublish?:()=>boolean}={}){
    if(this.automatic)throw new StoreError('Automatic topics are already attached',409);
    if(options.store)this.store=options.store;
    if(options.canPublish)this.canPublish=options.canPublish;
    const register=automatic.register.bind(automatic);
    automatic.register=(classifier)=>{
      const dispose=register(classifier);
      try{this.publishChange('classifier');}catch(error){dispose();throw error;}
      let removed=false;
      return()=>{if(removed)return;removed=true;dispose();this.publishChange('classifier');};
    };
    this.automatic=automatic;
  }
  detachAutomatic(automatic:AutomaticTopics){if(this.automatic===automatic)this.automatic=undefined;}
  register(raw:ContextTree){
    const tree=treeSchema.parse(raw);if(tree.id.startsWith('auto.'))throw new StoreError('Automatic topic namespace is reserved');const ids=new Set(tree.nodes.map(node=>node.id));
    if(this.trees.has(tree.id)||ids.size!==tree.nodes.length)throw new StoreError('Duplicate context tree identity');
    for(const node of tree.nodes){
      const seen=new Set([node.id]);let parent=node.parentId;
      while(parent){if(!ids.has(parent)||seen.has(parent))throw new StoreError('Invalid context tree ancestry');seen.add(parent);parent=tree.nodes.find(item=>item.id===parent)!.parentId;}
    }
    this.trees.set(tree.id,tree);this.revision++;let removed=false;
    this.publishChange('registry');
    return ()=>{if(!removed){removed=true;this.trees.delete(tree.id);this.revision++;this.publishChange('registry');}};
  }
  private async memoriesVisible(reader:TreeMemoryRead,scope:unknown,ids:readonly string[]){
    const selected=navigationScopeSchema.parse(scope);
    const snapshot=reader.memoryBindings?.retainSnapshot(ids);
    try{
      for(const id of new Set(ids)){
        const page=await reader.memoryPageAsync({...selected,id:formatEvidenceRef('memory',id),status:'published',limit:1},true,snapshot);
        if(!page.items.some(item=>item.id===id))return false;
      }
      return true;
    }finally{snapshot?.release();}
  }
  private automaticTrees(reader?:TreeMemoryRead,scope:unknown={}){
    const selected=navigationScopeSchema.parse(scope);
    // A label may reflect any input in its classification batch, including
    // inputs the classifier did not attach to a visible node.
    return this.automatic?.trees(reader?memories=>this.memoriesVisible(reader,selected,memories.map(memory=>memory.id)):undefined);
  }
  private registeredTreeVisible(scope:unknown,tree:ContextTree){
    const selected=navigationScopeSchema.parse(scope);
    // A node's selection is not a complete lineage for its label. Only the
    // host's fixed generic labels are safe without a classification receipt.
    return !Object.keys(selected).length||this.scopeIndependentTrees.includes(tree.id);
  }
  async catalog(reader?:TreeMemoryRead,scope:unknown={}){
    const registered:ContextTree[]=[];
    for(const tree of this.trees.values())if(this.registeredTreeVisible(scope,tree))registered.push(tree);
    return {classification:this.automatic?.state()??{state:'unavailable'},items:[...(await this.automaticTrees(reader,scope)??[]),...registered].map(tree=>({...tree,label:moteText(tree.label),nodes:tree.nodes.map(({select:_,...node})=>({...node,label:moteText(node.label)}))}))};
  }
  async page(reader:TreeMemoryRead,treeId:string,nodeId:string,raw:unknown,ownerArchive=true){
    const automatic=treeId.startsWith('auto.');
    const {cursor,limit,...scope}=querySchema.parse(raw);
    const navigation=Object.fromEntries(Object.keys(navigationScopeSchema.shape).filter(key=>scope[key as keyof typeof scope]!==undefined).map(key=>[key,scope[key as keyof typeof scope]]));
    const tree=automatic?(await this.automaticTrees(reader,navigation))?.find(tree=>tree.id===treeId):this.trees.get(treeId),node=tree?.nodes.find(value=>value.id===nodeId);
    if(!tree||!node||!automatic&&!this.registeredTreeVisible(navigation,tree))throw new StoreError('Context tree node not found',404);
    const snapshot=reader.memoryBindings?.retainSnapshot();
    try{
      const signature=sha256(JSON.stringify({tree,node,revision:this.revision,scope,binding:snapshot?.binding}));
      let start:string|null=null,offset=0,expectedPage:string|undefined;
      if(cursor){try{const p=positionSchema.parse(JSON.parse(Buffer.from(cursor,'base64url').toString()));if(p.signature!==signature)throw Error();start=p.start;offset=p.offset;expectedPage=p.page;}catch{throw new StoreError('Context tree changed; restart browsing',409);}}
      const items:Memory[]=[];let scanned=0;
      const encode=(page:string)=>Buffer.from(JSON.stringify({signature,start,offset,page})).toString('base64url');
      const matches=(memory:Memory)=>{const s=node.select;return (!s.domain||memory.domain===s.domain)&&(!s.kind||memory.kind===s.kind)&&(!s.codingKind||memory.coding?.kind===s.codingKind)&&(!s.memoryIds||s.memoryIds.includes(memory.id));};
      while(scanned<1000){
        const page=await reader.memoryPageAsync({...scope,includeHistory:scope.includeHistory==='true',includeStale:scope.includeStale==='true',cursor:start??undefined,limit:100},ownerArchive,snapshot);
        const hash=sha256(JSON.stringify(page.items.map(item=>[item.id,item.revision??item.fingerprint,item.status])));
        if(expectedPage&&expectedPage!==hash)throw new StoreError('Context tree contents changed; restart browsing',409);
        expectedPage=undefined;
        for(;offset<page.items.length;offset++){
          const item=page.items[offset];scanned++;
          if(matches(item))items.push(item);
          if(items.length===limit){offset++;return {items,nextCursor:offset<page.items.length?encode(hash):page.nextCursor?Buffer.from(JSON.stringify({signature,start:page.nextCursor,offset:0,page:''})).toString('base64url'):null};}
        }
        if(!page.nextCursor)return {items,nextCursor:null};
        start=page.nextCursor;offset=0;
      }
      return {items,nextCursor:encode('')};
    }finally{snapshot?.release();if(automatic&&!(await this.automaticTrees(reader,navigation))?.some(current=>JSON.stringify(current)===JSON.stringify(tree)))throw new StoreError('Automatic topic inputs changed; restart browsing',409);}
  }
}
export function createContextTrees(){
  // These fixed host labels are generic navigation, not model/person data.
  const registry=new ContextTreeRegistry(['topics','knowledge','use']);
  registry.register({id:'topics',version:'1',label:'主题',nodes:[
    {id:'personal',label:'个人',select:{domain:'personal'}},{id:'coding',label:'工作与技术',select:{domain:'coding'}},
    ...(['pitfall','decision','principle','preference'] as const).map((kind,index)=>({id:'coding.'+kind,parentId:'coding',label:['经验','决定','原则','偏好'][index],select:{domain:'coding' as const,codingKind:kind}})),
  ]});
  registry.register({id:'knowledge',version:'1',label:'知识性质',nodes:[{id:'episodic',label:'经历',select:{kind:'episodic'}},{id:'semantic',label:'知识',select:{kind:'semantic'}},{id:'procedural',label:'方法',select:{kind:'procedural'}}]});
  registry.register({id:'use',version:'1',label:'使用场景',nodes:[{id:'personal',label:'个人助理',select:{domain:'personal'}},{id:'coding',label:'Coding Agent',select:{domain:'coding'}}]});
  return registry;
}
export function registerContextTreeRoutes(app:FastifyInstance,reader:TreeMemoryRead,trees:ContextTreeRegistry){
  app.get('/api/context-trees',async req=>trees.catalog(reader,req.query));
  app.get('/api/context-trees/:treeId/nodes/:nodeId',async req=>{const {treeId,nodeId}=z.object({treeId:identity,nodeId:identity}).parse(req.params);return trees.page(reader,treeId,nodeId,req.query);});
}
declare module '@deepseek-ai/cordis' {interface Context {moteContextTrees:ContextTreeRegistry;}}
