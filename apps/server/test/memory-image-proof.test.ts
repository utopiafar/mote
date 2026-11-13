import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {ImageView,QueryResult} from '@mote/shared';
import {memoryImageReadReceipts,hasMemoryImageProof,imageViewCovers,MEMORY_VISUAL_REVIEW_COVERAGE_CONTRACT} from '../src/memory-image-proof.js';
import {MemoryOutputValidationError} from '../src/memory.js';
import {assertMemoryTargetSupport,retainedMemoryReadReceipt} from '../src/memory-read-context.js';
import {readMemoryWorkCoverage} from '../src/memory-work-contract.js';
import {reviewMemory} from '../src/memory-review.js';

const image=(region:ImageView['region']=null):ImageView=>({original:{sha256:'a'.repeat(64),width:100,height:100,mimeType:'image/png',orientation:1,pages:1},coordinateSpace:'encoded-raster-pixels-v1',region,transform:region?'crop-encoded-raster-png@1':'original-bytes@1',viewId:(region?'b':'c').repeat(64),output:{sha256:'d'.repeat(64),width:region?.width??100,height:region?.height??100,mimeType:'image/png',sizeBytes:200}});
const result=(answer:unknown,receipts?:QueryResult['imageReadReceipts']):QueryResult=>({answer:JSON.stringify(answer),citations:[],trace:[],runId:randomUUID(),...(receipts?{imageReadReceipts:receipts}:{})});

test('visual proof comes from runner pixels, not model JSON, metadata or a different original',()=>{
 const id=randomUUID(),view=image(),span={id,image:{originalSha256:view.original.sha256,viewId:view.viewId}};
 assert.deepEqual(memoryImageReadReceipts(result({memories:[],imageReadReceipts:[{id,imageView:view}]})),[]);
 assert.equal(hasMemoryImageProof(memoryImageReadReceipts(result({},[{id,imageView:view}])),span),true);
 assert.equal(hasMemoryImageProof([{id,imageView:view}],{...span,id:randomUUID()}),false);
 assert.equal(hasMemoryImageProof([{id,imageView:view}],{id,image:{...span.image,originalSha256:'e'.repeat(64)}}),false);
 assert.throws(()=>memoryImageReadReceipts(result({},[{id,imageView:{...view,transform:'metadata@1',output:undefined}}])));
 assert.throws(()=>memoryImageReadReceipts(result({},[{id,imageView:{...view,output:undefined}}])));
});

test('visual target ownership and coverage require its own actual delivered image receipt',()=>{
 const id=randomUUID(),contextId=randomUUID(),view=image(),member={id,key:'1'.repeat(64),offset:0,length:10},span={id,image:{originalSha256:view.original.sha256,viewId:view.viewId}};
 const answer={memories:[{evidenceIds:[id],evidence:[span]}],coverage:[{key:member.key,state:'checked',candidateIndexes:[0]}]};
 const proved=result(answer,[{id,imageView:view}]);
 assert.doesNotThrow(()=>assertMemoryTargetSupport(proved,[member],()=> 'navigation'));
 assert.equal(readMemoryWorkCoverage(proved,[member as never],undefined,()=> 'navigation','range-evaluation@1').incomplete,false);
 assert.throws(()=>assertMemoryTargetSupport(result(answer),[member],()=> 'navigation'));
 assert.throws(()=>assertMemoryTargetSupport(result(answer,[{id:contextId,imageView:view}]),[member],()=> 'navigation'));
 const retained=retainedMemoryReadReceipt(proved);assert.deepEqual(retained.imageReadReceipts,[{id,imageView:view}]);
 retained.imageReadReceipts![0].imageView.original.sha256='f'.repeat(64);assert.equal(proved.imageReadReceipts![0].imageView.original.sha256,'a'.repeat(64));
});

test('independent review cannot reuse extraction pixels or replace retained proof with an unrelated crop',async()=>{
 const id=randomUUID(),view=image({x:0,y:0,width:20,height:20}),selector={originalSha256:view.original.sha256,viewId:view.viewId};
 const candidate={statement:'A generated visible shape.',evidence:[{id,image:selector}]};
 const draft=result({memories:[candidate]},[{id,imageView:view}]);
 const input={question:'Generated visual review',taskContext:{turns:[],memoryWork:{workContract:'range-evaluation@1'}}};
 await assert.rejects(()=>reviewMemory(input,draft,async()=>result({memories:[candidate]})),/did not receive/);
 const other={...image({x:50,y:50,width:10,height:10}),viewId:'e'.repeat(64)};
 await assert.rejects(()=>reviewMemory(input,draft,async()=>result({memories:[{...candidate,evidence:[{id,image:{originalSha256:other.original.sha256,viewId:other.viewId}}]}]},[{id,imageView:other}])),/retained visual proof/);
 const whole=image();
 const reviewed=await reviewMemory(input,draft,async request=>{
  assert.ok((request.taskContext!.untrustedMemoryDraft as {imageViews?:unknown}).imageViews,'view coordinates are navigation, not reused pixel permission');
  return result({memories:[{...candidate,evidence:[{id,image:{originalSha256:whole.original.sha256,viewId:whole.viewId}}]}]},[{id,imageView:whole}]);
 });assert.equal(reviewed.imageReadReceipts![0].imageView.viewId,whole.viewId);
 assert.equal(imageViewCovers(whole,view),true);assert.equal(imageViewCovers(view,whole),false);
 const discarded=await reviewMemory(input,draft,async()=>result({memories:[]}));assert.deepEqual(JSON.parse(discarded.answer).memories,[]);
});

test('rewriting a visual statement cannot bypass the extraction view coverage requirement',async()=>{
 const id=randomUUID(),view=image({x:0,y:0,width:20,height:20});
 const candidate={title:'Generated draft',statement:'A generated visible shape.',evidence:[{id,image:{originalSha256:view.original.sha256,viewId:view.viewId}}]};
 const draft=result({memories:[candidate]},[{id,imageView:view}]),input={question:'Generated visual review'};
 const reviewed=(next:ImageView)=>result({memories:[{...candidate,title:'Edited title',statement:'The image shows a generated shape.',evidence:[{id,image:{originalSha256:next.original.sha256,viewId:next.viewId}}]}]},[{id,imageView:next}]);
 for(const region of [{x:50,y:50,width:10,height:10},{x:0,y:0,width:10,height:10}]){
  const partial={...image(region),viewId:'e'.repeat(64)};
  await assert.rejects(()=>reviewMemory(input,draft,async()=>reviewed(partial)),/retained visual proof/);
 }
 for(const covering of [view,{...image({x:0,y:0,width:30,height:30}),viewId:'f'.repeat(64)},image()]){
  const approved=await reviewMemory(input,draft,async()=>reviewed(covering));
  assert.equal(JSON.parse(approved.answer).memories[0].statement,'The image shows a generated shape.');
 }
});

test('an uncited full-image read still needs a covering citation and precise repair feedback',async()=>{
 const id=randomUUID(),draftView=image({x:0,y:0,width:40,height:40}),other={...image({x:50,y:50,width:20,height:20}),viewId:'e'.repeat(64)},whole=image();
 const candidate=(view:ImageView)=>({statement:'A generated visible shape.',evidence:[{id,image:{originalSha256:view.original.sha256,viewId:view.viewId}}]});
 const draft=result({memories:[candidate(draftView)]},[{id,imageView:draftView}]);let feedback='';
 await assert.rejects(()=>reviewMemory({question:'Generated visual review'},draft,async request=>{
  assert.ok(request.question.includes(MEMORY_VISUAL_REVIEW_COVERAGE_CONTRACT));
  return result({memories:[candidate(other)]},[{id,imageView:whole},{id,imageView:other}]);
 }),error=>{assert.ok(error instanceof MemoryOutputValidationError);assert.equal(error.details.problem,'review_image_coverage');feedback=error.repairInstruction;assert.ok(feedback.includes(MEMORY_VISUAL_REVIEW_COVERAGE_CONTRACT));return true;});
 const reviewed=await reviewMemory({question:'Generated visual review',memoryReviewRepair:feedback},draft,async request=>{
  assert.ok(request.question.includes('Host review repair: '+feedback));
  return result({memories:[candidate(whole)]},[{id,imageView:whole}]);
 });
 assert.equal(JSON.parse(reviewed.answer).memories[0].evidence[0].image.viewId,whole.viewId);
 assert.notEqual(reviewed.runId,draft.runId);
});

test('visual coverage follows cited original groups across rewritten and reordered candidates',async()=>{
 const id=randomUUID(),otherId=randomUUID(),left=image({x:0,y:0,width:20,height:20}),right={...image({x:50,y:50,width:20,height:20}),viewId:'e'.repeat(64)};
 const extra={...image({x:80,y:80,width:20,height:20}),viewId:'f'.repeat(64)};
 const candidate=(statement:string,anchor:string,view:ImageView)=>({statement,evidence:[{id:anchor,image:{originalSha256:view.original.sha256,viewId:view.viewId}}]});
 const draft=result({memories:[candidate('Left draft.',id,left),candidate('Right draft.',id,right),candidate('Other anchor.',otherId,image())]},[{id,imageView:left},{id,imageView:right},{id,imageView:extra},{id:otherId,imageView:image()}]);
 const answer={memories:[candidate('Right rewritten.',id,right),candidate('Left rewritten.',id,left)]};
 let calls=0;
 const approved=await reviewMemory({question:'Generated visual review'},draft,async()=>{calls++;return result(answer,[{id,imageView:right},{id,imageView:left}]);});
 assert.equal(calls,1,'multiple draft crops must not reject each other before independent review');
 assert.equal(JSON.parse(approved.answer).memories.length,2,'uncited reads and discarded other anchors add no coverage requirement');
 await assert.rejects(()=>reviewMemory({question:'Generated visual review'},draft,async()=>result(answer,[{id,imageView:left},{id:otherId,imageView:right}])),/did not receive/);
 const differentHash={...right,original:{...right.original,sha256:'9'.repeat(64)}};
 await assert.rejects(()=>reviewMemory({question:'Generated visual review'},draft,async()=>result(answer,[{id,imageView:left},{id,imageView:differentHash}])),/did not receive/);
 const whole=image(),wholeDraft=result({memories:[candidate('Whole image draft.',id,whole)]},[{id,imageView:whole}]);
 const halves=[{...image({x:0,y:0,width:50,height:100}),viewId:'1'.repeat(64)},{...image({x:50,y:0,width:50,height:100}),viewId:'2'.repeat(64)}];
 await assert.rejects(()=>reviewMemory({question:'Generated visual review'},wholeDraft,async()=>result({memories:halves.map((view,index)=>candidate('Rewritten half '+index,id,view))},halves.map(imageView=>({id,imageView})))),/retained visual proof/);
});

test('an assessed zero-Memory image draft still receives an independent range review',async()=>{
 const id=randomUUID(),view=image(),draft=result({memories:[],coverage:[{key:'generated-target',state:'no_candidates',candidateIndexes:[]}]},[{id,imageView:view}]);
 let reviews=0;
 const reviewed=await reviewMemory({question:'Assess the generated wordless image',taskContext:{memoryWork:{workContract:'range-evaluation@1'}}},draft,async input=>{
  reviews++;assert.equal(input.traceContext?.phase,'review');
  const proposal=input.taskContext!.untrustedMemoryDraft as {imageViews:{imageView:ImageView}[]};
  assert.equal(proposal.imageViews[0].imageView.original.sha256,view.original.sha256,'the draft carries navigation only');
  return result({memories:[],coverage:[{key:'generated-target',state:'no_candidates',candidateIndexes:[]}]},[{id,imageView:view}]);
 });
 assert.equal(reviews,1);assert.notEqual(reviewed.runId,draft.runId);assert.deepEqual(JSON.parse(reviewed.answer).memories,[]);
});

test('discarded visual proof imposes no pixel requirement on a separately quoted OCR conclusion',async()=>{
 const id=randomUUID(),ocrId=randomUUID(),view=image(),draft=result({memories:[{statement:'An unsupported visual proposal.',evidence:[{id,image:{originalSha256:view.original.sha256,viewId:view.viewId}}]}]},[{id,imageView:view}]);
 const reviewed=await reviewMemory({question:'Review this generated article',taskContext:{memoryWork:{workContract:'range-evaluation@1'}}},draft,async()=>result({memories:[{statement:'The article author resigned.',evidence:[{id:ocrId,quote:'The article author resigned.'}]}]}));
 assert.deepEqual(memoryImageReadReceipts(reviewed),[]);
 assert.deepEqual(JSON.parse(reviewed.answer).memories[0].evidence,[{id:ocrId,quote:'The article author resigned.'}]);
 // Exact OCR provenance and target coverage remain the full pipeline's job;
 // this rule only removes the discarded visual group's coverage requirement.
});
