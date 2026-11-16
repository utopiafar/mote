import {z} from 'zod';
import {instanceIdentitySchema, type InstanceIdentity} from '@mote/plugin-api/contracts';
import {runtimeAssemblySchema, type RuntimeAssembly} from '@mote/shared/agent-runtimes';
import {DEPLOYMENT_MODEL_PROFILE_ID} from '@mote/shared/models';
import {DSH_OFFICIAL_RUNTIME} from '@mote/agent';
import {modelProfileIdSchema, type ModelDomain} from './model-settings.js';

export const dshInstanceKey = (instance: InstanceIdentity) => JSON.stringify([instance.packageId, instance.installationId, instance.instanceId]);
export const dshAssemblyReferences = (assembly: RuntimeAssembly) => [...assembly.packages, ...assembly.hooks, ...(assembly.factory ? [assembly.factory] : [])];
const instance = z.unknown().transform((value, context): InstanceIdentity => {
  try { return instanceIdentitySchema.parse(value); }
  catch { context.addIssue({code: 'custom', message: 'Invalid installed instance reference'}); return z.NEVER; }
});
const capabilities = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)).max(64)
  .refine(values => new Set(values).size === values.length, 'Duplicate native capability');
const profile = z.object({
  modelProfileId: modelProfileIdSchema,
  assembly: runtimeAssemblySchema,
  /** Owner authorization, distinct from installation and check. Even a package
   * with no declared capabilities needs an explicit empty grant. */
  grants: z.array(z.object({instance, capabilities}).strict()).max(128),
}).strict().superRefine((value, context) => {
  const references = dshAssemblyReferences(value.assembly);
  const keys = references.map(reference => JSON.stringify([reference.contribution, reference.exportName]));
  const selected = new Set(references.map(reference => dshInstanceKey(reference.contribution.instance)));
  const grants = value.grants.map(grant => dshInstanceKey(grant.instance));
  if (new Set(keys).size !== keys.length || new Set(grants).size !== grants.length || grants.length !== selected.size || grants.some(key => !selected.has(key))) {
    context.addIssue({code: 'custom', message: 'Native selections require exactly one grant per installed instance'});
  }
});

/** Restart-only owner configuration. Paths, activation identities and launch
 * code are resolved by the Host, never supplied by configuration or a query. */
export const dshConfigurationSchema = z.object({profiles: z.array(profile).max(128).default([])}).strict().superRefine((value, context) => {
  if (new Set(value.profiles.map(profile => profile.modelProfileId)).size !== value.profiles.length) {
    context.addIssue({code: 'custom', message: 'Duplicate native model profile selection'});
  }
});
export type DshConfiguration = z.infer<typeof dshConfigurationSchema>;

/** Configuration references the same model identity used by the actual runtime
 * registry. A removed model or a non-DSH transport cannot silently drop packs. */
export function validateDshModelProfiles(configuration: DshConfiguration, models: ModelDomain): void {
  for (const profile of configuration.profiles) {
    const settings = profile.modelProfileId === DEPLOYMENT_MODEL_PROFILE_ID ? models.deployment : models.profiles.find(model => model.id === profile.modelProfileId)?.settings;
    if (!settings || !DSH_OFFICIAL_RUNTIME.capabilities.modelTransports.includes(settings.protocol)) throw new Error('Invalid native model profile selection');
  }
}
