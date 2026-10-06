import test from 'node:test';
import assert from 'node:assert/strict';
import {FileProcessorRuntime} from '../src/file-processors.js';
import {requestLocale} from '../src/i18n.js';
import {processorContract} from '../src/file-configuration.js';

test('builtin processor metadata follows each request locale without changing registry or execution contracts',async t=>{
 const runtime=requestLocale.run('en',()=>new FileProcessorRuntime());
 t.after(()=>runtime.close());await runtime.ready;
 const canonical=runtime.registry.get('audio.local-dialogue');
 const originalParameters=structuredClone(canonical.parameters);
 const views=await Promise.all((['en','zh-CN','en'] as const).map(locale=>requestLocale.run(locale,async()=>{
  await Promise.resolve();return runtime.registry.list();
 })));
 const english=views[0],chinese=views[1];
 assert.deepEqual(english,views[2]);
 const expectedNames:Record<string,string>={'audio.http':'Transcription endpoint','audio.local-dialogue':'Local multi-speaker audio','text.utf8':'UTF-8 text extraction','document.generic':'Document text extraction','image.http':'Image text extraction endpoint','audio.diarize':'Local speaker separation'};
 for(const processor of english){
  assert.equal(processor.name,expectedNames[processor.id]);
  assert.deepEqual(processorContract(processor),processorContract(chinese.find(p=>p.id===processor.id)!));
 }
 const audio=english.find(p=>p.id==='audio.local-dialogue')!;
 assert.equal(audio.parameters?.[0].label,'Expected speakers');
 assert.equal(audio.parameters?.[0].description,'Leave blank for model detection');
 assert.equal(audio.parameters?.[1].label,'Use the selected language model to merge natural speaking turns');
 assert.equal(chinese.find(p=>p.id===audio.id)?.name,'本地多人录音');
 assert.equal(chinese.find(p=>p.id===audio.id)?.parameters?.[0].label,'预期说话人数');
 audio.name='Changed response';audio.parameters![0].label='Changed response';
 assert.equal(canonical.name,'本地多人录音');
 assert.deepEqual(canonical.parameters,originalParameters);
 assert.equal(requestLocale.run('en',()=>runtime.registry.list()).find(p=>p.id===audio.id)?.parameters?.[0].label,'Expected speakers');
});

test('plugin-authored metadata remains literal even when it matches builtin translation keys',async t=>{
 const runtime=new FileProcessorRuntime();t.after(()=>runtime.close());await runtime.ready;
 runtime.registry.register({id:'fixture.literal',version:'1',name:'本地多人录音',stage:'extract',mediaTypes:['text/'],parameters:[{key:'speakers',label:'预期说话人数',description:'留空由模型自动识别',type:'number'}],process:async()=>{throw Error('Fixture must not execute');}});
 const english=requestLocale.run('en',()=>runtime.registry.list()).find(p=>p.id==='fixture.literal');
 const chinese=requestLocale.run('zh-CN',()=>runtime.registry.list()).find(p=>p.id==='fixture.literal');
 assert.deepEqual(english,chinese);
 assert.equal(english?.name,'本地多人录音');
 assert.equal(english?.parameters?.[0].label,'预期说话人数');
 assert.equal(english?.parameters?.[0].description,'留空由模型自动识别');
});
