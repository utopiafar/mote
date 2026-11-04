import type {FastifyInstance,FastifyReply} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {scopeFields,validRange} from '../../query-scope.js';
import {modelProfileIdSchema,type ModelSettingsStore} from '../../model-settings.js';
import {MemoryOutputValidationError,MEMORY_EXTRACTION_PROMPT,memoryEvidenceFingerprint,type MemoryStore} from '../../memory.js';
import {memoryReviewReceipt,type MemoryDraftOrigin} from '../../memory-review.js';
import type {MemoryReviewStrategy} from '../../memory-strategy-contract.js';
import type {MemoryPipeline} from '../../memory-pipeline.js';
import type {MemoryInputSelection} from '../../evidence-read-ports.js';
import type {FileStore} from '../../files.js';
import {StoreError,type Store} from '../../store.js';
import type {ModelAuthorizationHost} from '../../model-authorization-host.js';
import type {ModelConnection} from '../../background-model-authorization.js';
import {EvidenceExposurePolicy} from '../../evidence-exposure.js';
import type {MemoryOwnerPublication} from '../../plugins/memory-publication-contract.js';

export interface MemoryOwnerRouteDependencies {
  readonly owner:Pick<MemoryOwnerPublication,'publish'|'correct'|'delete'|'withOwnerWork'>;
  readonly readable:()=>boolean;
  readonly writable:()=>boolean;
}

export interface MemoryExtractRouteDependencies {
  readonly owner:Pick<MemoryOwnerPublication,'withOwnerWork'>;
  readonly pipeline:()=>MemoryPipeline;
  readonly store:Store;
  readonly files:FileStore;
  readonly evidenceReader:MemoryInputSelection;
  readonly memories:MemoryStore;
  readonly modelSettings:ModelSettingsStore;
  readonly query:(input:QueryInput)=>Promise<QueryResult>;
  readonly reviewExtraction:(input:QueryInput,result:QueryResult,strategy?:MemoryReviewStrategy,draftOrigin?:MemoryDraftOrigin)=>Promise<QueryResult>;
  readonly modelAuthorizationHost:ModelAuthorizationHost;
  readonly availableModelConnections:()=>ModelConnection[];
  readonly readable:()=>boolean;
  readonly writable:()=>boolean;
}

const routeGuard=(readable:()=>boolean,writable:()=>boolean)=>async(request:{method:string},reply:FastifyReply)=>{
  const write=request.method!=='GET'&&request.method!=='HEAD';
  if(write?!writable():!readable())return reply.code(503).send({error:'feature_unavailable'});
};

/** C24's owner mutations. A disabled publication activation refuses them before
 * any body, model or remote provider work begins. */
export function registerMemoryOwnerRoutes(app:FastifyInstance,dependencies:MemoryOwnerRouteDependencies){
  app.register(async child=>{
    child.addHook('onRequest',routeGuard(dependencies.readable,dependencies.writable));
    child.post('/api/memories/:id/publish',async req=>{const body=z.object({version:z.number().int().positive().optional()}).strict().parse(req.body??{});return dependencies.owner.withOwnerWork(()=>dependencies.owner.publish((req.params as {id:string}).id,body.version));});
    child.post('/api/memories/:id/correct',async req=>dependencies.owner.withOwnerWork(()=>dependencies.owner.correct((req.params as {id:string}).id,req.body)));
    child.delete('/api/memories/:id',async req=>dependencies.owner.delete((req.params as {id:string}).id));
  });
}

/** One reviewed manual extraction still starts model work, so it belongs to the
 * publication owner that must remain active to stage and commit its result. */
export function registerMemoryExtractRoute(app:FastifyInstance,dependencies:MemoryExtractRouteDependencies){
  app.register(async child=>{
    child.addHook('onRequest',routeGuard(dependencies.readable,dependencies.writable));
    child.post('/api/memories/extract',async req=>{
      const execute=async()=>{
        const pipeline=dependencies.pipeline();
        pipeline.assertNewManualWork();
        const operationId='owner-extract:'+randomUUID();
        const {modelProfileId,...scope}=z.object({...scopeFields,modelProfileId:modelProfileIdSchema.optional()}).strict().refine(validRange).parse(req.body??{}),profile=dependencies.modelSettings.select('memory',modelProfileId);
        const selected=dependencies.evidenceReader.memorySelection(scope,undefined,new EvidenceExposurePolicy());
        if(!selected.evidenceIds.length)throw new StoreError('No processed evidence in this range',409);
        const records=dependencies.memories.readEvidence(selected.evidenceIds),expectedFingerprints=Object.fromEntries(records.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
        const evidenceRanges=records.map(record=>({id:record.id,offset:0,length:record.ocrText.length}));
        const input:QueryInput={...scope,evidenceRanges,evidenceIds:selected.evidenceIds,modelProfileId:profile.id,modelOverride:profile.settings.model,skill:'memory-extraction',responseMode:'memory-extraction',question:MEMORY_EXTRACTION_PROMPT};
        input.validateOutput=result=>{try{pipeline.inputs.assert(result.citations.map(c=>c.id),profile.id);dependencies.memories.extract(result,profile.settings.model,{requireAdmission:true,validateOnly:true,expectedFingerprints});}catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;return {code:error.code,feedback:error.repairInstruction};}};
        const context={phase:'extract' as const,opId:operationId,evidenceIds:selected.evidenceIds,assertAuthority:()=>pipeline.inputs.assert(selected.evidenceIds,profile.id)};
        try{
          const native=await pipeline.nativeStages.prepare(input,context),draft=native??await dependencies.query(input);
          pipeline.inputs.assert(draft.citations.map(c=>c.id),profile.id);
          if(!native)dependencies.memories.extract(draft,profile.settings.model,{requireAdmission:true,validateOnly:true,expectedFingerprints});
          const result=await dependencies.reviewExtraction(input,draft,undefined,native?'native-engine':'mote');
          const options={requireAdmission:true,expectedFingerprints,reviewRunId:memoryReviewReceipt(result)?.reviewRunId,reviewReceipt:memoryReviewReceipt(result)};
          const assert=()=>pipeline.inputs.assert(result.citations.map(c=>c.id),profile.id);
          assert();pipeline.publication?.retainOutput(operationId,{result,reviewReceipt:memoryReviewReceipt(result)},{evidenceIds:selected.evidenceIds});
          if(native&&pipeline.publication?.retainedOutput(operationId))await pipeline.nativeStages.settle(context);
          const publication=await pipeline.publication?.stageExtract(operationId,result,profile.settings.model,options,assert);
          return pipeline.inputs.withCurrent(result.citations.map(c=>c.id),()=>{
            pipeline.publication?.assert(publication,result);const saved=dependencies.memories.extract(result,profile.settings.model,{...options,prepared:publication?.prepared});pipeline.publication?.committed(publication);return saved;
          },profile.id);
        }catch(error){pipeline.nativeStages.abandon(context);throw error;}
      };
      return dependencies.modelAuthorizationHost.manual('owner-extract:'+randomUUID(),dependencies.availableModelConnections(),()=>dependencies.owner.withOwnerWork(execute));
    });
  });
}
