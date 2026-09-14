import {writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.env.RUNNER_TEMP;if(!root||!process.env.GITHUB_ENV)throw Error('Run in a GitHub release job');
const value=process.env.MOTE_ANDROID_KEYSTORE_BASE64;if(!value)throw Error('Android signing identity secret is required');
const directory=join(root,'mote-release-signing');mkdirSync(directory,{recursive:true,mode:0o700});
const path=join(directory,'android-signing.p12');writeFileSync(path,Buffer.from(value,'base64'),{mode:0o600});
appendFileSync(process.env.GITHUB_ENV,`MOTE_ANDROID_KEYSTORE_PATH=${path}\n`);
console.log('Private Android signing material prepared for this job.');
