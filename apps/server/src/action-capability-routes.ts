import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {ActionCapabilities} from './action-capabilities.js';
import type {Connections,ConnectionCredential} from './connections.js';
import {StoreError} from './store.js';

export function registerActionCapabilityRoutes(app:FastifyInstance,{capabilities,connections,connectionIdentity}:{capabilities:ActionCapabilities;connections:Connections;connectionIdentity:(request:FastifyRequest)=>ConnectionCredential|undefined}){
 const owner=(request:FastifyRequest)=>{const value=connectionIdentity(request);if(value&&!connections.isOwner(value))throw new StoreError('Only the owner controls action capability drafts',403);};
 const device=(request:FastifyRequest)=>{const value=connectionIdentity(request);if(!value||!['collector','owner'].includes(value.scope)||!value.deviceId)throw new StoreError('A paired device connection is required',403);connections.assertActive(value);return value;};
 app.get('/api/action-capabilities',async request=>{owner(request);return capabilities.inventory();});
 app.get('/api/device-action-capabilities',async request=>{const current=device(request);return {connectionId:current.id,declaration:capabilities.declaration(current.deviceId!)??null};});
 app.post('/api/device-action-capabilities',{bodyLimit:65536},async request=>capabilities.declare(request.body,device(request)));
 app.put('/api/action-capability-drafts',{bodyLimit:65536},async request=>{owner(request);return capabilities.saveDraft(request.body);});
 app.post('/api/action-capability-drafts/:id/revoke',{bodyLimit:4096},async request=>{owner(request);return capabilities.revokeDraft(z.object({id:z.string().uuid()}).parse(request.params).id,request.body);});
}
