import '@mote/shared/i18n-all';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serializeMoteLink,deepLinkHash,type MoteLink} from '@mote/shared';
import {featuresReady} from '../src/features/bootstrap.js';
import {webFeatures} from '../src/features/registry.js';
import {readPage} from '../src/navigation.js';
import {readWorkspaceRoute} from '../src/workspace-route.js';
import {readEvidenceRoute} from '../src/plugins/reader/evidence-route.js';
import {webDeepLink,resolveWebDeepLink,webViewPage} from '../src/deep-link.js';

const origin='https://central.example';
const collections=()=>webFeatures.collections().map(entry=>entry.id);
const dest=(hash:string)=>readWorkspaceRoute(hash,readPage,collections(),webViewPage);

test('links serialized by another end parse to the exact conversation, run or reference',async()=>{
  await featuresReady;
  const {openCentralBrowser}=await import('../../desktop/src/central-browser.js');
  const opened:string[]=[];const launch=async(url:string)=>{opened.push(url)};
  const conversationId=randomUUID(),ref='capture:'+randomUUID(),workId='generated-work-42';

  await openCentralBrowser(origin,'ask','linux',launch,launch,undefined,undefined,undefined,undefined,conversationId);
  let link=webDeepLink(opened[0]);
  assert.deepEqual(link,{scope:{origin},route:{kind:'conversation',id:conversationId}});
  assert.deepEqual(resolveWebDeepLink(link,{origin}),{status:'route',route:{kind:'conversation',id:conversationId}});
  assert.equal(dest(deepLinkHash(link.route)).page,'ask');

  await openCentralBrowser(origin,'activity','linux',launch,launch,undefined,undefined,undefined,workId);
  link=webDeepLink(opened[1]);
  assert.deepEqual(link,{scope:{origin},route:{kind:'run',id:workId}});
  assert.equal(dest(deepLinkHash(link.route)).page,'activity');

  await openCentralBrowser(origin,'ask','linux',launch,launch,ref);
  link=webDeepLink(opened[2]);
  assert.deepEqual(link,{scope:{origin},route:{kind:'reference',ref}});
  assert.equal(dest(deepLinkHash(link.route)).page,'ask');
  assert.equal(readEvidenceRoute(deepLinkHash(link.route)),ref);

  await openCentralBrowser(origin,'ask','linux',launch,launch,ref,undefined,undefined,undefined,conversationId);
  link=webDeepLink(opened[3]);
  assert.deepEqual(link,{scope:{origin},route:{kind:'reference',ref,conversation:conversationId}});
});

test('a link for an unknown plugin view falls to the generic reader for the same pinned reference',async()=>{
  await featuresReady;
  const ref='capture:'+randomUUID();
  const view={packageId:'mote.generated',routeId:'generated.missing',ref};
  const url=serializeMoteLink({origin},{kind:'view',view});
  const link=webDeepLink(url) as MoteLink;
  assert.equal(link.route.kind,'view');
  assert.deepEqual(resolveWebDeepLink(link,{origin}),{status:'reader',ref});
  const hash='#'+url.split('#')[1];
  assert.equal(dest(hash).page,'ask');
  assert.equal(readEvidenceRoute(hash),ref,'the reader opens the pinned reference, not another object');
});

test('a deactivated plugin view falls to the reader while a live one keeps its route',async()=>{
  await featuresReady;
  const ref='capture:'+randomUUID();
  const fiber=await webFeatures.install({id:'generated.deeplink',version:'1',components:[]},[
    {surface:'page' as const,entry:{id:'generated.editor',route:'generated-editor',featureId:'generated.deeplink',render:()=>null}},
  ]);
  try{
    const view={packageId:'generated.deeplink',routeId:'generated.editor',ref};
    const link=webDeepLink(serializeMoteLink({origin},{kind:'view',view})) as MoteLink;
    assert.deepEqual(resolveWebDeepLink(link,{origin}),{status:'route',route:{kind:'view',view}});
    assert.equal(dest(deepLinkHash(link.route)).page,'generated.editor');
    const foreignView={...view,packageId:'generated.deeplink.other'};
    const foreignLink=webDeepLink(serializeMoteLink({origin},{kind:'view',view:foreignView})) as MoteLink;
    assert.deepEqual(resolveWebDeepLink(foreignLink,{origin}),{status:'reader',ref},'a route id alone never transfers another package page');
    assert.equal(dest(deepLinkHash(foreignLink.route)).page,'ask');
    await fiber.dispose();
    assert.deepEqual(resolveWebDeepLink(link,{origin}),{status:'reader',ref});
    assert.equal(dest(deepLinkHash(link.route)).page,'ask');
    assert.equal(readEvidenceRoute(deepLinkHash(link.route)),ref);
  }finally{await fiber.dispose();}
});

test('deleted, revoked and foreign links never retarget; revoked carries no reference',async()=>{
  await featuresReady;
  const link=webDeepLink(serializeMoteLink({origin},{kind:'conversation',id:randomUUID()})) as MoteLink;
  assert.deepEqual(resolveWebDeepLink(link,{origin,exists:false}),{status:'missing'});
  const denied=resolveWebDeepLink(link,{origin,granted:false});
  assert.deepEqual(denied,{status:'denied'});
  assert.deepEqual(Object.keys(denied),['status']);
  assert.deepEqual(resolveWebDeepLink(link,{origin:'https://other.example'}),{status:'foreign-scope'});
  assert.equal(webDeepLink('javascript:alert(1)'),undefined);
  assert.equal(webDeepLink('https://central.example/settings'),undefined);
});
