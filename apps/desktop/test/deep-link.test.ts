import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {parseMoteLink,serializeMoteLink,deepLinkHash,type MoteLink} from '@mote/shared';
import {openCentralBrowser} from '../src/central-browser';
import {desktopDeepLinkTarget} from '../src/deep-link';

const origin='https://central.example';
const open=async(...args:Parameters<typeof openCentralBrowser>)=>{const chrome=vi.fn(),def=vi.fn();await openCentralBrowser(...args.slice(0,3) as [string,string|undefined,string],chrome,def,...args.slice(3) as never);return (chrome.mock.calls[0]?.[0]??def.mock.calls[0]?.[0]) as string};

it('emits canonical links that the shared schema parses back to the exact target',async()=>{
  const conversationId=randomUUID(),workId='generated-work-9',ref='capture:'+randomUUID();

  const workUrl=await open(origin,'activity','linux',undefined,undefined,undefined,workId);
  expect(parseMoteLink(workUrl)).toEqual({scope:{origin},route:{kind:'run',id:workId}});

  const convUrl=await open(origin,'ask','linux',undefined,undefined,undefined,undefined,conversationId);
  expect(parseMoteLink(convUrl)).toEqual({scope:{origin},route:{kind:'conversation',id:conversationId}});

  const refUrl=await open(origin,'ask','linux',ref);
  expect(parseMoteLink(refUrl)).toEqual({scope:{origin},route:{kind:'reference',ref}});

  const bothUrl=await open(origin,'ask','linux',ref,undefined,undefined,undefined,conversationId);
  expect(parseMoteLink(bothUrl)).toEqual({scope:{origin},route:{kind:'reference',ref,conversation:conversationId}});

  const loginUrl=await open(origin,'activity','linux',undefined,'generated-ticket',undefined,workId);
  expect(parseMoteLink(loginUrl)).toEqual({scope:{origin},route:{kind:'run',id:workId}});
  expect(new URL(loginUrl).search).toBe('');
});

it('parses links serialized under the shared schema and opens them canonically',async()=>{
  const conversationId=randomUUID(),ref='capture:'+randomUUID();
  const link=parseMoteLink(serializeMoteLink({origin},{kind:'conversation',id:conversationId})) as MoteLink;
  expect(desktopDeepLinkTarget(link,origin)).toEqual({status:'open',url:origin+'/#/ask?conversation='+conversationId});
  const view={packageId:'mote.generated',routeId:'generated.editor',ref};
  const viewLink=parseMoteLink(serializeMoteLink({origin},{kind:'view',view})) as MoteLink;
  // No desktop plugin view routes exist yet, so the view lands on the reader.
  expect(desktopDeepLinkTarget(viewLink,origin)).toEqual({status:'open',url:origin+'/'+deepLinkHash({kind:'reference',ref})});
  const reopened=desktopDeepLinkTarget(viewLink,origin);
  expect(parseMoteLink(reopened.status==='open'?reopened.url:'')).toEqual({scope:{origin},route:{kind:'reference',ref}});
});

it('foreign, revoked and deleted links never produce an openable URL',async()=>{
  const link=parseMoteLink(serializeMoteLink({origin},{kind:'conversation',id:randomUUID()})) as MoteLink;
  expect(desktopDeepLinkTarget(link,'https://other.example')).toEqual({status:'foreign-scope'});
  expect(desktopDeepLinkTarget(link,origin,{granted:false})).toEqual({status:'denied'});
  expect(desktopDeepLinkTarget(link,origin,{exists:false})).toEqual({status:'missing'});
});
