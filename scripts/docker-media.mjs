/** Deployment resource choices, independent of model preparation, plugin
 * selection and authorization for processing work. Never infer them from a
 * port, token, endpoint or image tag. */
export const dockerMediaRoles=Object.freeze(['ocr','asr']);
export function dockerImageVariant(value='core'){
  if(!['core','full'].includes(value))throw Error('Docker image variant must be core or full');
  return value;
}
export function dockerMediaWorkers(value=[]){
  if(!Array.isArray(value)||value.some(role=>!dockerMediaRoles.includes(role))||new Set(value).size!==value.length)throw Error('media.dockerWorkers must contain distinct ocr/asr roles');
  return dockerMediaRoles.filter(role=>value.includes(role));
}
export function parseDockerMediaWorkers(value){
  return dockerMediaWorkers(value===undefined||value==='none'?[]:value.split(','));
}
export function dockerMediaSelection(p){
  return {variant:dockerImageVariant(p.meta.imageVariant),workers:dockerMediaWorkers(p.document.media?.dockerWorkers)};
}
export function assertDockerMediaSelection(p){
  const selection=dockerMediaSelection(p);
  if(selection.variant==='core'&&selection.workers.length)throw Error('Managed Docker media workers require the full image variant; keep media.dockerWorkers empty for core');
  return selection;
}
/** Probe only immutable runtime dependencies, without network, owner data,
 * model weights or inference. The general deployment contract is separate. */
export async function assertDockerMediaRuntime(p,run){
  const {workers}=assertDockerMediaSelection(p);if(!workers.length)return;
  const binaries=workers.map(role=>`/opt/mote-media/${role==='asr'?'dialogue':role}/bin/python`);
  const probe=`import {accessSync,constants} from 'node:fs';for(const path of ${JSON.stringify([...binaries,'/usr/bin/ffmpeg'])})accessSync(path,constants.X_OK);`;
  try{await run('docker',['run','--rm','--pull','never','--network','none','--entrypoint','node',p.meta.image,'--input-type=module','-e',probe],{capture:true,timeoutMs:15000});}
  catch{throw Error('The selected image lacks the requested Docker media runtime; build/select the full image before starting workers');}
}
