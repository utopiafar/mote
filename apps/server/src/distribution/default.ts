import {timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import type {ManifestContribution} from '@mote/plugin-api';
import {configDocumentDomains,configFromDocument,documentFromConfig,validateResolvedConfigDocument,type ConfigDocument} from '../config.js';
import {createConfigurationPlatform} from '../plugins/configuration-platform.js';
import {createVaultPlatformAssembly} from '../plugins/vault-platform.js';
import {serverFeatureAdapters} from '../features/index.js';
import {plugins as platformPlugins} from '../assembly/platform.js';
import {plugins as sourcePlugins} from '../assembly/sources.js';
import type {CentralDistribution,FoundationKind,FoundationProvider} from '../bootstrap.js';

const contribution=(kind:FoundationKind):ManifestContribution=>Object.freeze<ManifestContribution>({id:`mote.platform.${kind}`,version:'1.0.0',surface:'data',runtime:'host',
  provides:[{kind:'service',id:`mote.platform.${kind}`,apiVersion:'1',cardinality:'single'}]});

/** Fixed build registrations, not installable release descriptors. No synthetic
 * archive/digest and no user-supplied code. Existing domain adapters retain their
 * request/commit authorization; owner bearer checking is only the first C04 seam. */
export const configurationProvider:FoundationProvider<'configuration'>=Object.freeze<FoundationProvider<'configuration'>>({kind:'configuration',id:'mote.configuration',version:'1.0.0',contribution:contribution('configuration'),
  async create(context,input){
    const supplied=input.configService??input.config.configService;
    // The supplied bootstrap service transfers into this lifecycle unchanged;
    // only a self-created service registers builtin domains here.
    const platform=createConfigurationPlatform({path:input.config.configuration?.configFile??join(input.config.dataDir,'mote.yaml'),initialDocument:documentFromConfig(input.config)},
      supplied?{configService:supplied}:{});
    context.scope.defer(()=>platform.close());
    await platform.prepare();
    const service=platform.configService;
    const document={version:1,revision:service.revision,...Object.fromEntries(configDocumentDomains().map(domain=>[domain.id,service.current(domain.id)]))} as ConfigDocument;
    const config=configFromDocument(document,service.path,{token:input.config.token,tokenPath:input.config.tokenPath},{resolvedDocument:true});
    service.setValidator(document=>validateResolvedConfigDocument(document,config.token));
    return {config,service,platform};
  }});
export const storageProvider:FoundationProvider<'storage'>=Object.freeze<FoundationProvider<'storage'>>({kind:'storage',id:'mote.vault-platform',version:'1.0.0',contribution:contribution('storage'),
  async create(context,{config,store:supplied,backgroundWorker}){
    // C02's trusted assembly bridge owns the actual resources. Its raw access is
    // private to this transitional root, never a published scoped write service.
    const assembly=createVaultPlatformAssembly({dataDir:config.dataDir,dataKey:config.dataKey,contentEncryptionEnabled:config.contentEncryptionEnabled,maxStorageBytes:config.maxStorageBytes,
      embeddingEnabled:Boolean(config.embeddingModel),maintenance:Boolean(backgroundWorker)},supplied?{store:supplied}:{});
    context.scope.defer(()=>assembly.close());
    await assembly.prepare();
    return {store:assembly.store,assembly};
  }});
export const authorizationProvider:FoundationProvider<'authorization'>=Object.freeze<FoundationProvider<'authorization'>>({kind:'authorization',id:'mote.owner-authorization',version:'1.0.0',contribution:contribution('authorization'),
  create(_context,{config}){
    if(!config.token)throw Error('Owner authorization token is required');
    const expected=Buffer.from(`Bearer ${config.token}`);
    return {validOwnerBearer(authorization){if(typeof authorization!=='string')return false;const supplied=Buffer.from(authorization);return supplied.length===expected.length&&timingSafeEqual(supplied,expected);}};
  }});
export const defaultDistribution:CentralDistribution=Object.freeze({foundations:Object.freeze([configurationProvider,storageProvider,authorizationProvider]),features:serverFeatureAdapters,
  plugins:Object.freeze([...platformPlugins,...sourcePlugins])});
