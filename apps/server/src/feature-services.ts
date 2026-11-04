import {actionsFeatureServiceMembers} from './feature-services/actions.js';
import {activityFeatureServiceMembers} from './feature-services/activity.js';
import {agentFeatureServiceMembers} from './feature-services/agent.js';
import {authorizationFeatureServiceMembers} from './feature-services/authorization.js';
import {captureFeatureServiceMembers} from './feature-services/capture.js';
import {configurationFeatureServiceMembers} from './feature-services/configuration.js';
import {connectorsFeatureServiceMembers} from './feature-services/connectors.js';
import {controlFeatureServiceMembers} from './feature-services/control.js';
import {executionFeatureServiceMembers} from './feature-services/execution.js';
import {filesFeatureServiceMembers} from './feature-services/files.js';
import {hostFeatureServiceMembers} from './feature-services/host.js';
import {importsFeatureServiceMembers} from './feature-services/imports.js';
import {materialsFeatureServiceMembers} from './feature-services/materials.js';
import {mediaFeatureServiceMembers} from './feature-services/media.js';
import {memoryControlFeatureServiceMembers} from './feature-services/memoryControl.js';
import {memoryProvidersFeatureServiceMembers} from './feature-services/memoryProviders.js';
import {memoryRecordsFeatureServiceMembers} from './feature-services/memoryRecords.js';
import {memoryRuntimeFeatureServiceMembers} from './feature-services/memoryRuntime.js';
import {observabilityFeatureServiceMembers} from './feature-services/observability.js';
import {processingFeatureServiceMembers} from './feature-services/processing.js';
import {publicationFeatureServiceMembers} from './feature-services/publication.js';
import {queryFeatureServiceMembers} from './feature-services/query.js';
import {sourceRuntimeFeatureServiceMembers} from './feature-services/sourceRuntime.js';
import {vaultFeatureServiceMembers} from './feature-services/vault.js';
import type {ActionsFeatureServices} from './feature-services/actions.js';
import type {ActivityFeatureServices} from './feature-services/activity.js';
import type {AgentFeatureServices} from './feature-services/agent.js';
import type {AuthorizationFeatureServices} from './feature-services/authorization.js';
import type {CaptureFeatureServices} from './feature-services/capture.js';
import type {ConfigurationFeatureServices} from './feature-services/configuration.js';
import type {ConnectorsFeatureServices} from './feature-services/connectors.js';
import type {ControlFeatureServices} from './feature-services/control.js';
import type {ExecutionFeatureServices} from './feature-services/execution.js';
import type {FilesFeatureServices} from './feature-services/files.js';
import type {HostFeatureServices} from './feature-services/host.js';
import type {ImportsFeatureServices} from './feature-services/imports.js';
import type {MaterialsFeatureServices} from './feature-services/materials.js';
import type {MediaFeatureServices} from './feature-services/media.js';
import type {MemoryControlFeatureServices} from './feature-services/memoryControl.js';
import type {MemoryProvidersFeatureServices} from './feature-services/memoryProviders.js';
import type {MemoryRecordsFeatureServices} from './feature-services/memoryRecords.js';
import type {MemoryRuntimeFeatureServices} from './feature-services/memoryRuntime.js';
import type {ObservabilityFeatureServices} from './feature-services/observability.js';
import type {ProcessingFeatureServices} from './feature-services/processing.js';
import type {PublicationFeatureServices} from './feature-services/publication.js';
import type {QueryFeatureServices} from './feature-services/query.js';
import type {SourceRuntimeFeatureServices} from './feature-services/sourceRuntime.js';
import type {VaultFeatureServices} from './feature-services/vault.js';

/** Feature entries receive a checked Pick of these domain-owned capabilities.
 * Each slice keeps its members and member-name constant next to its C01 slice;
 * assemblies fill the members they already assemble. */
export type FeatureServices =
  & VaultFeatureServices
  & ConfigurationFeatureServices
  & AuthorizationFeatureServices
  & ExecutionFeatureServices
  & ObservabilityFeatureServices
  & ControlFeatureServices
  & SourceRuntimeFeatureServices
  & CaptureFeatureServices
  & FilesFeatureServices
  & ConnectorsFeatureServices
  & ProcessingFeatureServices
  & MediaFeatureServices
  & MaterialsFeatureServices
  & ImportsFeatureServices
  & MemoryControlFeatureServices
  & MemoryRecordsFeatureServices
  & MemoryRuntimeFeatureServices
  & MemoryProvidersFeatureServices
  & PublicationFeatureServices
  & ActionsFeatureServices
  & ActivityFeatureServices
  & QueryFeatureServices
  & AgentFeatureServices
  & HostFeatureServices;

/** One member-name list per C01 slice, used to audit the legacy resource names. */
export const featureServiceMembers=Object.freeze({
  vault:vaultFeatureServiceMembers,
  configuration:configurationFeatureServiceMembers,
  authorization:authorizationFeatureServiceMembers,
  execution:executionFeatureServiceMembers,
  observability:observabilityFeatureServiceMembers,
  control:controlFeatureServiceMembers,
  sourceRuntime:sourceRuntimeFeatureServiceMembers,
  capture:captureFeatureServiceMembers,
  files:filesFeatureServiceMembers,
  connectors:connectorsFeatureServiceMembers,
  processing:processingFeatureServiceMembers,
  media:mediaFeatureServiceMembers,
  materials:materialsFeatureServiceMembers,
  imports:importsFeatureServiceMembers,
  memoryControl:memoryControlFeatureServiceMembers,
  memoryRecords:memoryRecordsFeatureServiceMembers,
  memoryRuntime:memoryRuntimeFeatureServiceMembers,
  memoryProviders:memoryProvidersFeatureServiceMembers,
  publication:publicationFeatureServiceMembers,
  actions:actionsFeatureServiceMembers,
  activity:activityFeatureServiceMembers,
  query:queryFeatureServiceMembers,
  agent:agentFeatureServiceMembers,
  host:hostFeatureServiceMembers,
} as const);

export type {RequestParser} from './feature-services/media.js';
