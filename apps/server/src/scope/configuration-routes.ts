import {z} from 'zod';
import {MODEL_FEATURES} from '@mote/shared/models';
import {registerAuthenticatedRoute,registerUserRoute,type ScopedRuntime} from './http.js';
import type {Configurations,UserConfigurationService} from './configuration.js';

const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Page editors and operator file edits use exactly the same domain registry,
 * queue and CAS. These endpoints cannot select a target account or file path. */
export function registerConfigurationRoutes(runtime:ScopedRuntime,configuration:Configurations){
  runtime.services.registerUser('configuration',{scope:'user',create:context=>configuration.forUser(context),lifecycle:configuration.lifecycle});
  runtime.services.registerInstance('model-resources',{scope:'instance',service:configuration.instance});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/configuration',service:'configuration',handle:({services})=>services.get<UserConfigurationService>('configuration').view()});
  registerUserRoute(runtime,{scope:'user',method:'PATCH',url:'/api/configuration',service:'configuration',handle:({services,request})=>{
    const input=z.object({revision,patches:z.record(z.unknown())}).strict().parse(request.body);
    return services.get<UserConfigurationService>('configuration').update(input.patches,input.revision);
  }});
  registerUserRoute(runtime,{scope:'user',method:'PUT',url:'/api/configuration/:domain',service:'configuration',handle:({services,request})=>{
    const input=z.object({revision,value:z.unknown()}).strict().parse(request.body),domain=z.object({domain:z.string().regex(/^[a-z][a-zA-Z0-9_-]*$/)}).strict().parse(request.params).domain;
    return services.get<UserConfigurationService>('configuration').replace(domain,input.value,input.revision);
  }});
  registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/configuration/reload',service:'configuration',handle:({services,request})=>{z.object({}).strict().parse(request.body??{});return services.get<UserConfigurationService>('configuration').reload();}});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/models',service:'configuration',handle:({services})=>services.get<UserConfigurationService>('configuration').models()});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/models/selection/:feature',service:'configuration',handle:({services,request})=>{
    const feature=z.object({feature:z.enum(MODEL_FEATURES)}).strict().parse(request.params).feature;
    return services.get<UserConfigurationService>('configuration').selection(feature);
  }});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/usage',service:'configuration',handle:({services})=>services.get<UserConfigurationService>('configuration').usage()});
  // Instance administration only exposes the deployment resource domain. The
  // general private endpoint above always stays bound to the admin's own user.
  registerAuthenticatedRoute(runtime,{method:'GET',url:'/api/admin/configuration/models',administrator:true,handle:()=>{
    const view=configuration.instance.view();return {version:view.version,revision:view.revision,domains:view.domains.filter(d=>d.id==='models'),lastError:view.lastError};
  }});
  registerAuthenticatedRoute(runtime,{method:'PUT',url:'/api/admin/configuration/models',administrator:true,handle:(context,request)=>{
    const input=z.object({revision,value:z.unknown()}).strict().parse(request.body);
    return configuration.instance.replace('models',input.value,input.revision,()=>runtime.authority.assertAdministrator(context)).then(view=>({version:view.version,revision:view.revision,domains:view.domains.filter(d=>d.id==='models'),lastError:view.lastError}));
  }});
}
