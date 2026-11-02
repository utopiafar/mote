import type {ContextReader} from '@mote/agent';
import type {EvidenceReader} from '../evidence-reader.js';
import type {ContextQuery} from '../context-query.js';
import {createContextQuery} from '../context-query-composition.js';
import {ServerDiagnostics} from '../diagnostics.js';
import type {SourceStore} from '../sources.js';
import type {Store} from '../store.js';
import type {MaterialStore} from '../materials.js';
import {mcpImportState,type McpImportState} from './mcp-import-state.js';
import {ConnectorError,type ConnectorConfig,type ConnectorContext} from './types.js';

export interface McpReadContext {
 sources:Pick<SourceStore,'getSource'|'getItem'|'listSources'>;
 reader:Pick<EvidenceReader,'queryPage'|'fileCatalog'|'memorySnapshot'|'retainMemorySnapshot'|'releaseMemorySnapshot'>;
 queryReader(currentGrantContext:()=>object|undefined):ContextReader;
 context:Pick<ContextQuery,'readAsync'|'status'>;
 materials?:Pick<MaterialStore,'get'>;
 activity:Pick<Store,'activity'|'mediaActivity'>;
 assertFileCatalogSource(sourceId:string):void;
}
export interface McpWriteContext {
 sourceIds?:string[];
 putItem:SourceStore['upsert'];
}
export type McpConfiguration=Pick<ConnectorConfig,'mcpEnabled'|'mcpReadToken'|'mcpWriteEnabled'|'mcpWriteToken'|'mcpWriteSourceIds'>;
export interface McpContext {
 read:McpReadContext;
 write:Omit<McpWriteContext,'sourceIds'>;
 configuration():McpConfiguration;
 allowedOrigins:string[];
 authorizeCredential?:ConnectorContext['mcpAuthorization'];
}
/** Composition resolves implementations once. Each MCP server receives only
 * its read or write audience, never the owner token or the global Store. */
export function mcpContext(context:ConnectorContext):McpContext {
 const {store,sources,materials,sourcePipelines,materialOrganizers,config}=context;
 const reader=context.evidenceReader;
 const query=context.contextQuery??createContextQuery(store,sources,reader);
 const diagnostics=new ServerDiagnostics({directory:config.dataDir,enabled:false});
 const read:McpReadContext={sources:{getSource:sources.getSource.bind(sources),getItem:sources.getItem.bind(sources),listSources:sources.listSources.bind(sources)},
  reader:{queryPage:reader.queryPage.bind(reader),fileCatalog:reader.fileCatalog.bind(reader),memorySnapshot:reader.memorySnapshot.bind(reader),retainMemorySnapshot:reader.retainMemorySnapshot.bind(reader),releaseMemorySnapshot:reader.releaseMemorySnapshot.bind(reader)},
  queryReader:currentGrantContext=>reader.agent({diagnostics,currentGrantContext}),context:{readAsync:query.readAsync.bind(query),status:query.status.bind(query)},
  ...(materials?{materials:{get:materials.get.bind(materials)}}:{}),activity:{activity:store.activity.bind(store),mediaActivity:store.mediaActivity.bind(store)},
  assertFileCatalogSource:sourceId=>{
   const source=sources.getSource(sourceId),pipeline=sourcePipelines?.select(source);
   if(source.kind==='coding-agent'||pipeline?.storage==='archive')throw new ConnectorError('source_query_exposure_denied',403);
   const routes=materialOrganizers?.sourceItemRecipes.routesForSourceId(sourceId);
   if(routes&&!routes.some(route=>route.audience==='query'&&route.readProjection==='capture'))throw new ConnectorError('source_query_exposure_denied',403);
  },
 };
 return {read,write:{putItem:sources.upsert.bind(sources)},configuration:()=>{
  const options=config.connectors;return {mcpEnabled:options?.mcpEnabled,mcpReadToken:options?.mcpReadToken,mcpWriteEnabled:options?.mcpWriteEnabled,mcpWriteToken:options?.mcpWriteToken,mcpWriteSourceIds:options?.mcpWriteSourceIds};
 },allowedOrigins:config.allowedOrigins,authorizeCredential:context.mcpAuthorization};
}
export interface RemoteMcpContext {
 allowLocal():boolean|undefined;
 sources:Pick<SourceStore,'getSource'|'getItem'|'reportStatus'|'upsert'|'upsertBatch'>;
 manifests:McpImportState;
}
export function remoteMcpContext(context:Pick<ConnectorContext,'config'|'sources'|'store'>):RemoteMcpContext {
 const {sources,config}=context;
 return {allowLocal:()=>config.connectors?.allowLocalMcp,sources:{getSource:sources.getSource.bind(sources),getItem:sources.getItem.bind(sources),reportStatus:sources.reportStatus.bind(sources),upsert:sources.upsert.bind(sources),upsertBatch:sources.upsertBatch.bind(sources)},manifests:mcpImportState(context.store)};
}
