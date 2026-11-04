import {createHash} from 'node:crypto';
import {sourceItemSchema} from '@mote/shared';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Generated journal example: one pack adds source organization, flow policies, consumer and presentation anchors. */
export default {
  name:'fixture-journal',inject:['moteSourceRecipes','moteSourcePipelines','moteMaterialCatalog','moteContextProcessors','moteMaterialConsumers'],
  apply(ctx){
    const recipes=ctx.moteSourceRecipes;
    ctx.effect(()=>recipes.registerGroup({id:'fixture.journal-group',version:'1',kind:'group'},()=> 'journal'));
    ctx.effect(()=>recipes.registerRawReader({id:'fixture.journal-reader',version:'1',kind:'raw-reader'},async(reader,source,group,signal)=>{
      const collectionRef='raw-collection:v1:'+Buffer.from(JSON.stringify([source.id,group])).toString('base64url');
      const items=[];let cursor,checkpoint,totalBytes=0;
      do {
        signal.throwIfAborted();const page=await reader.page({collectionRef,cursor,limit:100});
        if(page.status!=='available')throw Error('Journal snapshot unavailable');
        if(checkpoint&&checkpoint!==page.snapshot)throw Error('Journal snapshot changed');checkpoint=page.snapshot;
        if(items.length+page.items.length>10000)throw Error('Journal snapshot exceeds budget');
        for(const entry of page.items){let offset=0;const chunks=[];do {const read=await reader.read(entry.ref,{offset,length:65536});if(read.status!=='available'||read.totalBytes>1024*1024)throw Error('Journal item unavailable');totalBytes+=read.bytes.length;if(totalBytes>16*1024*1024)throw Error('Journal snapshot exceeds byte budget');chunks.push(read.bytes);offset=read.nextOffset??0;}while(offset);items.push(sourceItemSchema.parse(JSON.parse(Buffer.concat(chunks).toString())));}
        cursor=page.nextCursor??undefined;
      }while(cursor);
      return {items,checkpoint,mode:'full'};
    }));
    ctx.effect(()=>recipes.registerWindow({id:'fixture.journal-window',version:'1',kind:'window'},({snapshot})=>snapshot.items));
    ctx.effect(()=>recipes.registerJoin({id:'fixture.journal-join',version:'1',kind:'join'},({snapshot})=>snapshot.items));
    ctx.effect(()=>recipes.registerAggregation({id:'fixture.journal-count',version:'1',kind:'aggregation'},({items})=>({entries:items.length})));
    ctx.effect(()=>recipes.registerStep({id:'fixture.journal-text',version:'1',kind:'step'},({items})=>items.filter(item=>!item.deleted&&item.layer!=='reference').map(item=>({id:'entry-'+digest(item.externalId),kind:'text',format:'plain',text:item.text,memberIds:['archive']}))));
    ctx.effect(()=>recipes.registerPublisher({id:'fixture.journal-publish',version:'1',kind:'publish'},({source,group,items,outputs})=>({
      id:'mat_'+digest([source.id,group]),kind:'fixture.journal',schemaVersion:1,title:source.name,
      origin:{sourceId:source.id,externalId:group,deviceId:source.deviceId,firstAt:items.map(item=>item.observedAt).sort()[0],lastAt:items.map(item=>item.observedAt).sort().at(-1)},
      blocks:[...outputs.text,{id:'counts',kind:'text',format:'plain',text:JSON.stringify(outputs.aggregation),memberIds:['archive']}],members:[{id:'archive',kind:'archive',ref:'archive:'+digest([source.id,group])}],coverage:{state:'complete'},artifacts:[{key:'body',state:'ready',revision:digest(outputs.text),blockIds:outputs.text.map(block=>block.id)},{key:'counts',state:'ready',revision:digest(outputs.aggregation),blockIds:['counts']}],fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'},
    })));
    ctx.effect(()=>recipes.installRecipe({schemaVersion:1,id:'fixture.journal',version:'1',accepts:{sourceKind:'fixture.journal'},
      raw:{writer:{id:'mote.source-archive-writer'},reader:{id:'fixture.journal-reader'},retention:{id:'mote.retain-source-archive'}},
      trigger:{policy:{id:'mote.on-receive'}},group:{policy:{id:'fixture.journal-group'}},window:{policy:{id:'fixture.journal-window'}},join:{policy:{id:'fixture.journal-join'}},aggregation:{policy:{id:'fixture.journal-count'}},
      steps:[{id:'text',use:{id:'fixture.journal-text'},dependsOn:[]}],publish:{use:{id:'fixture.journal-publish'}},index:{use:{id:'mote.material-index'}},exposure:{use:{id:'mote.coding-exposure'},routes:[]}}));
    ctx.effect(()=>ctx.moteSourcePipelines.register({id:'fixture.journal',featureId:'fixture.journal',version:'1',sourceKinds:['fixture.journal'],storage:'archive',index:'material',modelInput:'material',reprocess:'deterministic',recipe:{id:'fixture.journal',version:'1'}}));
    ctx.effect(()=>ctx.moteMaterialCatalog.register({id:'fixture.journal',kind:'fixture.journal',schemaVersion:1,label:'Generated journal',card:'fixture.journal-card',detail:'fixture.journal-detail'}));
    ctx.effect(()=>ctx.moteContextProcessors.register({id:'fixture.journal-statistics',version:'1',lane:'extract',deterministic:true,produces:[{key:'statistics',kind:'fixture.statistics'}],async process({materials}){return [{kind:'fixture.statistics',text:String(materials.reduce((count,page)=>count+page.text.length,0)),metadata:{productKey:'statistics',schemaVersion:1}}];}}));
    ctx.effect(()=>ctx.moteMaterialConsumers.register({id:'fixture.journal-statistics',version:'1',processor:'fixture.journal-statistics',processorVersion:'1',accepts:{kind:'fixture.journal',schemaVersion:1,key:'body'}}));
  },
};
