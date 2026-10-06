import type {FastifyInstance} from 'fastify';
import type {FeatureServices} from '../feature-services.js';
import {registerActivity} from '../activity.js';

/** Product progress reads the same canonical execution receipts as diagnostics. */
export function register(app:FastifyInstance,{activity,credential}:Pick<FeatureServices,'activity'|'credential'>){
  registerActivity(app,activity,request=>Boolean(credential(request)));
}
