import { defineConfig, type Plugin } from "vite";
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import react from "@vitejs/plugin-react";
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '@mote/shared/environment';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;
const compressible = /\.(js|css|html|svg|json)$/;
const precompress = (): Plugin => ({name:'mote-precompress', apply:'build', writeBundle(options) {
  const root = options.dir ?? fileURLToPath(new URL('./dist', import.meta.url));
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!compressible.test(entry.name)) continue;
      const source = readFileSync(path);
      if (source.length < 1024) continue;
      writeFileSync(path + '.br', brotliCompressSync(source, {params: {[constants.BROTLI_PARAM_QUALITY]: 11}}));
      writeFileSync(path + '.gz', gzipSync(source, {level: 9}));
    }
  };
  walk(root);
}});
const plugins = () => [react(), {name:'mote-build-identity', generateBundle(this: {emitFile: (file: {type:'asset';fileName:string;source:string})=>void}) {this.emitFile({type:'asset',fileName:'build-info.json',source:JSON.stringify({version})});}}, precompress()];
export default defineConfig(({ command }) => {
  if (command !== 'serve') return { plugins: plugins(), define: {__MOTE_WEB_VERSION__: JSON.stringify(version)} };
  if (!process.env.MOTE_CONFIG_FILE) throw new Error('Start the development UI through npm run dev or mote exec with an explicit dev/test profile');
  const { env } = loadEnvironment(fileURLToPath(new URL('../../', import.meta.url)));
  if (!['dev', 'test'].includes(env.MOTE_PROFILE ?? '')) throw new Error('Development UI requires an isolated dev/test YAML profile');
  const port = Number(env.MOTE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 47832) throw new Error('Development proxy requires its isolated dev/test central port');
  // Only the server-side proxy sees this setting; no MOTE token or model key is injected into the browser bundle.
  return { plugins: plugins(), define: {__MOTE_WEB_VERSION__: JSON.stringify(version)}, server: { port: env.MOTE_PROFILE === 'test' ? 5174 : 5173, strictPort: true, proxy: { '/api': `http://127.0.0.1:${port}` } } };
});
