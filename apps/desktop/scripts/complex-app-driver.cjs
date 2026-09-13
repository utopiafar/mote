const { spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { defaultConfig, validateServerUrl, isLoopback } = require('../dist/config');
const directory = resolve(process.env.MOTE_COMPLEX_OUTPUT || '../../.mote/live-validation/desktop');
const connectionPath = resolve(process.env.MOTE_COMPLEX_CONNECTION || '../../.mote/live-validation/connection.json');
const connection = JSON.parse(readFileSync(connectionPath, 'utf8'));
if (!isLoopback(new URL(validateServerUrl(connection.url)).hostname)) throw new Error('This fixture runner accepts a local test central node only');
mkdirSync(directory, { recursive: true, mode: 0o700 });
let statePath;
let phases = ['draft','offline','bad-ack','recovery','central'];
if (process.env.MOTE_COMPLEX_RESUME) {
  statePath = resolve(process.env.MOTE_COMPLEX_RESUME);
  const prior = JSON.parse(readFileSync(statePath,'utf8'));
  const finished = prior.phases?.length ?? 0;
  phases = phases.slice(finished);
} else {
  const profile = join(directory, 'profile-' + randomUUID()); mkdirSync(profile, { mode: 0o700 });
  const config = { ...defaultConfig(), serverUrl: connection.url, deviceName: 'desktop-complex-' + randomUUID().slice(0,8), ocrEnabled: false };
  writeFileSync(join(profile,'config.json'),JSON.stringify({version:1,config}),{mode:0o600});
  statePath = join(directory, 'run-' + randomUUID() + '.json');
  writeFileSync(statePath, JSON.stringify({ profile, marker: config.deviceName, deviceId:config.deviceId, startedAt: new Date().toISOString(), connectionPath }), {mode:0o600});
}
for (const phase of phases) {
  const result = spawnSync(require('electron'), ['scripts/complex-app-phase.cjs'], { cwd: resolve(__dirname,'..'), env: {...process.env,MOTE_COMPLEX_STATE:statePath,MOTE_COMPLEX_PHASE:phase}, encoding:'utf8', timeout:190000 });
  if (result.status !== 0) { process.stderr.write((result.stderr || 'Complex app phase failed') + '\n'); process.exit(1); }
  process.stdout.write(result.stdout);
}
const state=JSON.parse(readFileSync(statePath,'utf8'));
process.stdout.write(JSON.stringify({ok:true,fixtureOnly:true,marker:state.marker,deviceId:state.deviceId,ids:state.ids,phases:state.phases,statePath})+'\n');
