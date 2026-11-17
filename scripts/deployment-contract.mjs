import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEPLOYMENT_CONTRACT_VERSION=1;
export function validateDeploymentContract(value){
  const actual=Number.isSafeInteger(value?.version)?value.version:'missing or invalid';
  if(value?.kind!=='mote.deployment'||actual!==DEPLOYMENT_CONTRACT_VERSION||typeof value?.serverVersion!=='string'||!value.serverVersion)
    throw Error(`Deployment contract could not be verified: expected mote.deployment version ${DEPLOYMENT_CONTRACT_VERSION}, received ${actual}; use matching deployment tools and release/image. No service or data was changed`);
  return value;
}
export async function writeDeploymentContract(path){
  const server=JSON.parse(await readFile(new URL('../apps/server/package.json',import.meta.url),'utf8'));
  const value={kind:'mote.deployment',version:DEPLOYMENT_CONTRACT_VERSION,serverVersion:server.version};
  await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n');return value;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]!=='write'||!process.argv[3])throw Error('Usage: deployment-contract.mjs write OUTPUT');
  await writeDeploymentContract(resolve(process.argv[3]));
}
