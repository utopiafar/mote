import assert from 'node:assert/strict';
import {TOPIC_CLASSIFICATION_INSTRUCTION} from '../../src/automatic-topics.js';
import {randomUUID} from 'node:crypto';
import type {buildApp} from '../../src/app.js';
import type {ModelConnection,ModelDataScope} from '../../src/background-model-authorization.js';

type Node=Pick<Awaited<ReturnType<typeof buildApp>>,'app'|'featureServices'|'modelAuthorizationHost'>;
/** Explicit test-owner consent through the production HTTP boundary. Call after
 * configuring fixture connections and before original intake. Never call on
 * every intake/tick/restart: denied receipts and revocation must stay denied. */
export async function authorizeFixtureModels(node:Node,scope:ModelDataScope={sourceIds:null,dataKinds:['text','image','audio','conversation']}){
 const headers={authorization:'Bearer '+node.featureServices.config.token};
 const response=await node.app.inject({url:'/api/model-authorization',headers});assert.equal(response.statusCode,200,response.body);
 const view=response.json();
 const command=await node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers,payload:{revision:view.authorization.revision,operationId:randomUUID(),action:'authorize',connections:view.connections,scope}});
 assert.equal(command.statusCode,200,command.body);return command.json();
}
/** For a fixture that deliberately calls an internal foreground operation
 * instead of its HTTP owner route. Wrap only that explicit operation, including
 * its enqueue when applicable. Never wrap background ticks or all fixture work. */
export function withFixtureOwnerModelWork<T>(node:Node,task:()=>Promise<T>,options:{connections?:ModelConnection[];identities?:readonly string[]}={}){
 return node.modelAuthorizationHost.manual('fixture-owner:'+randomUUID(),options.connections??node.featureServices.availableModelConnections(),task,undefined,'manual',options.identities??[]);
}

/** Opt-in generated response for suites testing extraction/review rather than
 * topic quality. Check this before business-phase counters; never suppress the
 * production classifier, its admission, transport fence or persisted outcome. */
export function fixtureTopicResult(input:import('@mote/agent').QueryInput):import('@mote/shared').QueryResult|undefined{
 if(!input.question.startsWith(TOPIC_CLASSIFICATION_INSTRUCTION+'\n'))return;
 return {answer:'{"trees":[]}',citations:[],trace:[],runId:randomUUID()};
}
