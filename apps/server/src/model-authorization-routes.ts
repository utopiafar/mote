import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {BackgroundModelAuthorization,ModelConnection} from './background-model-authorization.js';
import {StoreError} from './store.js';

/** Owner control plane. HTTP inputs describe a decision; they are never an
 * executable task authority and cannot choose a work or execution identity. */
export function registerModelAuthorizationRoutes(app:FastifyInstance,control:BackgroundModelAuthorization,available:()=>ModelConnection[],credential:(request:FastifyRequest)=>unknown){
  const owner=(request:FastifyRequest)=>{if(credential(request))throw new StoreError('Owner access required',403);};
  app.get('/api/model-authorization',async request=>{owner(request);return {authorization:control.view(),connections:available(),processing:'new-intake-only',historicalContext:'within-approved-scope'};});
  app.post('/api/model-authorization/commands',{bodyLimit:65536},async request=>{owner(request);return control.command(request.body);});
}
