// Dev server for long automated browser runs (tools/w1-browser.mjs, playtests): no file watching and no HMR, so edits
// made while a run is in progress (other agents, editors) never reload the page mid-measurement. Restart the server to
// pick up changes:  npx vite --config tools/vite.nowatch.config.mjs --host 127.0.0.1 --port 5311 --strictPort
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.ts';

export default mergeConfig(base, defineConfig({
  root: new URL('..', import.meta.url).pathname,
  server: { hmr: false, watch: { ignored: ['**/*'] } },
}));
