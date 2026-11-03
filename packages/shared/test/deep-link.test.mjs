import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deepLinkHash,parseDeepLinkHash,serializeMoteLink,parseMoteLink,resolveMoteLink,parseMoteReference,isMoteRunId,moteRoute} from '../dist/deep-link.js';

const origin='https://central.example';
const scope={origin};

test('typed references round-trip canonically and reject ambiguous forms',()=>{
  const id=randomUUID();
  for(const ref of [`capture:${id}`,`memory:${id}`,`CAPTURE:${id.toUpperCase()}`,'material:mat_'+'a'.repeat(64)+'@'+'b'.repeat(64),`artifact:${encodeURIComponent('doc/1')}:${encodeURIComponent('r2')}`]){
    const canonical=parseMoteReference(ref);
    assert.equal(parseMoteReference(canonical),canonical);
  }
  for(const ref of [id,'capture:'+id+':x','material:short','artifact:a','artifact:%zz:1','note:'+id,'',null,42])assert.equal(parseMoteReference(ref),undefined,JSON.stringify(ref));
  assert.equal(parseMoteReference('capture:'+id),'capture:'+id);
});

test('every route kind serializes to the shared hash vocabulary and parses back exactly',()=>{
  const conversationId=randomUUID(),evidenceId=randomUUID(),runId='generated-run-🌱 42';
  const ref='capture:'+randomUUID();
  const routes=[
    {kind:'conversation',id:conversationId},
    {kind:'run',id:runId},
    {kind:'reference',ref},
    {kind:'reference',ref,conversation:conversationId},
    {kind:'view',view:{packageId:'mote.notes',routeId:'notes.editor',ref}},
  ];
  for(const route of routes){
    const hash=deepLinkHash(route);
    assert.equal(hash.startsWith('#/'),true,hash);
    assert.deepEqual(parseDeepLinkHash(hash),route,hash);
    const link=parseMoteLink(serializeMoteLink(scope,route));
    assert.deepEqual(link,{scope,route});
  }
  assert.equal(deepLinkHash({kind:'conversation',id:evidenceId}),'#/ask?conversation='+evidenceId);
  assert.equal(deepLinkHash({kind:'run',id:'r1'}),'#/activity?work=r1');
  assert.equal(deepLinkHash({kind:'reference',ref}),'#/ask?evidence='+encodeURIComponent(ref));
});

test('serialization rejects routes that could parse to another object',()=>{
  const id=randomUUID();
  for(const route of [
    {kind:'conversation',id:'not-a-uuid'},
    {kind:'conversation',id:id+'\n'},
    {kind:'run',id:'  '},
    {kind:'run',id:'x'.repeat(513)},
    {kind:'reference',ref:id},
    {kind:'reference',ref:'CAPTURE:'+id.toUpperCase()},
    {kind:'reference',ref:'capture:'+id,conversation:'nope'},
    {kind:'view',view:{packageId:'',routeId:'x',ref:'capture:'+id}},
    {kind:'view',view:{packageId:'p',routeId:'x',ref:'memory:'}},
    {kind:'other',id},
  ])assert.throws(()=>serializeMoteLink(scope,route),TypeError,JSON.stringify(route));
  assert.throws(()=>serializeMoteLink({origin:'javascript:alert(1)'},{kind:'run',id:'r'}),TypeError);
  assert.throws(()=>serializeMoteLink({origin:'http://remote.example'},{kind:'run',id:'r'}),TypeError);
});

test('strict parsing rejects malformed hashes and foreign URL shapes',()=>{
  const id=randomUUID(),ref='capture:'+id;
  for(const hash of [
    '#/ask','#/ask?conversation=','#/ask?conversation='+id+'x','#/ask?conversation='+id+'&conversation='+id,
    '#/ask?evidence=','#/ask?evidence='+id,'#/ask?evidence='+ref+'&evidence='+ref,
    '#/ask?evidence='+ref+'&conversation=oops','#/ask?work=x','#/activity','#/activity?work=','#/activity?work=a&work=b',
    '#/view?package=p&route=r','#/view?package=&route=r&evidence='+ref,'#/view?package=p&route=r&evidence='+id,
    '#/unknown?conversation='+id,'','#','#/','notes','#/ask%3Fconversation='+id,
  ])assert.equal(parseDeepLinkHash(hash),undefined,hash);
  for(const link of [
    'https://central.example',
    'https://central.example/notes',
    'https://central.example/?x=1#/ask?conversation='+id,
    'https://user@central.example/#/ask?conversation='+id,
    'ftp://central.example/#/ask?conversation='+id,
    'http://remote.example/#/ask?conversation='+id,
    'central.example/#/ask?conversation='+id,
    ' https://central.example/#/ask?conversation='+id,
  ])assert.equal(parseMoteLink(link),undefined,link);
  assert.equal(parseMoteLink(null),undefined);
});

test('transport extras ride along without changing route identity',()=>{
  const id=randomUUID(),ref='capture:'+id;
  assert.deepEqual(parseDeepLinkHash(`#/ask?conversation=${id}&loginTicket=t&loginRequest=r`),{kind:'conversation',id});
  assert.deepEqual(parseDeepLinkHash(`#/ask?evidence=${ref}&loginTicket=t`),{kind:'reference',ref});
  assert.deepEqual(parseDeepLinkHash(`#/activity?work=run-1&loginTicket=t&search=x`),{kind:'run',id:'run-1'});
});

test('resolution keeps the exact target or refuses without retargeting',()=>{
  const conversationId=randomUUID(),ref='capture:'+randomUUID();
  const view={packageId:'mote.notes',routeId:'notes.editor',ref};
  const cases=[
    {route:{kind:'conversation',id:conversationId},facts:{origin},want:{status:'route',route:{kind:'conversation',id:conversationId}}},
    {route:{kind:'view',view},facts:{origin,knownRoute:v=>v.routeId===view.routeId},want:{status:'route',route:{kind:'view',view}}},
    {route:{kind:'view',view},facts:{origin,knownRoute:()=>false},want:{status:'reader',ref}},
    {route:{kind:'view',view},facts:{origin},want:{status:'route',route:{kind:'view',view}}},
    {route:{kind:'conversation',id:conversationId},facts:{origin:'https://other.example'},want:{status:'foreign-scope'}},
    {route:{kind:'conversation',id:conversationId},facts:{origin,granted:false},want:{status:'denied'}},
    {route:{kind:'reference',ref},facts:{origin,exists:false},want:{status:'missing'}},
    {route:{kind:'run',id:'r'},facts:{origin:'http://127.0.0.1:47832'},want:{status:'foreign-scope'}},
  ];
  for(const {route,facts,want} of cases){
    const link=parseMoteLink(serializeMoteLink(scope,route));
    assert.deepEqual(resolveMoteLink(link,facts),want,JSON.stringify(route));
  }
  const denied=resolveMoteLink(parseMoteLink(serializeMoteLink(scope,{kind:'view',view})),{origin,granted:false});
  assert.equal(denied.status,'denied');
  assert.deepEqual(Object.keys(denied),['status'],'revoked resolution must not carry ref or body');
});

test('draft vocabulary never appears in link identity',()=>{
  const id=randomUUID();
  for(const key of ['draft','questionDraft','moteDraft','localOnly']){
    assert.deepEqual(parseDeepLinkHash(`#/ask?conversation=${id}&${key}=v`),{kind:'conversation',id});
  }
  assert.equal(isMoteRunId('ok-run'),true);
  assert.equal(isMoteRunId('a\nb'),false);
  assert.equal(isMoteRunId(7),false);
  assert.equal(moteRoute({kind:'run',id:'ok'}).kind,'run');
});
