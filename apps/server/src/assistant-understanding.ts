import {z} from 'zod';
import {evidenceRefId,formatArtifactRef,formatEvidenceRef,parseArtifactRef,queryScopeSchema,type CaptureRecord,type EvidenceDependencies,type FileCoverage,type QueryScope,type SourceContextDeclaration} from '@mote/shared';
import {EvidenceExposurePolicy,defaultEvidenceExposurePolicy} from './evidence-exposure.js';
import {EvidenceReader} from './evidence-reader.js';
import {parseMaterialRef,type MaterialRecord,type MaterialStore} from './materials.js';
import {parseSemanticProducts} from './semantic-extraction.js';
import {validateConversationClaims} from './conversation-understanding.js';
import {combineSourceContextDependencies} from './source-context-lineage.js';
import {StoreError,type Store} from './store.js';

type Range={id:string;offset:number;length:number};
type MaterialRange={ref:string;offset:number;length:number;total:number};
type Product=ReturnType<typeof parseSemanticProducts>;
type Original=Pick<CaptureRecord,'id'|'deviceId'|'capturedAt'|'receivedAt'|'provenance'|'attributionContext'> & {offset:number;length:number;quote:string};
export type AssistantUnderstandingProduct={
  ref:string;generatedAt:string;summary:string;
  events:Product['events'];workRecords:NonNullable<Product['workRecords']>;memoryCandidates:Product['memoryCandidates'];
  /** These are original ranges used by the whole product, not proof that each
   * range supports the summary. The producer does not persist that mapping. */
  sourceEvidence:Original[];
  coverage:MaterialRange[];
  /** Includes read-but-uncited originals. This is invalidation lineage, not a read grant. */
  disclosureDependencies:EvidenceDependencies;
  sourceContextDependencies:SourceContextDeclaration[];
};
export type AssistantUnderstandingInput={
  material:MaterialRecord;
  coverage:{extraction:FileCoverage;semantic:FileCoverage;semanticRanges:MaterialRange[]};
  products:AssistantUnderstandingProduct[];nextCursor:string|null;disclosureDependencies:EvidenceDependencies;sourceContextDependencies:SourceContextDeclaration[];
};

const rawRange=z.object({id:z.string().uuid(),offset:z.number().int().nonnegative().safe(),length:z.number().int().positive().safe()}).strict();
const pageRange=z.object({ref:z.string(),offset:z.number().int().nonnegative().safe(),length:z.number().int().positive().safe(),total:z.number().int().nonnegative().safe()}).strict();
const citations=z.array(z.string().uuid());
const invalid=()=>new StoreError('Semantic product has invalid original references or coverage',409);
const unavailable=()=>new StoreError('Material or semantic product is unavailable in the selected scope',404);
const contains=(ranges:readonly Range[],range:Range)=>ranges.some(item=>item.id===range.id&&item.offset<=range.offset&&range.offset+range.length<=item.offset+item.length);
const splitPair=(text:string,at:number)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at]);
function union(ranges:readonly Range[]){
  const result:Range[]=[];
  for(const range of [...ranges].sort((a,b)=>a.id.localeCompare(b.id)||a.offset-b.offset)){
    const prior=result.at(-1);
    if(prior?.id===range.id&&range.offset<=prior.offset+prior.length)prior.length=Math.max(prior.length,range.offset+range.length-prior.offset);
    else result.push({...range});
  }
  return result;
}

const originalBodyUnavailable=(material:MaterialRecord)=>material.fidelity.state==='summary-only'||
  material.coverage.reason==='original_body_not_collected'||Boolean(material.fidelity.limitations?.includes('original_body_not_collected'));
function extractionCoverage(material:MaterialRecord):FileCoverage {
  const body=material.artifacts?.find(item=>item.key==='source-body');
  const extracted=material.artifacts?.find(item=>item.key==='extracted-text');
  if(originalBodyUnavailable(material))
    return {status:'unsupported',reason:'original_body_not_collected'};
  if(extracted?.state==='failed')return {status:'failed',...(extracted.reason?{reason:extracted.reason}:{})};
  if(extracted?.state==='pending')return {status:'pending',...(extracted.reason?{reason:extracted.reason}:{})};
  if(extracted?.state==='unavailable')return {status:'partial',reason:extracted.reason??material.coverage.reason??'extracted_text_unavailable'};
  if(body?.state==='unavailable'&&!extracted)return {status:'unsupported',reason:body.reason??'source_body_unavailable'};
  return {status:material.coverage.state==='complete'?'ready':material.coverage.state,...(material.coverage.reason?{reason:material.coverage.reason}:{})};
}
/** Local, read-only input adapter for assistant consumers. Its scope is a
 * selection, never a grant; all disclosures use the current EvidenceReader
 * policy and the pinned original lineage on every call. */
export class AssistantUnderstandingReader {
  constructor(private readonly store:Store,private readonly materials:MaterialStore,private readonly reader:EvidenceReader,
    private readonly policy:EvidenceExposurePolicy=defaultEvidenceExposurePolicy){}

  private selectionAllows(id:string,scope:QueryScope,seen=new Set<string>()):boolean {
    if(scope.evidenceIds===undefined)return true;
    if(scope.evidenceIds.includes(id))return true;
    if(seen.has(id))return false;
    seen.add(id);
    const deps=this.store.db.prepare('SELECT evidence_id id FROM material_evidence_dependencies WHERE anchor_id=?').all(id).map(row=>String(row.id));
    const chunk=this.store.db.prepare('SELECT capture_id id FROM file_chunks WHERE id=?').get(id);
    const parents=deps.length?deps:chunk?[String(chunk.id)]:[];
    return parents.length>0&&parents.every(parent=>this.selectionAllows(parent,scope,new Set(seen)));
  }
  private authorized(ids:readonly string[],scope:QueryScope){
    if(ids.some(id=>!this.selectionAllows(id,scope)))return false;
    if(ids.some(id=>!this.materials.isCurrentEvidence(id)&&!this.reader.files?.isCurrentEvidence(id)&&!this.store.isCurrentEvidence(id)))return false;
    if(!this.reader.contextDependenciesAllowed(ids,this.policy))return false;
    if(scope.kind==='selection'&&scope.sourceIds!==undefined){
      const sources=new Set(scope.sourceIds),restriction=new EvidenceExposurePolicy([],context=>sources.has(context.sourceId??''));
      if(!this.reader.contextDependenciesAllowed(ids,restriction))return false;
    }
    return true;
  }
  private material(ref:string,scope:QueryScope){
    let parsed:ReturnType<typeof parseMaterialRef>;
    try{parsed=parseMaterialRef(ref);}catch{throw unavailable();}
    if(!parsed.revision||!this.reader.queryMaterialReference(ref,scope,this.policy))throw unavailable();
    const material=this.materials.get(ref);
    if(!material||material.ref!==ref||this.materials.get(material.id)?.ref!==ref||
      scope.kind==='selection'&&scope.sourceIds!==undefined&&!scope.sourceIds.includes(material.origin.sourceId))throw unavailable();
    const members:string[]=[];let archiveMember=false;
    for(let offset=0;offset<material.memberCount;offset+=200){
      const page=this.materials.members(ref,{offset,limit:200});
      for(const member of page.items){
        if(member.kind==='archive'){archiveMember=true;continue;}
        const id=member.kind==='capture'?evidenceRefId(member.ref,'capture'):undefined;
        if(!id)throw unavailable();members.push(id);
      }
    }
    const anchors=this.materials.evidenceIds(ref);
    if(anchors.some(id=>!this.materials.isCurrentEvidence(id))||!this.authorized([...members,...anchors],scope))throw unavailable();
    return {material,members,anchors,complete:material.memberCount>0&&(!archiveMember||anchors.length>0)};
  }
  private candidates(material:MaterialRecord,members:string[]){
    const hasMaterialInputs=Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_material_inputs'").get());
    return this.store.db.prepare(`WITH RECURSIVE related(id) AS (
      SELECT artifact_id FROM artifact_inputs WHERE observation_id IN (SELECT value FROM json_each(?))
      ${hasMaterialInputs?'UNION SELECT artifact_id FROM artifact_material_inputs WHERE material_id=? AND revision=?':''}
      UNION SELECT d.artifact_id FROM artifact_dependencies d JOIN related r ON d.parent_id=r.id
    ) SELECT a.id,a.revision FROM context_artifacts a JOIN related r ON r.id=a.id
      WHERE a.kind='semantic' ORDER BY a.id`).all(JSON.stringify(members),...(hasMaterialInputs?[material.id,material.revision]:[])) as {id:string;revision:string}[];
  }
  private originalAllowed(context:ReturnType<AssistantUnderstandingReader['material']>,id:string){
    if(!context.anchors.includes(id))return true;
    const row=this.store.db.prepare('SELECT block_id FROM material_evidence WHERE id=? AND material_id=?').get(id,context.material.id);
    // Organizer metadata describes the source; it is not a passage from it.
    return Boolean(row&&!['source-metadata','record-metadata'].includes(String(row.block_id)));
  }
  private contextPins(ids:readonly string[],material:MaterialRecord){
    const unique=[...new Set(ids)],encoded=JSON.stringify(unique);
    const chunks=new Map(this.store.db.prepare('SELECT c.id,c.capture_id FROM file_chunks c JOIN json_each(?) selected ON selected.value=c.id')
      .all(encoded).map(row=>[String(row.id),String(row.capture_id)]));
    const captures=new Map(this.store.evidenceMetadata([...unique,...chunks.values()]).map(record=>[record.id,record]));
    const metadata=unique.map(id=>({...captures.get(id)??captures.get(chunks.get(id)??''),id,ocrText:''}) as CaptureRecord);
    return combineSourceContextDependencies([material.attributionContext?.sourceContextDeclarations,
      ...this.materials.contextsForEvidence(metadata).map(context=>context.sourceContextDeclarations)]);
  }
  private records(ids:readonly string[],scope:QueryScope,context:ReturnType<AssistantUnderstandingReader['material']>){
    if(!this.authorized(ids,scope))throw unavailable();
    // The whole pinned Material has already passed the reader's time/device
    // gate. Its archive anchors can carry an import observation time rather
    // than the source's authored time, so do not reclassify that observation as
    // an event time. Other originals still use their own full range checks.
    const anchors=new Set(context.anchors),materialIds=ids.filter(id=>anchors.has(id)),otherIds=ids.filter(id=>!anchors.has(id));
    const records=[...this.reader.evidence(otherIds.map(id=>formatEvidenceRef('capture',id)),scope),
      ...this.reader.evidence(materialIds.map(id=>formatEvidenceRef('capture',id)),{...scope,after:undefined,before:undefined})];
    const byId=new Map(records.map(record=>[record.id,record]));
    if(ids.some(id=>!byId.has(id)||!this.reader.memories.isCurrentEvidence(id)))throw unavailable();
    return byId;
  }
  private product(ref:string,scope:QueryScope,context:ReturnType<AssistantUnderstandingReader['material']>):AssistantUnderstandingProduct|undefined {
    if(originalBodyUnavailable(context.material))return;
    const parsed=parseArtifactRef(ref);if(!parsed)throw unavailable();
    const artifact=this.reader.artifact(ref,scope),lineage=this.reader.artifactDependencies(ref,scope);
    if(!artifact||!lineage||artifact.kind!=='semantic'||!this.authorized(lineage.members,scope))throw unavailable();
    if(!['mote.segment-understanding','mote.coding-conversation-understanding'].includes(artifact.processor))return;
    const metadata=artifact.metadata;
    if(metadata.complete!==true)return;
    if(metadata.productsVersion!==1&&metadata.productsVersion!==3||metadata.productsVersion===3&&metadata.workContract!=='range-evaluation@1')throw invalid();
    try{
      const ranges=rawRange.array().parse(metadata.evidenceRanges),support=rawRange.array().parse(metadata.supportRanges??metadata.evidenceRanges);
      const cited=citations.parse(metadata.citations),ids=[...new Set([...ranges,...support].map(item=>item.id))];
      const allowed=new Set([...lineage.members,...context.anchors]);
      if(ids.some(id=>!allowed.has(id))||cited.some(id=>!ids.includes(id))||ids.some(id=>!cited.includes(id)&&support.some(item=>item.id===id)))throw invalid();
      const records=this.records(ids,scope,context);
      for(const range of [...ranges,...support]){
        const text=records.get(range.id)!.ocrText;
        if(!Number.isSafeInteger(range.offset+range.length)||range.offset+range.length>text.length||splitPair(text,range.offset)||splitPair(text,range.offset+range.length))throw invalid();
      }
      if(support.some(range=>!contains(ranges,range)))throw invalid();
      const coverage:MaterialRange[]=[];
      if(artifact.processor==='mote.coding-conversation-understanding'){
        const inputs=artifact.materialInputs??[];
        const declared=z.object({scope:z.literal('bounded-conversation'),ranges:pageRange.array().min(1),source:z.unknown()}).strict().parse(metadata.coverage);
        if(!inputs.length||inputs.length!==declared.ranges.length||metadata.materialRef!==context.material.ref)throw invalid();
        const mapped:Range[]=[];
        for(const [index,input] of inputs.entries()){
          const range=declared.ranges[index];
          if(input.ref!==context.material.ref||range.ref!==input.ref||range.offset!==input.offset||range.length>input.length||range.total!==context.material.textLength||range.offset+range.length>range.total)throw invalid();
          const page=this.reader.materialRead({ref:input.ref,...scope,offset:input.offset,length:input.length});
          if(page.text.length!==range.length)throw invalid();
          let cursor=0;
          for(const span of page.spans){
            if(span.kind!=='text'||span.pageRange.start!==cursor||!span.evidenceId||!Number.isSafeInteger(span.evidenceOffset)||span.evidenceOffset!<0)throw invalid();
            const record=records.get(span.evidenceId),length=span.pageRange.end-span.pageRange.start;
            if(!record||length<1||record.ocrText.slice(span.evidenceOffset!,span.evidenceOffset!+length)!==page.text.slice(span.pageRange.start,span.pageRange.end))throw invalid();
            mapped.push({id:span.evidenceId,offset:span.evidenceOffset!,length});
            cursor=span.pageRange.end;
          }
          if(cursor!==page.text.length)throw invalid();
          coverage.push(range);
        }
        if(JSON.stringify(union(ranges))!==JSON.stringify(union(mapped)))throw invalid();
      }
      const output=parseSemanticProducts(JSON.stringify({summary:metadata.summary??artifact.text,evidence:[],events:metadata.events,
        workRecords:metadata.workRecords,memoryCandidates:metadata.memoryCandidates,actionCues:metadata.actionCues}),[...records.values()],cited,ranges,
        metadata.productsVersion===3?'range-evaluation@1':undefined);
      if(output.evidenceRanges.some(range=>!contains(support,range)))throw invalid();
      if(artifact.processor==='mote.coding-conversation-understanding')validateConversationClaims(output,[...records.values()]);
      for(const candidate of output.memoryCandidates){
        if(!candidate.admission||!candidate.evidence||candidate.evidenceIds.some(id=>!candidate.evidence!.some(span=>span.id===id))||candidate.evidence.some(span=>!candidate.evidenceIds.includes(span.id)))throw invalid();
      }
      const sourceEvidence=support.map(range=>{
        const record=records.get(range.id)!;
        if(record.provenance?.document?.contentRole==='summary'||record.provenance?.layer==='reference'||!this.originalAllowed(context,record.id))throw invalid();
        return {deviceId:record.deviceId,capturedAt:record.capturedAt,receivedAt:record.receivedAt,
          provenance:record.provenance,attributionContext:record.attributionContext,...range,quote:record.ocrText.slice(range.offset,range.offset+range.length)};
      });
      const disclosureDependencies:EvidenceDependencies={version:1,complete:context.complete,ids:[...new Set([...context.members,...context.anchors,...lineage.members,...ids])]};
      const sourceContextDependencies=this.contextPins(disclosureDependencies.ids,context.material);
      return {ref,generatedAt:artifact.generatedAt,summary:output.summary,events:output.events,workRecords:output.workRecords??[],memoryCandidates:output.memoryCandidates,sourceEvidence,coverage,disclosureDependencies,sourceContextDependencies};
    }catch(error){if(error instanceof StoreError&&(error.statusCode===404||error.statusCode===409))throw error;throw invalid();}
  }
  /** Read one bounded product page. Missing products and omitted pages never
   * imply that the unprocessed source contains no events or other claims. */
  read(input:{ref:string;scope:QueryScope;cursor?:string;limit?:number}):AssistantUnderstandingInput {
    const scope=queryScopeSchema.parse(input.scope),context=this.material(input.ref,scope),limit=input.limit??25;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||input.cursor!==undefined&&!/^[a-f0-9]{64}$/.test(input.cursor))throw new StoreError('Invalid semantic product page');
    const products:AssistantUnderstandingProduct[]=[];let nextCursor:string|null=null;
    for(const item of this.candidates(context.material,context.members)){
      if(input.cursor&&item.id<=input.cursor)continue;
      let value:AssistantUnderstandingProduct|undefined;
      try{value=this.product(formatArtifactRef(item.id,item.revision),scope,context);}catch(error){if(error instanceof StoreError&&error.statusCode===404)continue;throw error;}
      if(!value)continue;
      if(products.length===limit){nextCursor=parseArtifactRef(products.at(-1)!.ref)!.id;break;}
      products.push(value);
    }
    const ranges=products.flatMap(product=>product.coverage).sort((a,b)=>a.offset-b.offset||a.length-b.length);
    let end=0;for(const range of ranges){if(range.offset>end)break;end=Math.max(end,range.offset+range.length);}
    const complete=!input.cursor&&!nextCursor&&context.material.textLength>0&&end===context.material.textLength;
    const semantic:FileCoverage=complete?{status:'ready',reason:'available_material_text_only'}:products.length?{status:'partial',reason:'bounded_or_unknown_semantic_coverage'}:{status:'pending'};
    const disclosureDependencies:EvidenceDependencies={version:1,complete:context.complete&&products.every(product=>product.disclosureDependencies.complete),ids:[...new Set([...context.members,...context.anchors,...products.flatMap(product=>product.disclosureDependencies.ids)])]};
    const sourceContextDependencies=combineSourceContextDependencies([this.contextPins([...context.members,...context.anchors],context.material),...products.map(product=>product.sourceContextDependencies)]);
    return {material:context.material,coverage:{extraction:extractionCoverage(context.material),semantic,semanticRanges:ranges},products,nextCursor,disclosureDependencies,sourceContextDependencies};
  }
  /** Explicit references are rejected rather than redirected to another version
   * or silently accepted outside this Material's authorized lineage. */
  readProduct(input:{ref:string;artifactRef:string;scope:QueryScope}){
    const scope=queryScopeSchema.parse(input.scope),context=this.material(input.ref,scope),parsed=parseArtifactRef(input.artifactRef);
    if(!parsed||!this.candidates(context.material,context.members).some(item=>item.id===parsed.id&&item.revision===parsed.revision))throw unavailable();
    return this.product(input.artifactRef,scope,context)??null;
  }
  /** Re-read one exact original window under the current scope; a product or
   * Material locator alone never authorizes a different original. */
  readOriginal(input:{ref:string;scope:QueryScope;id:string;offset:number;length:number}):Original & {disclosureDependencies:EvidenceDependencies;sourceContextDependencies:SourceContextDeclaration[]} {
    const scope=queryScopeSchema.parse(input.scope),context=this.material(input.ref,scope),id=z.string().uuid().parse(input.id);
    if(originalBodyUnavailable(context.material))throw unavailable();
    if(!context.members.includes(id)&&!context.anchors.includes(id)||!this.originalAllowed(context,id))throw unavailable();
    const record=this.records([id],scope,context).get(id)!;
    if(record.provenance?.document?.contentRole==='summary'||record.provenance?.layer==='reference')throw unavailable();
    const {offset,length}=input;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>12000||!Number.isSafeInteger(offset+length)||offset+length>record.ocrText.length||splitPair(record.ocrText,offset)||splitPair(record.ocrText,offset+length))throw new StoreError('Original reference range is invalid',416);
    return {id,deviceId:record.deviceId,capturedAt:record.capturedAt,receivedAt:record.receivedAt,provenance:record.provenance,attributionContext:record.attributionContext,offset,length,quote:record.ocrText.slice(offset,offset+length),
      disclosureDependencies:{version:1,complete:context.complete,ids:[...new Set([...context.members,...context.anchors,id])]},
      sourceContextDependencies:this.contextPins([...context.members,...context.anchors,id],context.material)};
  }
}
