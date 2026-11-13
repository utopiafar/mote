// Deployment liveness only: deliberately idle, or its own listener is open.
// This does NOT establish loaded-model readiness; Central validates /health
// against the actual OCR / FunASR / local-image domain identity separately.
import { connect } from 'node:net';
import { readConfigDocument } from '../packages/shared/src/config-file.ts';

const role = process.argv[2];
if (!['ocr', 'asr', 'local-image'].includes(role)) {
  console.error('Usage: node scripts/media-worker-health.mjs <ocr|asr|local-image>');
  process.exit(2);
}
if(role==='local-image'&&(process.platform!=='darwin'||process.arch!=='arm64')){
  console.error('media.runtime.unsupported_platform');process.exit(1);
}
const file = process.env.MOTE_CONFIG_FILE;
if (!file) {
  console.error('MOTE_CONFIG_FILE is required');
  process.exit(1);
}
let media;
try {
  media = readConfigDocument(file).document.media ?? {};
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration could not be read');
  process.exit(1);
}
// The entry idles whenever the deployment has no media configuration; that is
// the intended steady state and must not be reported as a failure.
if (!media.modelDirectory || !media.workerToken) process.exit(0);
const port = media[role === 'ocr' ? 'ocrPort' : role==='asr'?'asrPort':'localImagePort'];
// A missing role port means this deployment does not use that worker.
if (port === undefined || port === null || port === '') process.exit(0);
const socket = connect({ host: '127.0.0.1', port });
const finish = healthy => {
  socket.destroy();
  process.exit(healthy ? 0 : 1);
};
socket.setTimeout(2000, () => finish(false));
socket.once('connect', () => finish(true));
socket.once('error', () => finish(false));
