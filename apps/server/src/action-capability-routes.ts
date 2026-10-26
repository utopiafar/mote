import type {ManagedCalendar} from './managed-calendar.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {ActionCapabilities} from './action-capabilities.js';
import type {Connections,ConnectionCredential} from './connections.js';
import {StoreError} from './store.js';

export function registerActionCapabilityRoutes(app:FastifyInstance,{capabilities,connections,connectionIdentity,managed}:{capabilities:ActionCapabilities;managed:ManagedCalendar;connections:Connections;connectionIdentity:(request:FastifyRequest)=>ConnectionCredential|undefined}){
 const owner=(request:FastifyRequest)=>{const value=connectionIdentity(request);if(value&&!connections.isOwner(value))throw new StoreError('Only the owner controls action capability drafts',403);};
 const device=(request:FastifyRequest)=>{const value=connectionIdentity(request);if(!value||!['collector','owner'].includes(value.scope)||!value.deviceId)throw new StoreError('A paired device connection is required',403);connections.assertActive(value);return value;};
 app.get('/api/managed-calendar-deliveries',async request=>{const current=device(request);return {items:managed.deliveries(current),manualReviewAllowed:managed.manualReviewAllowed(current)};});
 app.post('/api/managed-calendar/:id/claim',{bodyLimit:4096},async request=>{
  const current=device(request),body=z.object({deviceId:z.string().optional()}).strict().parse(request.body??{});if(body.deviceId&&body.deviceId!==current.deviceId)throw new StoreError('Device identity mismatch',403);
  return managed.claim(z.object({id:z.string().uuid()}).parse(request.params).id,current);
 });
 app.post('/api/managed-calendar/:id/receipt',{bodyLimit:4096},async request=>{
  const current=device(request),body=z.object({deviceId:z.string().optional(),operationId:z.string().uuid(),status:z.enum(['succeeded','uncertain']),externalId:z.string().min(1).max(2000).optional()}).strict().parse(request.body);
  if(body.deviceId&&body.deviceId!==current.deviceId)throw new StoreError('Device identity mismatch',403);const {deviceId:_,...receipt}=body;
  return managed.receipt(z.object({id:z.string().uuid()}).parse(request.params).id,current,receipt);
 });
 app.post('/api/managed-calendar/:id/cancel',{bodyLimit:4096},async request=>{owner(request);const {version}=z.object({version:z.number().int().positive()}).strict().parse(request.body);return managed.cancel(z.object({id:z.string().uuid()}).parse(request.params).id,version);});
 app.get('/api/action-capabilities',async request=>{owner(request);return capabilities.inventory();});
 app.get('/api/device-action-capabilities',async request=>{const current=device(request);return {connectionId:current.id,declaration:capabilities.declaration(current.deviceId!)??null};});
 app.post('/api/device-action-capabilities',{bodyLimit:65536},async request=>capabilities.declare(request.body,device(request)));
 app.put('/api/action-capability-grants',{bodyLimit:65536},async request=>{owner(request);return capabilities.authorize(request.body);});
 app.post('/api/action-capability-grants/:id/revoke',{bodyLimit:4096},async request=>{owner(request);return capabilities.revokeGrant(z.object({id:z.string().uuid()}).parse(request.params).id,request.body);});
 app.put('/api/action-capability-drafts',{bodyLimit:65536},async request=>{owner(request);return capabilities.saveDraft(request.body);});
 app.post('/api/action-capability-drafts/:id/revoke',{bodyLimit:4096},async request=>{owner(request);return capabilities.revokeDraft(z.object({id:z.string().uuid()}).parse(request.params).id,request.body);});
}
