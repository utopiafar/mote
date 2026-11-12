import '@mote/shared/i18n-all';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
import type {FeatureCapability,FeatureInventory} from '@mote/shared';
import {assistantEntrypoints,resolveAssistantEntrypoint} from '../src/assistant-entrypoints.js';
import {AssistantGuide} from '../src/AssistantGuide.js';
import {DiscoveryProvider} from '../src/DiscoveryLink.js';
import {WebFeatureHost} from '../src/features/host.js';
import type {PageEntry} from '../src/features/types.js';
import {featuresReady} from '../src/features/bootstrap.js';
import {webFeatures} from '../src/features/registry.js';
import {readPage} from '../src/navigation.js';
import {readWorkspaceRoute} from '../src/workspace-route.js';
import {webDeepLink,resolveWebDeepLink,webViewPage} from '../src/deep-link.js';
import {deepLinkHash,serializeMoteLink,type MoteLink} from '@mote/shared';
import {english} from '../../../packages/shared/src/i18n-en.js';

const origin='https://central.example';
const page=(id:string,overrides:Partial<PageEntry>={}):PageEntry=>({id,featureId:id,render:()=>null,...overrides});
const capability=(id:string,version='1',state:FeatureCapability['state']='active'):FeatureCapability=>({id,version,state,featureId:'mote.assistant',surface:'page'});
const inventory=(capabilities:FeatureCapability[]=[]):FeatureInventory=>({schemaVersion:1,revision:1,features:[],capabilities});

test('an existing real page keeps its normal route while planned assistant pages are not claimed',async()=>{
  await featuresReady;
  assert.equal(readPage('#/activity'),'activity');
  assert.equal(readPage('#/activity?work=generated-run'),'activity');
  assert.ok(webFeatures.page('activity'));
  assert.equal(readWorkspaceRoute('#/activity',readPage,webFeatures.collections().map(entry=>entry.id),webViewPage).page,'activity');
  assert.ok(webFeatures.registry.inventory().features.some(feature=>feature.id==='mote.assistant'),'the assistant package slot is installed');
  for(const entry of assistantEntrypoints)assert.equal(webFeatures.page(entry.pageId),undefined,'the scaffold does not claim an unimplemented page');
});

test('a planned assistant destination stays non-executable until its page and capability are live',async()=>{
  const entry=assistantEntrypoints[0]!;
  const requirement=entry.requires![0]!;
  const requirementId=typeof requirement==='string'?requirement:requirement.id;
  const requirementVersion=typeof requirement==='string'?'1':requirement.version;
  const host=new WebFeatureHost();
  const state=()=>({pages:host.pages(),collections:[]});
  try{
    const missing=resolveAssistantEntrypoint(entry,state());
    assert.equal(missing.state,'unavailable');
    assert.equal(missing.reason,'page_not_registered');
    assert.equal(missing.href,undefined,'an unregistered page never falls back to another destination');

    const fiber=await host.install({id:'mote.assistant',version:'1',components:[]},[
      {surface:'page',entry:page(entry.pageId,{route:entry.href.slice(2),requires:entry.requires})},
    ]);
    const ready=resolveAssistantEntrypoint(entry,{...state(),inventory:inventory([capability(requirementId,requirementVersion)])});
    assert.equal(ready.state,'available');
    assert.equal(ready.href,entry.href);

    const disabled=resolveAssistantEntrypoint(entry,{...state(),inventory:inventory([capability(requirementId,requirementVersion,'unavailable')])});
    assert.equal(disabled.state,'unavailable');
    assert.equal(disabled.reason,'remote_requirement_unavailable');
    assert.equal(disabled.href,undefined);

    const unknown=resolveAssistantEntrypoint(entry,{...state(),inventory:inventory([])});
    assert.equal(unknown.state,'unavailable');
    assert.equal(unknown.href,undefined);

    await fiber.dispose();
    assert.equal(resolveAssistantEntrypoint(entry,{...state(),inventory:inventory([capability(requirementId,requirementVersion)])}).reason,'page_not_registered');
  }finally{await host.close();}
});

test('deep links resolve a view only from the package that actually owns the page',async()=>{
  await featuresReady;
  const ref='capture:'+randomUUID(),packageId='generated.assistant.ownership';
  const renders:{count:number}={count:0};
  const fiber=await webFeatures.install({id:packageId,version:'1',components:[]},[
    {surface:'page',entry:page('generatedAssistantPage',{route:'assistant/generated',featureId:packageId,render:()=>{renders.count++;return null;}})},
  ]);
  try{
    const owned={packageId,routeId:'generatedAssistantPage',ref};
    const foreign={packageId:'generated.assistant.other',routeId:'generatedAssistantPage',ref};
    assert.equal(webViewPage(owned),'generatedAssistantPage');
    assert.equal(webViewPage(foreign),undefined,'a route id alone never transfers another package page');
    const ownedLink=webDeepLink(serializeMoteLink({origin},{kind:'view',view:owned})) as MoteLink;
    const foreignLink=webDeepLink(serializeMoteLink({origin},{kind:'view',view:foreign})) as MoteLink;
    assert.deepEqual(resolveWebDeepLink(ownedLink,{origin}),{status:'route',route:{kind:'view',view:owned}});
    assert.deepEqual(resolveWebDeepLink(foreignLink,{origin}),{status:'reader',ref});
    assert.equal(readWorkspaceRoute(deepLinkHash(ownedLink.route),readPage,webFeatures.collections().map(entry=>entry.id),webViewPage).page,'generatedAssistantPage');
    assert.equal(renders.count,0,'resolving a route does not mount or execute the page');
  }finally{await fiber.dispose();}
});

test('turning a package off preserves the pinned reference, and re-enabling never replays the page',async()=>{
  await featuresReady;
  const ref='capture:'+randomUUID(),packageId='generated.assistant.lifecycle',pageId='generatedAssistantLifecycle';
  const view={packageId,routeId:pageId,ref};
  let renders=0;
  const contributions=[{surface:'page' as const,entry:page(pageId,{route:'assistant/generated-lifecycle',featureId:packageId,render:()=>{renders++;return null;}})}];
  const first=await webFeatures.install({id:packageId,version:'1',components:[]},contributions);
  const link=webDeepLink(serializeMoteLink({origin},{kind:'view',view})) as MoteLink;
  try{
    assert.deepEqual(resolveWebDeepLink(link,{origin}),{status:'route',route:{kind:'view',view}});
    await first.dispose();
    assert.equal(webViewPage(view),undefined);
    assert.deepEqual(resolveWebDeepLink(link,{origin}),{status:'reader',ref},'the reader keeps the same pinned reference instead of dropping history');
    assert.equal(renders,0);
  }finally{await first.dispose();}
  const second=await webFeatures.install({id:packageId,version:'1',components:[]},contributions);
  try{
    assert.deepEqual(resolveWebDeepLink(link,{origin}),{status:'route',route:{kind:'view',view}});
    assert.equal(renders,0,'re-enabling restores the route only when the owner opens it');
  }finally{await second.dispose();}
  assert.deepEqual(resolveWebDeepLink(link,{origin}),{status:'reader',ref});
  assert.equal(renders,0);
});

test('the assistant directory lists every reserved entry as disabled and has six-language copy',()=>{
  const state={pages:[],collections:[],inventory:inventory([])};
  const dom=new JSDOM(renderToStaticMarkup(React.createElement(DiscoveryProvider,{state},React.createElement(AssistantGuide))));
  const rows=[...dom.window.document.querySelectorAll('[data-assistant-entry]')];
  assert.equal(rows.length,assistantEntrypoints.length);
  for(const row of rows){
    assert.equal(row.querySelector('[aria-disabled="true"]')!==null,true);
    assert.match(row.textContent??'',/当前服务未提供此入口/);
  }
  dom.window.close();
  const keys=['助理功能','助理接入的页面；未接入前不会执行任何工作。',...assistantEntrypoints.flatMap(entry=>[entry.title,entry.purpose])];
  for(const key of new Set(keys)){
    assert.ok(Object.hasOwn(english,key),'missing English translation: '+key);
    assert.doesNotMatch(english[key]!,/\p{Script=Han}/u,key);
  }
});
