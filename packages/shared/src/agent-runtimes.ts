import {z} from 'zod';
import {availabilitySchema, instanceIdentitySchema, serviceBindingSchema, serviceRefSchema, type ContractSchema} from '@mote/plugin-api/contracts';

/** Current format only. These schemas contain selections/references, never launch code or credentials. */
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const contract = <T>(source: ContractSchema<T>) => z.unknown().transform((value, context): T => {
  try { return source.parse(value); }
  catch { context.addIssue({code: 'custom', message: 'Invalid runtime reference'}); return z.NEVER; }
});
export const RUNTIME_HOST_CAPABILITIES = ['tools', 'images', 'importWorkspace', 'hostDelegation'] as const;
export type RuntimeHostCapability = typeof RUNTIME_HOST_CAPABILITIES[number];
const capabilities = z.array(z.enum(RUNTIME_HOST_CAPABILITIES)).refine(values => new Set(values).size === values.length).readonly();
export const runtimeCapabilitiesSchema = z.object({
  modelTransports: z.array(id).readonly(), taskKinds: z.array(id).readonly(),
  tools: z.boolean(), images: z.boolean(), importWorkspace: z.boolean(), hostDelegation: z.boolean(),
  recovery: z.enum(['none', 'same-process', 'durable']), replacement: z.enum(['hot', 'restart']),
}).strict().readonly();
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;

/** Persistent selection omits activation/host incarnation; the actual run receives a live ServiceBinding. */
export const runtimeContributionReferenceSchema = z.object({instance: contract(instanceIdentitySchema), contributionId: id}).strict().readonly();
export const runtimeProviderReferenceSchema = z.object({
  service: contract(serviceRefSchema), provider: runtimeContributionReferenceSchema, revision,
}).strict().readonly();

/** Reference to an installed contribution's public export, not a filesystem/URL module specifier.
 * H03/A07 resolve the artifact from this identity; parsing alone neither installs nor grants it. */
export const runtimeModuleReferenceSchema = z.object({
  contribution: runtimeContributionReferenceSchema, revision, artifactDigest: digest,
  exportName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/),
}).strict().readonly();
export type RuntimeModuleReference = z.infer<typeof runtimeModuleReferenceSchema>;
const modules = z.array(runtimeModuleReferenceSchema).superRefine((values, context) => {
  const keys = values.map(value => JSON.stringify([value.contribution, value.exportName]));
  if (new Set(keys).size !== keys.length) context.addIssue({code: 'custom', message: 'Duplicate runtime module'});
}).readonly();
export const runtimeAssemblySchema = z.object({packages: modules, hooks: modules, factory: runtimeModuleReferenceSchema.optional()}).strict().readonly();
export type RuntimeAssembly = z.infer<typeof runtimeAssemblySchema>;
export const runtimeProfileSchema = z.object({
  id, name: z.string().trim().min(1).max(100), revision, runtimeProviderId: id,
  providerRef: runtimeProviderReferenceSchema, assembly: runtimeAssemblySchema, allowedHostCapabilities: capabilities,
}).strict().readonly();
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
export const runtimeAssignmentsSchema = z.object({chat: id, memory: id, insight: id, import: id, file: id}).strict().readonly();
export type RuntimeAssignments = z.infer<typeof runtimeAssignmentsSchema>;
export const runtimeSettingsSchema = z.object({
  schemaVersion: z.literal(1), revision, profiles: z.array(runtimeProfileSchema).readonly(), assignments: runtimeAssignmentsSchema,
}).strict().superRefine((settings, context) => {
  const ids = settings.profiles.map(profile => profile.id);
  if (new Set(ids).size !== ids.length || Object.values(settings.assignments).some(value => !ids.includes(value))) {
    context.addIssue({code: 'custom', message: 'Invalid runtime profile references'});
  }
}).readonly();
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export const runtimeProviderDescriptorSchema = z.object({
  id, binding: contract(serviceBindingSchema), capabilities: runtimeCapabilitiesSchema, availability: contract(availabilitySchema),
}).strict().readonly();
export type RuntimeProviderDescriptor = z.infer<typeof runtimeProviderDescriptorSchema>;
export const runtimeTaskRequirementsSchema = z.object({taskKind: id, capabilities}).strict().readonly();
export type RuntimeTaskRequirements = z.infer<typeof runtimeTaskRequirementsSchema>;

/** Safe projection only. The private model/runtime fingerprints are deliberately not fields. */
export const runSelectionReceiptSchema = z.object({
  schemaVersion: z.literal(1), revision,
  runtimeProviderId: id, runtimeProviderRevision: revision, runtimeProfileId: id, runtimeProfileRevision: revision,
  modelProfileId: id, modelProfileRevision: revision, modelRevision: revision,
  modelProviderId: id, modelId: z.string().min(1).max(512), transport: id,
  assemblyFingerprint: digest, taskKind: id, selectionFingerprint: digest,
}).strict().readonly();
export type RunSelectionReceipt = z.infer<typeof runSelectionReceiptSchema>;
export const runtimeSelectionErrorCodes = [
  'runtime_settings_invalid', 'runtime_profile_missing', 'runtime_provider_missing', 'runtime_provider_unavailable',
  'runtime_binding_stale', 'runtime_module_unavailable', 'model_profile_missing', 'model_not_configured', 'incompatible_runtime_model',
  'runtime_capability_missing', 'runtime_capability_denied',
] as const;
export type RuntimeSelectionErrorCode = typeof runtimeSelectionErrorCodes[number];
