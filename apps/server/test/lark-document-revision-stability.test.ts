import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {documentRevision} from '../src/connectors/lark-documents.js';
import type {SourceItem} from '@mote/shared';

const observedAt='2026-10-10T00:00:00.000Z';
function document(revisionId:number,patch:Partial<Omit<SourceItem,'revision'>>={}):Omit<SourceItem,'revision'> {
  return {externalId:'GeneratedDocument123',observedAt,title:'Generated document',text:'Generated original body',kind:'file',layer:'snapshot',deleted:false,
    mimeType:'text/markdown',uri:'https://fixture.feishu.cn/docx/GeneratedDocument123',
    document:{timeBasis:'unknown',contentRole:'other',originalMetadata:{provider:'lark',documentId:'GeneratedDocument123',revisionId,embeddedAssets:'references-only'}},...patch};
}

test('Lark provider revision noise preserves immutable evidence across resync and store restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-lark-revision-'));let store=new Store(directory);
  try {
    let sources=new SourceStore(store);
    sources.register({id:'generated-lark',name:'Generated Lark',kind:'custom',deviceId:'generated-device',platform:'import'});
    const first=await sources.upsert('generated-lark',documentRevision(document(1))),original=sources.getItem('generated-lark','GeneratedDocument123')!;
    const deletionRevision=store.deletionRevision();
    for(const revisionId of [2,3]){
      const next=documentRevision(document(revisionId,{observedAt:'2026-10-11T00:00:00.000Z'}),sources.getItem('generated-lark','GeneratedDocument123'));
      assert.equal(next.revision,original.revision,'provider counters are not content revisions');
      assert.equal(next.document?.originalMetadata?.revisionId,1,'an unchanged immutable revision retains its original provenance');
      const ack=await sources.upsert('generated-lark',next);assert.equal(ack.id,first.id);assert.equal(ack.duplicate,true);
      store.close();store=new Store(directory);sources=new SourceStore(store);
    }
    assert.equal(sources.history('generated-lark','GeneratedDocument123').length,1);
    assert.equal(store.deletionRevision(),deletionRevision,'no supersede event may reach downstream consumers');
    const changed=await sources.upsert('generated-lark',documentRevision(document(4,{text:'Generated corrected body'}),sources.getItem('generated-lark','GeneratedDocument123')));
    assert.notEqual(changed.id,first.id);assert.equal(changed.duplicate,false);
    assert.equal(sources.history('generated-lark','GeneratedDocument123').length,2);
    assert.equal(store.evidence([first.id])[0].ocrText,'Generated original body');
    assert.ok(store.deletionRevision()>deletionRevision);
    // Returning to an earlier text is a new occurrence, not resurrection of an old version.
    const reverted=await sources.upsert('generated-lark',documentRevision(document(5),sources.getItem('generated-lark','GeneratedDocument123')));
    assert.notEqual(reverted.id,first.id);assert.notEqual(reverted.id,changed.id);
  } finally {store.close();await rm(directory,{recursive:true,force:true});}
});

for(const [name,patch] of Object.entries({
  title:{title:'Generated corrected title'},uri:{uri:'https://fixture.feishu.cn/docx/GeneratedOther123'},
  attribution:{document:{...document(2).document!,contentRole:'authored' as const}},
  originalBody:{text:'',layer:'original' as const,document:{...document(2).document!,originalMetadata:{...document(2).document!.originalMetadata,bodyHash:'generated-body-2'}}},
  deletion:{deleted:true,text:''},
}))test(`Lark ${name} changes still create a content revision`,()=>{
  const first=documentRevision(document(1));
  const prior={...first,sourceId:'generated-lark',captureId:'generated-capture',receivedAt:observedAt,current:true};
  assert.notEqual(documentRevision(document(2,patch),prior).revision,first.revision);
});
