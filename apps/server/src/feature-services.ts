import type {buildApp} from './app.js';
/** In-process services; each entry receives a statically checked Pick of its dependencies. */
export type FeatureServices=Awaited<ReturnType<typeof buildApp>>['featureServices'];
