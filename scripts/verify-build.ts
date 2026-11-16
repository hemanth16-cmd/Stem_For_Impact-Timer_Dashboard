/** Confirms dist/ was built from the current sources (run by `npm run prepare-event`). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSourceHash, readBuildInfo } from '../server/sourceHash';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const info = readBuildInfo(path.join(ROOT, 'dist'));
const hash = computeSourceHash(ROOT);
if (!info) { console.error('✗ dist/build-info.json missing — build failed?'); process.exit(1); }
if (info.sourceHash !== hash) { console.error('✗ dist/ does not match the current source files. Re-run the preparation.'); process.exit(1); }
console.log(`\n✓ Event build ${info.build} prepared ${info.builtAt} and verified against the sources.\n`);
