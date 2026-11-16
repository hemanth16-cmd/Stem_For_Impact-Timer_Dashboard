/**
 * Durable state storage.
 *
 *  data/state.json            current state (always replaced atomically: write temp → fsync → rename)
 *  data/state.json.bak        previous good generation (copied before every replace)
 *  data/backups/state-*.json  rolling snapshots (every 10 min, newest 30 kept)
 *  data/state.json.damaged-*  preserved copies of files that could not be read/validated
 *
 * A MISSING state file (true first run) and a DAMAGED one are handled differently: damaged files
 * are preserved, backups are validated and used if possible, and if nothing valid exists the
 * caller gets `recovery` — it must NOT silently start a fresh event over the evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { durableState, validateState, type AppState } from '../src/shared/model';

export interface Paths { dir: string; state: string; bak: string; snapshots: string }
export const pathsFor = (dir: string): Paths => ({
  dir,
  state: path.join(dir, 'state.json'),
  bak: path.join(dir, 'state.json.bak'),
  snapshots: path.join(dir, 'backups'),
});

export type LoadResult =
  | { kind: 'fresh'; notes: string[] }
  | { kind: 'restored'; state: AppState; notes: string[] }
  | { kind: 'backup'; state: AppState; from: string; notes: string[]; preserved: string[] }
  | { kind: 'recovery'; reason: string; notes: string[]; preserved: string[] };

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

type ReadOutcome = { ok: true; state: AppState; migrated: boolean } | { ok: false; missing: boolean; error: string };

function readCandidate(file: string): ReadOutcome {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, missing: code === 'ENOENT', error: `${path.basename(file)}: cannot read (${code ?? String(e)})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, missing: false, error: `${path.basename(file)}: not valid JSON (${(e as Error).message})` };
  }
  const v = validateState(json);
  if (!v.ok) return { ok: false, missing: false, error: `${path.basename(file)}: ${v.errors.slice(0, 4).join(' ')}` };
  return { ok: true, state: v.state, migrated: v.migrated };
}

function listSnapshots(p: Paths): string[] {
  try {
    return fs.readdirSync(p.snapshots).filter((f) => /^state-.*\.json$/.test(f)).sort().reverse().map((f) => path.join(p.snapshots, f));
  } catch {
    return [];
  }
}

function preserve(file: string): string | null {
  const dest = `${file}.damaged-${stamp()}`;
  try {
    fs.copyFileSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

export function loadState(p: Paths): LoadResult {
  fs.mkdirSync(p.dir, { recursive: true });
  const main = readCandidate(p.state);
  if (main.ok) return { kind: 'restored', state: main.state, notes: main.migrated ? ['Saved state upgraded from an older format.'] : [] };

  const candidates = [p.bak, ...listSnapshots(p)];
  const anyBackup = candidates.some((f) => fs.existsSync(f));
  if (main.missing && !anyBackup) return { kind: 'fresh', notes: [] };

  const notes: string[] = [main.missing ? 'state.json is missing although backups exist.' : `state.json is damaged: ${main.error}`];
  const preserved: string[] = [];
  if (!main.missing) {
    const kept = preserve(p.state);
    if (kept) preserved.push(kept);
    else notes.push('Could not copy the damaged state.json; it has been left untouched.');
  }
  for (const f of candidates) {
    const c = readCandidate(f);
    if (c.ok) {
      notes.push(`Recovered from ${path.relative(p.dir, f)} (revision ${c.state.rev}).`);
      return { kind: 'backup', state: c.state, from: f, notes, preserved };
    }
    if (!c.missing) notes.push(`Backup rejected — ${c.error}`);
  }
  return {
    kind: 'recovery',
    reason: main.missing ? 'state.json is missing and no backup is valid.' : 'state.json is damaged and no valid backup was found.',
    notes,
    preserved,
  };
}

// ---- atomic save ----
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let seq = 0;

/** Write → fsync → (keep previous as .bak) → rename. Throws on failure; the old file stays intact. */
export function saveStateAtomic(p: Paths, state: AppState) {
  const data = JSON.stringify({ ...durableState(state), savedAt: new Date().toISOString() }, null, 2);
  writeAtomic(p.state, data, p.bak);
}

export function writeAtomic(file: string, data: string, keepPreviousAs?: string) {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (keepPreviousAs && fs.existsSync(file)) {
      // Only keep a previous generation that is itself valid.
      if (readCandidate(file).ok) fs.copyFileSync(file, keepPreviousAs);
    }
    // Windows: antivirus/indexers can briefly lock the target; retry a few times.
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
        sleepSync(40 * (i + 1));
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/** Rolling snapshot; keeps the newest `keep`. Errors are returned, not thrown. */
export function snapshot(p: Paths, state: AppState, keep = 30): string | null {
  try {
    fs.mkdirSync(p.snapshots, { recursive: true });
    writeAtomic(path.join(p.snapshots, `state-${stamp()}.json`), JSON.stringify(durableState(state), null, 2));
    for (const old of listSnapshots(p).slice(keep)) fs.unlinkSync(old);
    return null;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}
