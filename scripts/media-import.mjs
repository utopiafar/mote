#!/usr/bin/env node
// CLI-only offline import. Accepts fixed catalog files and verifies every hash before installation.
import {resolve} from 'node:path';
import {MediaAssets} from '../apps/server/dist/media-assets.js';
const [root,role,directory]=process.argv.slice(2);
if(!root||!directory||!['ocr','dialogue'].includes(role))throw Error('Usage: media-import.mjs MODEL_ROOT ocr|dialogue SOURCE_DIRECTORY');
const assets=new MediaAssets(resolve(root));
await assets.importBundle(role,resolve(directory));
console.info(JSON.stringify({role,installed:true,version:assets.status(role).version}));
