import {registerFileExport} from './file-export.js';
import {registerIndexMaintenance} from './index-maintenance.js';
import {registerInstanceControls} from './instance-controls.js';
import {registerScopedContentStorage,type ScopedContentStorage} from './content-storage.js';
import {registerScopedTodos} from './todos.js';
import {registerScopedActions} from './action-routes.js';
import type {ScopedActions} from './actions.js';
import {registerWebAssets} from '../web-assets.js';
import {registerWebInventory} from './web-routes.js';
import {registerScopedActivity} from './activity.js';
import {registerOwnerQuestions} from './owner-question-routes.js';
import {registerScopedConnectors} from './connector-routes.js';
import type {ScopedConnectors} from './connectors.js';
import type {ConnectorTransports,ConnectorDefinition} from './connector-contract.js';
import {ConnectorError} from '../connectors/types.js';
import Fastify from 'fastify';
import {ZodError} from 'zod';
import {SCOPE_BASELINE,ScopeError} from './baseline.js';
import {UserContextAuthority,type IdentityVerifier} from './context.js';
import {ScopedServices} from './services.js';
import {openScopeStorage} from './storage.js';
import {Accounts,AuthError} from './accounts.js';
import {registerAuthentication} from './auth-routes.js';
import {requestContext} from './http.js';
import {ConnectionError} from '../connection-error.js';
import {TaskAuthorization} from './task-authorization.js';
import {TaskExecution,TaskError} from './task-execution.js';
import {registerTaskRoutes} from './task-routes.js';
import {registerIngress} from './ingress-routes.js';
import {StoreError} from '../execution-storage.js';
import {registerPrivateData} from './private-data-routes.js';
import {PrivateDataError} from './private-data-sql.js';
import {Configurations} from './configuration.js';
import {registerConfigurationRoutes} from './configuration-routes.js';
import {ConfigServiceError,type ConfigDocument} from '../config-service.js';
import type {LifecycleAuthority} from './lifecycle.js';
import {registerScopedPlugins} from './plugin-routes.js';
import type {PluginReleaseTransport} from '../plugin-release.js';
import {registerAsk} from './ask-routes.js';
import {AskError} from './ask-schema.js';
import type {AskHost} from './ask.js';
import {registerMemory} from './memory-routes.js';
import {ScopedMemoryError} from './memory-schema.js';
import type {HindsightRuntimeFactory} from './memory-providers.js';
import type {MemoryHost} from './memory.js';
import {registerProcessing} from './processing-routes.js';
import type {ProcessingHost} from './processing.js';
import type {ScopedPluginHost} from './plugins.js';
import {registerScopedMcp,type ScopedMcp} from './mcp.js';
import {LifecycleOperations} from './lifecycle-operations.js';
import {registerManagement,type ManagementConfig} from './management.js';
import {registerLifecycleRoutes} from './lifecycle-routes.js';
import {registerCaptureBrowserReads} from './capture-browser-routes.js';
export {registerUserRoute,requestContext} from './http.js';

/** Production composition. Domains register only after their isolation adapter
 * is complete. Account administration never mounts the retired owner services. */
export async function buildScopedApp(config:ManagementConfig&{dataDir:string;maxExportBytes?:number;configuration?:ManagementConfig['configuration']&{publicUrl?:string|null;configFile?:string|null;document?:ConfigDocument}},options:{verifier?:IdentityVerifier;lifecycleAuthority?:LifecycleAuthority;pluginReleaseTransport?:PluginReleaseTransport;connectorTransports?:ConnectorTransports;connectorDefinitions?:readonly ConnectorDefinition[];hindsightRuntimeFactory?:HindsightRuntimeFactory;updateDependencies?:Parameters<typeof registerManagement>[3]}={}){
  const storage=openScopeStorage(config.dataDir);
  let configuration:Configurations|undefined;
  let contentStorage:ScopedContentStorage|undefined;
  let plugins:ScopedPluginHost|undefined;
  let connectors:ScopedConnectors|undefined;
  let memory:MemoryHost|undefined;
  let ask:AskHost|undefined;
  let processing:ProcessingHost|undefined;
  let mcp:ScopedMcp|undefined;
  let actions:ScopedActions|undefined;
  let lifecycle:LifecycleOperations|undefined;
  let management:Awaited<ReturnType<typeof registerManagement>>|undefined;
  try{
    const app=Fastify({logger:false});
    const accounts=new Accounts(storage.db,storage.deploymentId);
    lifecycle=!options.verifier?new LifecycleOperations(storage.db,storage.deploymentId,config.maxExportBytes):undefined;
    const lifecycleAuthority=options.lifecycleAuthority??lifecycle?.authority;
    const taskAuthorization=!options.verifier?new TaskAuthorization(storage.db,accounts,storage.deploymentId):undefined;
    const authority=new UserContextAuthority(storage.deploymentId,options.verifier??accounts,taskAuthorization,!options.verifier?accounts.mcpVerifier:undefined),services=new ScopedServices(authority,lifecycleAuthority);
    const execution=taskAuthorization?new TaskExecution(storage.db,authority,services,taskAuthorization):undefined;
    const runtime={app,authority,services,...(!options.verifier?{accounts}:{})};
    lifecycle?.bind(runtime);
    registerWebInventory(runtime);
    app.setErrorHandler((error,_request,reply)=>{
      const failure=error instanceof AskError||error instanceof ConnectorError||error instanceof ScopeError||error instanceof AuthError||error instanceof ConnectionError||error instanceof PrivateDataError||error instanceof TaskError||error instanceof ConfigServiceError||error instanceof ScopedMemoryError?error:error instanceof StoreError?new TaskError(error.statusCode===404?'not_found':error.statusCode===409?'conflict':'execution_unavailable',error.statusCode):error instanceof ZodError?new AuthError('invalid_request',400):new ScopeError('scope_unavailable',503);
      return reply.code(failure.statusCode).send({error:failure.code});
    });
    if(!options.verifier)registerAuthentication({...runtime,accounts},config.configuration?.publicUrl);
    app.get('/api/health',async()=>({ok:true,mode:'multiuser-auth',protocol:{min:SCOPE_BASELINE.wireProtocol,max:SCOPE_BASELINE.wireProtocol},storageEpoch:SCOPE_BASELINE.storageEpoch,authentication:'username-password',privateCapabilities:['private-data','configuration','ingress',...(execution?['execution','plugins','processing','connectors','memory','ask']:[]),...(actions?['actions','todos']:[]),...(mcp?['mcp-sources']:[]),...(mcp&&memory?['mcp-memory']:[])]}));
    const privateCursorKey=registerPrivateData(runtime,storage.db);
    configuration=await Configurations.open({directory:config.dataDir,db:storage.db,authority,accounts:runtime.accounts,lifecycleAuthority,instancePath:config.configuration?.configFile??undefined,instanceDocument:config.configuration?.document});
    registerConfigurationRoutes(runtime,configuration);
    execution?.bindConfiguration(configuration);
    if(execution){registerInstanceControls(runtime,configuration,execution);registerIndexMaintenance(runtime,storage.db,execution); }
    if(execution)contentStorage=registerScopedContentStorage(runtime,storage.db,config.dataDir,configuration,execution);
    const ingress=registerIngress(runtime,storage.db,config.dataDir,contentStorage?.cipher);
    registerFileExport(runtime,storage.db,ingress,configuration);
    const ownerQuestions=registerOwnerQuestions(runtime,storage.db);
    if(!options.verifier)mcp=registerScopedMcp(runtime,storage.db,configuration,ingress);
    plugins=execution?registerScopedPlugins(runtime,{db:storage.db,directory:config.dataDir,configuration,execution,releaseTransport:options.pluginReleaseTransport}):undefined;
    plugins?.bindSource((context,sourceIds,assertCurrent)=>{
      const {receiveCaptures,receiveSourceItems,readOriginal,pageOriginals,publishMaterial}=ingress.bindSource(context,sourceIds,assertCurrent);
      return Object.freeze({receiveCaptures,receiveSourceItems,readOriginal,pageOriginals,publishMaterial});
    });
    if(execution&&plugins){processing=registerProcessing(runtime,storage.db,configuration,execution,ingress,plugins,privateCursorKey,config.importPythonPacks);await processing.ready();}
    registerCaptureBrowserReads(runtime,ingress,processing,(context,id)=>{if(!ask)throw new ScopeError('scope_unavailable',503);return ask.originalReadReceipt(context,id);});
    if(execution&&plugins){memory=registerMemory(runtime,storage.db,configuration,execution,plugins,{hindsightRuntimeFactory:options.hindsightRuntimeFactory},ownerQuestions);memory.bindIngress(ingress);if(processing)memory.bindProcessing(processing);mcp?.bindMemory(memory);}
    if(execution&&memory){ask=registerAsk(runtime,storage.db,configuration,execution,ingress,memory);if(processing)ask.bindProcessing(processing);mcp?.bindAsk(ask);}
    const todos=ask?registerScopedTodos(runtime,storage.db):undefined;
    if(execution&&ask)actions=registerScopedActions(runtime,storage.db,configuration,execution,ownerQuestions,ask,ingress);
    if(execution&&plugins)connectors=registerScopedConnectors(runtime,{db:storage.db,directory:config.dataDir,cursorKey:privateCursorKey,configuration,execution,plugins,ingress,processing,transports:options.connectorTransports,definitions:options.connectorDefinitions});
    if(connectors&&mcp){const host=mcp;connectors.registerSourceStatusReader((context,ids)=>host.forUser(context).sourceStatuses(ids));}
    if(execution){registerTaskRoutes(runtime,execution,privateCursorKey);app.addHook('onReady',async()=>execution.start());app.addHook('preClose',async()=>{await lifecycle?.close();await mcp?.close();await execution.close();await contentStorage?.close();await actions?.close();await ask?.close();await connectors?.close();await memory?.close();await processing?.close();await plugins?.close();});}
    if(lifecycle&&ask)lifecycle.bindImportPublication((context,work)=>ask!.automations.preserveImportEvents(context,work));
    if(lifecycle){lifecycle.recover();registerLifecycleRoutes(runtime,lifecycle);management=await registerManagement(runtime,configuration,config,options.updateDependencies);}
    if(execution&&ask&&memory&&processing&&lifecycle)registerScopedActivity(runtime,storage.db,execution,{ask,memory,processing,lifecycle});
    await registerWebAssets(app);
    app.setNotFoundHandler(async(req,reply)=>{if(req.url.startsWith('/api/'))await requestContext(req,authority,runtime.accounts);else return reply.code(404).send({error:'not_found'});return reply.code(503).send({error:'scope_unavailable'});});
    app.addHook('onClose',async()=>{await lifecycle?.close();await mcp?.close();await actions?.close();await ask?.close();await connectors?.close();await memory?.close();await processing?.close();await plugins?.close();ownerQuestions.close();await contentStorage?.close();await configuration?.close();await management?.close();accounts.close();storage.close();});
    return {...runtime,execution,configuration,contentStorage,plugins,ingress,processing,connectors,memory,mcp,ask,ownerQuestions,todos,actions,lifecycle,deploymentId:storage.deploymentId};
  }catch(error){await lifecycle?.close();await mcp?.close();await actions?.close();await ask?.close();await connectors?.close();await memory?.close();await processing?.close();await plugins?.close();await contentStorage?.close();await configuration?.close();await management?.close();storage.close();throw error;}
}
