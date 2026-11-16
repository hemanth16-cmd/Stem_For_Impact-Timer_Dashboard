/**
 * Content hash of everything that determines the built frontend + server behaviour.
 * The build writes it into dist/build-info.json; the event server refuses to start if the
 * prepared frontend was built from different sources (see PREPARE-EVENT.bat).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const INCLUDE_DIRS = ['src', 'server', 'public'];
const INCLUDE_FILES = ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.app.json', 'tsconfig.server.json'];

function walk(dir: string, out: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

export function computeSourceHash(root: string): string {
  const files: string[] = [];
  for (const d of INCLUDE_DIRS) walk(path.join(root, d), files);
  for (const f of INCLUDE_FILES) if (fs.existsSync(path.join(root, f))) files.push(path.join(root, f));
  const h = crypto.createHash('sha256');
  for (const f of files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort()) {
    h.update(f + '\0');
    // Normalise line endings so a Windows checkout hashes the same as the build machine.
    const buf = fs.readFileSync(path.join(root, f));
    const isText = /\.(ts|tsx|css|html|json|md|txt|svg)$/i.test(f);
    h.update(isText ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n')) : buf);
    h.update('\0');
  }
  return h.digest('hex');
}

export interface BuildInfo { build: string; sourceHash: string; builtAt: string; version: string }

export function readBuildInfo(distDir: string): BuildInfo | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(distDir, 'build-info.json'), 'utf8'));
    return typeof v?.sourceHash === 'string' && typeof v?.build === 'string' ? v : null;
  } catch {
    return null;
  }
}
