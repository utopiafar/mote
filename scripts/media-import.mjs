#!/usr/bin/env node
// CLI-only offline import. Accepts fixed catalog files and verifies every hash before installation.
import {resolve} from 'node:path';
import {MediaAssets} from '../apps/server/dist/media-assets.js';
import {mediaRoleSchema,mediaAssetStatusSchema} from '@mote/shared';
const [root,role,directory]=process.argv.slice(2);
if(!root||!directory||!mediaRoleSchema.safeParse(role).success)throw Error(`Usage: media-import.mjs MODEL_ROOT ${mediaRoleSchema.options.join('|')} SOURCE_DIRECTORY`);
const assets=new MediaAssets(resolve(root));
const controller=new AbortController(),cancel=()=>controller.abort();
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{
  const status=await assets.importBundle(role,resolve(directory),controller.signal);
  console.info(JSON.stringify(mediaAssetStatusSchema.parse(status)));
}finally{
  process.off('SIGINT',cancel);process.off('SIGTERM',cancel);await assets.close();
}
