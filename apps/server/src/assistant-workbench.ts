import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {formatEvidenceRef,sourceContentTime,workspaceRequestSchema,workspaceCommandSchema,
  type QueryScope,type WorkspaceRequest,type WorkspaceView,type WorkspaceCommandReference} from '@mote/shared';
import type {DeclarativeComponent} from '@mote/shared/plugin-ui';
import {AssistantMatters,type Matter,type MatterAuthority} from './assistant-matters.js';
import type {AssistantCommitments} from './assistant-commitments.js';
import {readCurrentMemoryPage} from './current-memory.js';
import {EvidenceExposurePolicy} from './evidence-exposure.js';
import type {EvidenceReader} from './evidence-reader.js';
import type {Memory} from './memory-schema.js';
import type {MemoryOwnerPublication} from './plugins/memory-publication-contract.js';
import {StoreError,type Store} from './store.js';

const LIMIT=20;
const emptyScope=(scope:QueryScope)=>scope.evidenceIds?.length===0||scope.kind==='selection'&&scope.sourceIds?.length===0;
const fields=(...keys:string[])=>keys.map(key=>({key,labelKey:key}));
const list=(itemKey:string,...keys:string[]):DeclarativeComponent=>({type:'list',itemKey,fields:fields(...keys)});

/** A saved scope can narrow a workbench, never expand the request. In
 * particular, a broad owner goal must not appear in a narrow source view. */
function containsScope(request:QueryScope,saved:QueryScope){
  if(request.deviceId!==undefined&&request.deviceId!==saved.deviceId)return false;
  if(request.after!==undefined&&(saved.after===undefined||Date.parse(saved.after)<Date.parse(request.after)))return false;
  if(request.before!==undefined&&(saved.before===undefined||Date.parse(saved.before)>Date.parse(request.before)))return false;
  if(request.evidenceIds!==undefined&&(saved.evidenceIds===undefined||saved.evidenceIds.some(id=>!request.evidenceIds!.includes(id))))return false;
  if(request.kind==='selection'&&request.sourceIds!==undefined&&
    (saved.kind!=='selection'||saved.sourceIds===undefined||saved.sourceIds.some(id=>!request.sourceIds!.includes(id))))return false;
  return true;
}

/** Fixed compositions over existing domain readers. There is no workspace
 * store or cached body to retire: every request and command rebuilds its
 * projection under current evidence/source/Memory authority. */
export class AssistantWorkbench {
  constructor(private readonly store:Store,private readonly reader:EvidenceReader,
    private readonly matters:AssistantMatters,private readonly commitments:AssistantCommitments,
    private readonly memoryOwner:Pick<MemoryOwnerPublication,'correct'|'withOwnerWork'>){}

  private policy(scope:QueryScope){
    return scope.kind==='selection'&&scope.sourceIds!==undefined?
      new EvidenceExposurePolicy([],context=>scope.sourceIds!.includes(context.sourceId??'')):new EvidenceExposurePolicy();
  }
  private selected(id:string,scope:QueryScope){
    if(scope.evidenceIds===undefined||scope.evidenceIds.includes(id))return true;
    const roots=this.reader.memories.dependencyIds(id).filter(parent=>parent!==id&&
      Boolean(this.store.db.prepare('SELECT 1 FROM captures WHERE id=?').get(parent)));
    return roots.length>0&&roots.every(parent=>scope.evidenceIds!.includes(parent));
  }
  private evidence(ids:readonly string[],scope:QueryScope){
    if(emptyScope(scope))return [];
    const policy=this.policy(scope);
    return this.reader.evidence(ids.map(id=>formatEvidenceRef('capture',id)),scope).filter(record=>
      !record.privacy.excluded&&this.selected(record.id,scope)&&this.reader.memories.isCurrentEvidence(record.id)&&
      this.reader.contextDependenciesAllowed([record.id],policy));
  }
  private visible(matter:Matter,scope:QueryScope){
    if(emptyScope(scope)||!containsScope(scope,matter.scope))return false;
    if(matter.scope.kind==='selection'&&matter.scope.sourceIds?.some(id=>{
      try{this.reader.sources.getSource(id);return false;}catch{return true;}
    }))return false;
    return this.evidence(matter.evidenceIds,scope).length===matter.evidenceIds.length;
  }
  private matter(id:string,scope:QueryScope){
    try{const value=this.matters.get(id);return this.visible(value,scope)?value:undefined;}
    catch(error){if(error instanceof StoreError&&error.statusCode===404)return;throw error;}
  }
  private memoryCurrent(memory:Memory,scope:QueryScope){
    const {kind,...bounds}=scope;
    const current=this.reader.memoryPage({...bounds,id:formatEvidenceRef('memory',memory.id),status:'published',
      layer:'memory',includeHistory:false,includeStale:false,limit:1},false).items[0];
    return current?.id===memory.id&&this.reader.memories.get(memory.id).version===memory.version;
  }
  private memorySources(memory:Memory){
    return [...new Set(memory.evidence.flatMap(proof=>{
      if(!proof.sourceId)return [];
      try{return [this.reader.sources.getSource(proof.sourceId).name];}catch{return [];}
    }))].join(', ');
  }

  async read(raw:unknown):Promise<WorkspaceView>{
    const request=workspaceRequestSchema.parse(raw),scope=request.scope;
    const data:Record<string,unknown>={matters:[],memories:[],commitments:[],progress:[],files:[],evidence:[]};
    const commands:WorkspaceCommandReference[]=[{id:'refresh',apiVersion:'1'}];
    const problems:DeclarativeComponent[]=[];
    const failed=()=>problems.push({type:'status',state:'error',textKey:'failed'});
    const unavailable=()=>problems.push({type:'status',state:'unavailable',textKey:'unavailable'});
    const limited=()=>problems.push({type:'status',state:'unavailable',textKey:'limited'});
    let target:Matter|undefined,person:Memory|undefined,memories:Memory[]=[],readScope=scope;

    if(!emptyScope(scope)){
      try{
        target=request.matterId?this.matter(request.matterId,scope):undefined;
        if(target)readScope=target.scope;
        if(request.matterId&&!target)unavailable();
      }catch{failed();}

      if(!request.matterId||target){
        try{
          const page=await readCurrentMemoryPage(this.reader,readScope,{id:request.personMemoryId,level:'detail',limit:LIMIT});
          // The provider read is asynchronous. Check all cards once more after
          // it settles, so a withdrawal/correction cannot retain an early body.
          memories=page.items.filter(memory=>this.memoryCurrent(memory,readScope));
          person=request.personMemoryId?memories.find(memory=>memory.id===request.personMemoryId):undefined;
          if(request.personMemoryId&&!person)unavailable();
          if(page.nextCursor)limited();
        }catch{failed();}
      }
      const targetAvailable=(!request.matterId||target)&&(!request.personMemoryId||person);
      if(targetAvailable){
        // Recheck synchronous target authority after the asynchronous read.
        if(target&&this.matter(target.id,scope)?.revision!==target.revision){target=undefined;memories=[];unavailable();}
        else{
          data.memories=memories.map(memory=>({id:memory.id,title:memory.title,statement:memory.statement,
            uncertainty:memory.uncertainty,state:memory.status,source:this.memorySources(memory)}));
          if(target){
            Object.assign(data,{goal:target.goal,state:target.state});
            if(target.state!=='archived')commands.push(
              {id:'matter.edit',apiVersion:'1',matterId:target.id,expectedRevision:target.revision},
              {id:target.state==='active'?'matter.pause':'matter.resume',apiVersion:'1',matterId:target.id,expectedRevision:target.revision},
              {id:'matter.archive',apiVersion:'1',matterId:target.id,expectedRevision:target.revision});
          }
          if(person){
            Object.assign(data,{title:person.title,statement:person.statement,state:person.status});
            commands.push({id:'memory.correct',apiVersion:'1',memoryId:person.id,version:person.version});
          }
          try{
            const page=this.commitments.page({scope:readScope,matterId:target?.id,personMemoryId:person?.id,limit:LIMIT});
            data.commitments=page.items.map(item=>({id:item.id,title:item.title,state:item.status,
              deadline:item.deadline?.text??null,dueState:item.dueState}));
            data.progress=page.items.flatMap(item=>item.timeline.map(event=>({summary:event.summary,
              occurredAt:event.occurredAt,recordedAt:event.createdAt,kind:event.origin==='proposal'?event.kind:'owner'}))).slice(0,LIMIT);
            if(page.nextCursor||page.items.reduce((count,item)=>count+item.timeline.length,0)>LIMIT)limited();
          }catch{failed();}
          const related=target?.evidenceIds.length?new Set(target.evidenceIds):person?
            new Set(person.evidenceIds.flatMap(id=>this.reader.memories.dependencyIds(id))):undefined;
          try{
            const files=this.reader.files;
            if(!files)unavailable();
            else{
              const sourceId=readScope.kind==='selection'&&readScope.sourceIds?.length===1?readScope.sourceIds[0]:undefined;
              const page=files.list({after:readScope.after,before:readScope.before,deviceId:readScope.deviceId,sourceId,limit:100});
              const visible=page.items.filter(item=>(!related||related.has(item.captureId))&&this.evidence([item.captureId],readScope).length);
              data.files=visible.slice(0,LIMIT).map(item=>{
                const view=files.fileView(item.captureId);
                // Keep FileView coverage, independent original availability
                // and locators; never embed item.text or an executable URI.
                return {id:view.captureId,title:view.item.title,source:view.sourceId,retention:view.retention,
                  extraction:view.coverage.extraction.status,semantic:view.coverage.semantic.status,embedding:view.coverage.embedding.status,
                  reason:view.coverage.extraction.reason??null,
                  original:view.canOpenOriginal,originMissing:view.originMissing,coverage:view.coverage};
              });
              if((data.files as {extraction:string;semantic:string}[]).some(item=>item.extraction==='failed'||item.semantic==='failed'))failed();
              if(visible.length>LIMIT)limited();
            }
          }catch{data.files=[];failed();}
          try{
            const ids=related?[...related]:memories.flatMap(memory=>memory.evidenceIds);
            data.evidence=this.evidence([...new Set(ids)],readScope).slice(0,LIMIT).map(record=>({
              ref:formatEvidenceRef('capture',record.id),title:record.windowTitle||record.appName,observedAt:record.capturedAt,
              recordedAt:record.provenance?.document?.recordedAt??null,occurredAt:record.provenance?.document?.occurredAt??null,
            }));
          }catch{failed();}
        }
      }
    }else problems.push({type:'status',state:'empty',textKey:'empty'});

    // Enumerate choices after all asynchronous provider reads. A choice label
    // has the same current disclosure rules as the detail it opens.
    if(!emptyScope(scope)&&request.template!=='person'&&(!request.matterId||target))try{
      const page=this.matters.page({limit:100}),visible=page.items.filter(item=>this.visible(item,scope));
      data.matters=visible.slice(0,LIMIT).map(item=>({id:item.id,title:item.goal,state:item.state}));
      if(visible.length>LIMIT)limited();
    }catch{failed();}
    const sections:Record<WorkspaceRequest['template'],DeclarativeComponent[]>={
      project:[list('matters','title','state'),list('commitments','title','state','deadline'),list('progress','summary','occurredAt','recordedAt'),list('files','title','extraction'),list('memories','title','statement')],
      person:[list('memories','title','statement','source'),list('commitments','title','state','deadline'),list('progress','summary','occurredAt','recordedAt'),list('evidence','title','observedAt','occurredAt','recordedAt')],
      travel:[list('matters','title','state'),list('commitments','title','deadline','state'),list('files','title','original','extraction'),list('memories','title','statement')],
      reading:[list('matters','title','state'),list('files','title','extraction','reason','semantic','embedding','original'),list('memories','title','statement'),list('evidence','title','observedAt','occurredAt','recordedAt')],
    };
    const components:DeclarativeComponent[]=[{type:'detail',fields:request.template==='person'?fields('title','statement','state'):fields('goal','state')},
      ...sections[request.template],...problems];
    if(commands.some(command=>command.id==='matter.edit'))components.push({type:'form',fields:[{key:'goal',labelKey:'goal',input:'text',required:true}],submitCommand:'matter.edit'});
    if(commands.some(command=>command.id==='memory.correct'))components.push({type:'form',fields:[
      {key:'title',labelKey:'title',input:'text',required:true},{key:'statement',labelKey:'statement',input:'text',required:true},
    ],submitCommand:'memory.correct'});
    for(const command of commands)if(!['matter.edit','memory.correct'].includes(command.id))components.push({
      type:'action',command:command.id,labelKey:command.id.replace('matter.',''),
    });
    return {request,descriptor:{id:`assistant.workbench.${request.template}`,kind:'declarative-view',apiVersion:'1',platforms:['web','mac','android'],
      presentation:{labelKey:request.template,i18nNamespace:'mote'},commands:commands.map(({id,apiVersion})=>({id,apiVersion}))},
      spec:{components},data,commands};
  }

  async command(raw:unknown):Promise<WorkspaceView>{
    const {request,command,input}=workspaceCommandSchema.parse(raw);
    const view=await this.read(request);
    if(!view.commands.some(current=>isDeepStrictEqual(current,command)))throw new StoreError('Workspace command changed; reload before continuing',409);
    if(command.id==='memory.correct'){
      const values=z.object({title:z.string().trim().min(1).max(500),statement:z.string().trim().min(1).max(8000)}).strict().parse(input);
      const corrected=await this.memoryOwner.withOwnerWork(async()=>{
        const current=(await readCurrentMemoryPage(this.reader,request.scope,{id:command.memoryId,level:'detail',limit:1})).items[0];
        if(!current||current.version!==command.version||!this.memoryCurrent(current,request.scope))throw new StoreError('Workspace command changed; reload before continuing',409);
        return this.memoryOwner.correct(command.memoryId,{...values,version:command.version});
      });
      return this.read({...request,personMemoryId:corrected.id});
    }
    if(command.id.startsWith('matter.')&&'matterId' in command){
      if(this.matter(command.matterId,request.scope)?.revision!==command.expectedRevision)throw new StoreError('Workspace command changed; reload before continuing',409);
      const values=command.id==='matter.edit'?z.object({goal:z.string().trim().min(1).max(8000)}).strict().parse(input):z.object({}).strict().parse(input??{});
      const authority:MatterAuthority={currentEvidence:ids=>this.evidence(ids,request.scope).map(record=>({id:record.id,
        title:record.windowTitle,sourceId:record.provenance?.sourceId,deviceId:record.deviceId,at:sourceContentTime(record)})),currentTask:()=>undefined};
      this.matters.command({type:command.id.slice('matter.'.length),matterId:command.matterId,expectedRevision:command.expectedRevision,...values},authority);
    }else z.object({}).strict().parse(input??{});
    return this.read(request);
  }
}
