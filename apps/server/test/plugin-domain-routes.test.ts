import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {PluginHost} from '@mote/plugin-host';
import {createDomainActivations,type CentralDomainPlugin} from '../src/domain-activation.js';
import {FeatureRoutes,installFeatureRoutes} from '../src/features/index.js';
import * as domainRoutes from '../src/plugins/domain-routes.js';

test('selected route collection preserves feature order, sibling contributions, owner guards and one cleanup per feature',async t=>{
  const host=new PluginHost({kind:'central',id:randomUUID()}),app=Fastify(),mounts:string[]=[],disposed:string[]=[];
  const routes=new FeatureRoutes(host.context,app);let firstActive=false;
  t.after(async()=>{await routes.close();await app.close();await host.close();});
  const plugin=(id:string,featureId:string):CentralDomainPlugin=>({
    contribution:{id,version:'1.0.0',surface:'data',runtime:'host'},declaration:{id,apiVersion:'1'},replacement:'restart',
    activation:{featureId,requires:{},create(){return {
      prepare(){},start(){if(id==='first-owner')firstActive=true;},quiesce(){if(id==='first-owner')firstActive=false;},stop(){},dispose(){},
      route:{id:featureId,version:'2',mount(child){mounts.push(id);child.get('/api/'+id,async()=>({owner:id}));}},
    };}},
  });
  const features=['mote.second','mote.first','mote.absent'];
  const selected=await createDomainActivations(host,[plugin('first-owner','mote.first'),plugin('first-sibling','mote.first'),plugin('second-owner','mote.second')],features).activate();
  const table:domainRoutes.DomainRouteTable={
    'mote.first':{mount(child){mounts.push('first-companion');child.get('/api/first-companion',async(_request,reply)=>firstActive?{companion:true}:reply.code(503).send({error:'feature_unavailable'}));}},
    'mote.omitted':{mount(){assert.fail('An omitted contribution must not mount');}},
  };
  const entries=domainRoutes.collectSelectedFeatureRoutes(features,table,selected.routes,id=>{disposed.push(id);});
  assert.deepEqual(entries.map(route=>route.id),['mote.second','mote.first'],'a selected id without an actual contribution creates no phantom feature');
  assert.equal(entries[1]!.version,'2');
  // Collection is the startup snapshot, not a later lookup of a mutable list.
  features.push('mote.omitted');
  await installFeatureRoutes(routes,entries);await app.ready();
  assert.deepEqual(mounts,['second-owner','first-companion','first-owner','first-sibling']);
  for(const id of ['first-owner','first-sibling','second-owner','first-companion'])assert.equal((await app.inject({url:'/api/'+id})).statusCode,200);
  assert.equal((await app.inject({url:'/api/omitted'})).statusCode,404);
  assert.deepEqual(routes.contributions().map(value=>value.featureId).sort(),['mote.first','mote.second']);
  await selected.close();
  for(const id of ['first-owner','first-sibling','second-owner','first-companion'])assert.equal((await app.inject({url:'/api/'+id})).statusCode,503,'the collector must preserve each existing owner guard');
  await routes.close();await routes.close();
  assert.deepEqual(disposed.sort(),['mote.first','mote.second']);
  assert.equal(routes.contributions().length,0);
});
