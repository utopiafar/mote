import {ScopeError} from './baseline.js';
import {UserContextAuthority,type UserContext} from './context.js';
import {LifecycleAuthority,type LifecycleContext,type DomainLifecycle,type UserExport,type UserDataSubject,type LifecyclePurpose} from './lifecycle.js';

type UserRegistration<T>={scope:'user';create:(context:UserContext)=>T;lifecycle:DomainLifecycle};
/** Factories receive a host-bound identity, never a caller-selected owner id.
 * Existing Store/ConfigService/ExecutionEngine are adapted by their own modules;
 * do not put an unscoped Store in either registry. */
export class ScopedServices {
  private readonly users=new Map<string,UserRegistration<unknown>>();
  private readonly instances=new Map<string,unknown>();
  constructor(private readonly authority:UserContextAuthority,private readonly lifecycleAuthority?:LifecycleAuthority){}
  /** Domains revalidate at each SQL operation and transactional publication.
   * A lifecycle grant can only authorize its named domain and purpose. */
  assertSubject(context:UserDataSubject,domain:string,purpose:LifecyclePurpose){
    if('credentialId' in context){this.authority.assert(context);return;}
    if(!this.lifecycleAuthority)throw new ScopeError('scope_unavailable',503);
    this.lifecycleAuthority.assert(context);
    if(context.domain!==domain||context.purpose!==purpose)throw new ScopeError('invalid_identity',403);
  }
  registerUser<T>(id:string,registration:UserRegistration<T>){
    if(!id||this.users.has(id)||this.instances.has(id)||registration.scope!=='user'||!['exportUser','deleteUser','restoreUser'].every(key=>typeof registration.lifecycle?.[key as keyof DomainLifecycle]==='function'))throw new ScopeError('undeclared_scope',500);
    this.users.set(id,Object.freeze({...registration}));
  }
  registerInstance<T>(id:string,registration:{scope:'instance';service:T}){
    if(!id||this.instances.has(id)||this.users.has(id)||registration.scope!=='instance')throw new ScopeError('undeclared_scope',500);
    this.instances.set(id,registration.service);
  }
  forUser(context:UserContext){
    this.authority.assert(context);
    const domain=(id:string)=>{this.authority.assert(context);const entry=this.users.get(id);if(!entry)throw new ScopeError('scope_unavailable',503);return entry;};
    return Object.freeze({
      require:(id:string)=>{domain(id);},
      get:<T>(id:string)=>domain(id).create(context) as T,
      exportUser:async(id:string)=>{const result=await domain(id).lifecycle.exportUser(context);this.authority.assert(context);if(result.domain!==id||result.userId!==context.userId||result.deploymentId!==context.deploymentId)throw new ScopeError('invalid_identity',403);return result;},
      deleteUser:(id:string,operationId:string)=>domain(id).lifecycle.deleteUser(context,operationId),
      restoreUser:(id:string,archive:UserExport,operationId:string)=>{const entry=domain(id);if(archive.domain!==id||archive.userId!==context.userId||archive.deploymentId!==context.deploymentId)throw new ScopeError('invalid_identity',403);return entry.lifecycle.restoreUser(context,archive,operationId);},
    });
  }
  forInstance(context:UserContext){
    this.authority.assertAdministrator(context);
    return Object.freeze({get:<T>(id:string)=>{this.authority.assertAdministrator(context);if(!this.instances.has(id))throw new ScopeError('scope_unavailable',503);return this.instances.get(id) as T;}});
  }
  /** M16 supplies a durable, purpose-limited control-plane grant. Account disable
   * revokes ordinary access without preventing cleanup/reconciliation retries. */
  forLifecycle(context:LifecycleContext){
    const domain=()=>{if(!this.lifecycleAuthority)throw new ScopeError('scope_unavailable',503);this.lifecycleAuthority.assert(context);const entry=this.users.get(context.domain);if(!entry)throw new ScopeError('scope_unavailable',503);return entry.lifecycle;};
    domain();
    return Object.freeze({run:async(archive?:UserExport)=>{
      const lifecycle=domain();
      if(context.purpose==='delete')return lifecycle.deleteUser(context,context.operationId);
      if(context.purpose==='export'){const result=await lifecycle.exportUser(context);domain();if(result.domain!==context.domain||result.userId!==context.userId||result.deploymentId!==context.deploymentId)throw new ScopeError('invalid_identity',403);return result;}
      if(!archive||archive.domain!==context.domain||archive.userId!==context.userId||archive.deploymentId!==context.deploymentId)throw new ScopeError('invalid_identity',403);
      await lifecycle.restoreUser(context,archive,context.operationId);
    }});
  }
}
