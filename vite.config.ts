import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { computeSourceHash } from './server/sourceHash';

const SERVER = `http://localhost:${process.env.PORT ?? 8080}`;
const ROOT = __dirname;
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
const sourceHash = computeSourceHash(ROOT);
const BUILD_ID = `${version}-${sourceHash.slice(0, 8)}`;

/** Writes dist/build-info.json so the event server can verify the build matches the sources. */
function buildInfo(): Plugin {
  return {
    name: 'sfi-build-info',
    apply: 'build',
    writeBundle(opts) {
      const out = opts.dir ?? path.join(ROOT, 'dist');
      fs.writeFileSync(path.join(out, 'build-info.json'),
        JSON.stringify({ build: BUILD_ID, sourceHash, version, builtAt: new Date().toISOString() }, null, 2));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), buildInfo()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: { emptyOutDir: true },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/ws': { target: SERVER.replace('http', 'ws'), ws: true },
    },
  },
});
