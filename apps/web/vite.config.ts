import { defineConfig } from "vite";
import { readFileSync } from 'node:fs';
import react from "@vitejs/plugin-react";
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '@mote/shared/environment';

const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
const plugins = () => [react(), {name:'mote-build-identity', generateBundle(this: {emitFile: (file: {type:'asset';fileName:string;source:string})=>void}) {this.emitFile({type:'asset',fileName:'build-info.json',source:JSON.stringify({version})});}}];
export default defineConfig(({ command }) => {
  if (command !== 'serve') return { plugins: plugins(), define: {__MOTE_WEB_VERSION__: JSON.stringify(version)} };
  if (!process.env.MOTE_ENV_FILE || !['dev', 'test'].includes(process.env.MOTE_PROFILE ?? '')) throw new Error('Start the development UI through npm run dev or mote exec with an explicit dev/test profile');
  const { env } = loadEnvironment(fileURLToPath(new URL('../../', import.meta.url)));
  const port = Number(env.MOTE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 47832) throw new Error('Development proxy requires its isolated dev/test central port');
  // Only the server-side proxy sees this setting; no MOTE token or model key is injected into the browser bundle.
  return { plugins: plugins(), define: {__MOTE_WEB_VERSION__: JSON.stringify(version)}, server: { port: env.MOTE_PROFILE === 'test' ? 5174 : 5173, strictPort: true, proxy: { '/api': `http://127.0.0.1:${port}` } } };
});
