import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '@mote/shared/environment';

export default defineConfig(({ command }) => {
  if (command !== 'serve') return { plugins: [react()] };
  if (!process.env.MOTE_ENV_FILE || !['dev', 'test'].includes(process.env.MOTE_PROFILE ?? '')) throw new Error('Start the development UI through npm run dev or mote exec with an explicit dev/test profile');
  const { env } = loadEnvironment(fileURLToPath(new URL('../../', import.meta.url)));
  const port = Number(env.MOTE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 47832) throw new Error('Development proxy requires its isolated dev/test central port');
  // Only the server-side proxy sees this setting; no MOTE token or model key is injected into the browser bundle.
  return { plugins: [react()], server: { port: env.MOTE_PROFILE === 'test' ? 5174 : 5173, strictPort: true, proxy: { '/api': `http://127.0.0.1:${port}` } } };
});
