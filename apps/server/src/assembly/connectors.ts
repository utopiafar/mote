import type {FastifyInstance} from 'fastify';
import type {Config} from '../config.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import type {Store} from '../store.js';
import type {Connections} from '../connections.js';
import type {MemoryRecipeSettings} from '../memory-recipe-settings.js';
import type {MemoryStrategies} from '../memory-strategies.js';
import type {FileStore} from '../files.js';
import type {SourceStore} from '../sources.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {MaterialStore} from '../materials.js';
import type {SourcePipelineRuntime} from '../source-pipelines.js';
import type {MaterialOrganizerRuntime} from '../material-organizers.js';
import type {ProcessingRuntime} from '../processing-runtime.js';
import {registerConnectors,type ConnectorTestDependencies} from '../connectors/index.js';
import type {ConnectorManifest} from '../connectors/registry.js';
import {ConnectorError} from '../connectors/types.js';
import {createDynamicHttpDispatcher} from '../plugins/dynamic-http-dispatcher.js';
import {ZodError} from 'zod';

export interface ConnectorsAssemblyDependencies {
  readonly app:FastifyInstance;
  readonly resources:ServerResources;
  readonly memoryRecipeSettings:MemoryRecipeSettings;
  readonly diagnostics:ServerDiagnostics;
  readonly memoryStrategies:MemoryStrategies;
  readonly files:FileStore;
  readonly sources:SourceStore;
  readonly store:Store;
  readonly evidenceReader:EvidenceReader;
  readonly materials:MaterialStore;
  readonly sourcePipelines:SourcePipelineRuntime;
  readonly materialOrganizers:MaterialOrganizerRuntime;
  readonly processing:ProcessingRuntime;
  readonly config:Config;
  readonly validOwnerBearer:(authorization:string|undefined)=>boolean;
  readonly connections:Connections;
  readonly connectorTesting?:ConnectorTestDependencies;
  readonly additionalManifests?:readonly ConnectorManifest[];
}

/** The connector registry over the live app instance — MCP transport, OAuth
 * callbacks, owner routes and sync — plus its close hook. */
export async function assembleConnectors(dependencies:ConnectorsAssemblyDependencies){
  const {app,resources,memoryRecipeSettings,diagnostics,memoryStrategies,files,sources,store,evidenceReader,materials,sourcePipelines,materialOrganizers,processing,config,validOwnerBearer,connections,additionalManifests=[]}=dependencies;
  const ownerAuthorization=(header:string|undefined)=>{if(validOwnerBearer(header))return true;const c=connections.authenticate(header);return !!c&&connections.isOwner(c);};
  // Attached before Fastify listen: one host-owned table serves every installed
  // connector and selects the activation that registered each route/callback.
  const dispatcher=createDynamicHttpDispatcher({
    authorize:request=>ownerAuthorization(request.headers.authorization),
    mapError:error=>error instanceof ConnectorError?{status:error.statusCode,error:error.code}:error instanceof ZodError?{status:400,error:'connector_input_invalid'}:undefined,
  });
  const connectors=await registerConnectors(app,{memoryRecipeSettings,diagnostics,memoryStrategies,files,sources,store,evidenceReader,materials,sourcePipelines,materialOrganizers,processing,config,ownerAuthorization,mcpAuthorization:header=>connections.mcpAuthorization(header,config.connectors)},dependencies.connectorTesting,additionalManifests,dispatcher);
  resources.defer(()=>connectors.close());
  return Object.freeze({connectors});
}
