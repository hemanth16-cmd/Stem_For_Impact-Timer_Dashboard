/**
 * Server regression tests. Every scenario runs against its OWN throwaway server process with a
 * temporary DATA_DIR and random port — it never touches data/ or a running event server.
 * Run: npm run test:server
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { AppState, ServerInfo } from '../src/shared/model';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN = '739154';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

// ---------------------------------------------------------------- server process
interface Srv { port: number; dir: string; proc: ChildProcess; log: () => string; stop: (sig?: NodeJS.Signals) => Promise<number | null>; alive: () => boolean }
let nextPort = 18500 + Math.floor(Math.random() * 400);
async function startServer(dir?: string, env: Record<string, string> = {}): Promise<Srv> {
  const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sfi-test-'));
  const port = nextPort++;
  let out = '';
  // Single process (node --import tsx): a SIGKILL really kills the server.
  const proc = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, DATA_DIR: d, PORT: String(port), ADMIN_PIN: PIN, SFI_DEV: '1', HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited: number | null | undefined;
  const exitP = new Promise<number | null>((r) => proc.on('exit', (c) => { exited = c; r(c); }));
  proc.stdout!.on('data', (b) => (out += b));
  proc.stderr!.on('data', (b) => (out += b));
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch { /* not yet */ }
    if (exited !== undefined) break;
    await sleep(100);
  }
  return {
    port, dir: d, proc, log: () => out, alive: () => exited === undefined,
    stop: async (sig = 'SIGTERM') => { if (exited === undefined) proc.kill(sig); return exitP; },
  };
}

// ---------------------------------------------------------------- client
class Client {
  ws: WebSocket;
  msgs: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  closed: number | null = null;
  rejected: number | null = null;
  state: AppState | null = null;
  info: ServerInfo | null = null;
  opened: Promise<boolean>;
  private n = 0;
  constructor(port: number, opts: { origin?: string; host?: string; role?: string } = {}) {
    const headers: Record<string, string> = {};
    if (opts.host) headers.Host = opts.host;
    this.ws = new WebSocket(`ws://localhost:${port}/ws`, { origin: opts.origin, headers });
    this.opened = new Promise((res) => {
      this.ws.on('open', () => { this.ws.send(JSON.stringify({ type: 'hello', role: opts.role ?? 'display' })); res(true); });
      this.ws.on('unexpected-response', (_req, r) => { this.rejected = r.statusCode ?? 0; res(false); });
      this.ws.on('error', () => res(false));
    });
    this.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      this.msgs.push(m);
      if (m.type === 'state') this.state = m.state;
      if (m.type === 'info') this.info = m.info;
    });
    this.ws.on('close', (c) => { this.closed = c; });
  }
  raw(s: string | Buffer) { this.ws.send(s); }
  sendJ(o: unknown) { this.ws.send(JSON.stringify(o)); }
  async waitFor<T>(pred: (m: any) => T, ms = 3000): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const t0 = Date.now();
    let seen = 0;
    while (Date.now() - t0 < ms) {
      for (; seen < this.msgs.length; seen++) if (pred(this.msgs[seen])) return this.msgs[seen];
      await sleep(15);
    }
    return null;
  }
  async auth(pin = PIN) {
    const from = this.msgs.length;
    this.sendJ({ type: 'auth', pin });
    const m = await this.waitFor((x) => x.type === 'auth' && this.msgs.indexOf(x) >= from);
    return m;
  }
  async cmd(cmd: unknown, extra: Record<string, unknown> = {}) {
    const reqId = `q${++this.n}-${Math.random().toString(36).slice(2, 7)}`;
    this.sendJ({ type: 'cmd', reqId, cmd, ...extra });
    const r = await this.waitFor((m) => m.type === 'result' && m.reqId === reqId, 4000);
    await sleep(40);
    return r ?? { ok: false, error: 'timeout' };
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
async function admin(port: number) {
  const c = new Client(port, { role: 'admin' });
  await c.opened;
  await c.auth();
  return c;
}

// ---------------------------------------------------------------- scenarios
async function malformed() {
  console.log('\nMalformed / hostile input');
  const s = await startServer();
  const a = await admin(s.port);
  await a.cmd({ type: 'timer.start' });
  const before = JSON.stringify(a.state);
  const bad = new Client(s.port);
  await bad.opened;
  const payloads = ['null', '[]', '[1,2]', '42', '"text"', 'true', 'false', '{not json', '', '{}', '{"type":null}', '{"type":"cmd"}',
    '{"type":"cmd","reqId":"r1"}', '{"type":"cmd","reqId":"r1","cmd":null}', '{"type":"cmd","reqId":"r1","cmd":[]}', '{"type":"auth"}',
    '{"type":"auth","pin":{"x":1}}', '{"type":"ping","clientSent":"x"}', '{"type":"hello","role":"superuser"}', '{"type":"ack","rev":"x"}',
    '{"type":"__proto__"}', '{"type":"cmd","reqId":"r2","cmd":{"type":"timer.reset"}}'];
  for (const p of payloads) bad.raw(p);
  await sleep(400);
  const errors = bad.msgs.filter((m) => m.type === 'error' || (m.type === 'result' && !m.ok)).length;
  check(`server survives ${payloads.length} malformed/unauthorised messages (null, arrays, primitives, bad JSON, missing fields)`, s.alive());
  // 21 of the payloads are malformed; the 21st exceeds the abuse limit (20) and the server closes that socket.
  check('malformed messages get error replies until the abuse limit, then that socket is closed (1008)', errors === 21 && bad.closed === 1008, `${errors} replies, close ${bad.closed}`);
  const single = new Client(s.port);
  await single.opened;
  single.raw('null');
  check('a single `null` message gets a clean error (the reported crash)', !!(await single.waitFor((m) => m.type === 'error')) && s.alive());
  single.close();
  check('valid admin connection unaffected; state unchanged', a.closed === null && JSON.stringify(a.state) === before);
  // Invalid commands from an AUTHENTICATED admin
  const inv = [{ type: 'timer.schedule' }, { type: 'timer.setRemaining', ms: 'soon' }, { type: 'ann.update', id: 'x' }, { type: 'settings.update', patch: { sound: 'loud' } }, { type: 'nope' }, null];
  let rejected = 0;
  for (const c of inv) if (!(await a.cmd(c)).ok) rejected++;
  check('invalid commands from an authenticated admin are rejected', rejected === inv.length && s.alive(), `${rejected}/${inv.length}`);
  const big = new Client(s.port);
  await big.opened;
  big.raw('x'.repeat(40_000));
  await sleep(300);
  check('oversized message closes only that socket (1009)', big.closed === 1009 && s.alive() && a.closed === null);
  const bin = new Client(s.port);
  await bin.opened;
  bin.raw(Buffer.from([0, 1, 2, 3]));
  await sleep(200);
  check('binary frame rejected without crash', s.alive() && !!bin.msgs.find((m) => m.type === 'error'));
  const flood = new Client(s.port);
  await flood.opened;
  for (let i = 0; i < 200; i++) flood.sendJ({ type: 'ping', clientSent: i });
  await sleep(500);
  check('message flood → that connection closed (1008), others fine', flood.closed === 1008 && s.alive() && a.closed === null);
  const r = await a.cmd({ type: 'ann.add', text: 'still working' });
  check('admin can still operate after all of the above', r.ok && r.saved === true);
  check('server log shows no crash / stack trace', !/TypeError|Cannot read prop/.test(s.log()));
  [a, bad, big, bin, flood].forEach((c) => c.close());
  await s.stop();
}

async function security() {
  console.log('\nOrigin, connection limits, PIN rate limiting, PIN exposure');
  const s = await startServer(undefined, { MAX_CLIENTS_PER_IP: '6' });
  const evil = new Client(s.port, { origin: 'http://evil.example' });
  check('foreign Origin rejected (403)', !(await evil.opened) && evil.rejected === 403);
  const rebind = new Client(s.port, { origin: `http://attacker.example:${s.port}`, host: `attacker.example:${s.port}` });
  check('DNS-rebinding Host rejected (403)', !(await rebind.opened) && rebind.rejected === 403);
  const same = new Client(s.port, { origin: `http://localhost:${s.port}` });
  check('same-origin browser connection accepted', await same.opened);
  const many: Client[] = [];
  for (let i = 0; i < 6; i++) { const c = new Client(s.port); many.push(c); await c.opened; }
  check('per-address connection limit enforced (429)', many.filter((c) => c.rejected === 429).length >= 1);
  many.forEach((c) => c.close()); same.close();
  await sleep(300);

  // 5 wrong PINs spread over 5 separate connections, then the RIGHT pin on a 6th → still locked.
  for (let i = 0; i < 5; i++) { const c = new Client(s.port); await c.opened; await c.auth('000000'); c.close(); }
  await sleep(200);
  const c6 = new Client(s.port);
  await c6.opened;
  const r = await c6.auth(PIN);
  check('PIN attempts limited across connections (correct PIN refused while locked)', r && r.ok === false && r.retryAfterMs > 0, r?.error);
  c6.close();
  const pages = await Promise.all(['/', '/admin', '/api/state', '/api/health'].map((p) => fetch(`http://localhost:${s.port}${p}`).then((x) => x.text())));
  let bundle = '';
  const assets = path.join(ROOT, 'dist', 'assets');
  if (fs.existsSync(assets)) for (const f of fs.readdirSync(assets)) if (f.endsWith('.js')) bundle += fs.readFileSync(path.join(assets, f), 'utf8');
  check('admin PIN not present in any public response or frontend bundle', pages.every((p) => !p.includes(PIN)) && !bundle.includes(PIN));
  await s.stop();
}

async function commands() {
  console.log('\nRetries, acknowledgement loss, conflicts, displays');
  const s = await startServer();
  const a = await admin(s.port);
  await a.cmd({ type: 'timer.start' });
  await a.cmd({ type: 'timer.setRemaining', ms: 3_600_000 });
  const rem = () => (a.state!.timer.endsAt ?? 0) - Date.now();
  const r0 = rem();
  const r1 = await a.cmd({ type: 'timer.adjust', deltaMs: 300_000 }, { cmdId: 'retry-test-1' });
  const r2 = await a.cmd({ type: 'timer.adjust', deltaMs: 300_000 }, { cmdId: 'retry-test-1' });
  check('retried command (same cmdId) is applied once', r1.ok && r2.ok && r2.duplicate === true && Math.abs(rem() - r0 - 300_000) < 1000, `${Math.round((rem() - r0) / 1000)} s added`);

  // Acknowledgement lost: send, drop the socket before the reply is read, reconnect, resend same cmdId.
  const lost = new Client(s.port, { role: 'admin' });
  await lost.opened; await lost.auth();
  const revBefore = a.state!.rev;
  lost.sendJ({ type: 'cmd', reqId: 'lost-1', cmdId: 'lost-cmd-1', cmd: { type: 'ann.add', text: 'ack-loss test' } });
  lost.ws.terminate();
  await sleep(300);
  const again = await admin(s.port);
  const rr = await again.cmd({ type: 'ann.add', text: 'ack-loss test' }, { cmdId: 'lost-cmd-1' });
  const copies = again.state!.announcements.filter((x) => x.text === 'ack-loss test').length;
  check('after acknowledgement loss, resend reports the original outcome without duplicating', rr.ok && rr.duplicate === true && copies === 1 && again.state!.rev === revBefore + 1);

  const staleRev = a.state!.timer.rev;
  await a.cmd({ type: 'timer.pause' }, { baseTimerRev: staleRev });
  const conflict = await again.cmd({ type: 'timer.reset' }, { baseTimerRev: staleRev });
  check('conflicting organizer action (stale timer rev) rejected', !conflict.ok && /another organizer/.test(conflict.error) && a.state!.timer.status === 'paused');
  const annWhilePaused = await again.cmd({ type: 'ann.add', text: 'x' }, { baseTimerRev: staleRev });
  check('announcement edits never conflict with / change the timer', annWhilePaused.ok && JSON.stringify(again.state!.timer) === JSON.stringify(a.state!.timer));

  // Display acknowledgement + sound test relay
  const disp = new Client(s.port);
  await disp.opened;
  await disp.waitFor((m) => m.type === 'state');
  disp.sendJ({ type: 'ack', rev: disp.state!.rev, audio: 'blocked', visible: true, fullscreen: true, viewport: '1920×1080' });
  await sleep(500);
  const d = a.info?.displays.find((x) => x.ackRev === disp.state!.rev);
  check('admin sees which revision a display confirmed rendering', !!d && d.audio === 'blocked' && d.fullscreen === true);
  await a.cmd({ type: 'ann.add', text: 'new rev' });
  await sleep(400);
  const d2 = a.info?.displays.find((x) => x.role === 'display');
  check('server acceptance is not reported as display delivery (ackRev lags until the display confirms)', !!d2 && (d2.ackRev ?? 0) < a.state!.rev);
  const t = await a.cmd({ type: 'display.testSound' });
  const got = await disp.waitFor((m) => m.type === 'testSound');
  check('"test sound on projector" is relayed to displays', t.ok && !!got);

  // Simulations vs the real event
  await a.cmd({ type: 'timer.reset' });
  await a.cmd({ type: 'settings.update', patch: { rehearsal: true } });
  const sim = await a.cmd({ type: 'sim.start', kind: 'final', fromMs: 65_000 });
  await a.cmd({ type: 'timer.start' });
  check('starting the real countdown removes an active rehearsal at once', sim.ok && disp.state!.simulation === null && disp.state!.timer.status === 'running');
  const simLive = await a.cmd({ type: 'sim.start', kind: 'milestone', milestoneMs: 3_600_000 });
  check('projector rehearsal refused while the event is live', !simLive.ok);
  await a.cmd({ type: 'timer.setRemaining', ms: 1200 });
  await sleep(1700);
  const fin = disp.state!.timer;
  check('real completion recorded with completedAt and survives', fin.status === 'completed' && !!fin.completedAt && Math.abs(fin.completedAt - Date.now()) < 2500);
  const simAfter = await a.cmd({ type: 'sim.start', kind: 'final' });
  check('rehearsal refused after real completion (finish stays on screen)', !simAfter.ok && disp.state!.simulation === null);
  [a, again, disp].forEach((c) => c.close());
  await s.stop();
}

async function persistence() {
  console.log('\nPersistence & recovery');
  // --- restart during a running countdown
  const s1 = await startServer();
  const a1 = await admin(s1.port);
  await a1.cmd({ type: 'timer.start' });
  await a1.cmd({ type: 'ann.add', text: 'persist me' });
  const endsAt = a1.state!.timer.endsAt;
  const rev = a1.state!.rev;
  a1.close();
  await s1.stop('SIGTERM');
  check('shutdown leaves no temp files and a valid state file', !fs.readdirSync(s1.dir).some((f) => f.endsWith('.tmp')) && JSON.parse(fs.readFileSync(path.join(s1.dir, 'state.json'), 'utf8')).rev === rev);
  const s2 = await startServer(s1.dir);
  const c2 = new Client(s2.port);
  await c2.opened;
  await c2.waitFor((m) => m.type === 'state');
  check('server restart during running countdown keeps the exact deadline', c2.state!.timer.status === 'running' && c2.state!.timer.endsAt === endsAt);
  check('…and announcements', c2.state!.announcements.some((x) => x.text === 'persist me'));
  c2.close();
  await s2.stop();

  // --- damaged main file, valid .bak → recovered, damaged file preserved
  const garbage = '{"rev": 9, "timer": {"status": "runn';
  fs.writeFileSync(path.join(s1.dir, 'state.json'), garbage);
  const s3 = await startServer(s1.dir);
  const a3 = await admin(s3.port);
  await sleep(300);
  const preserved = fs.readdirSync(s1.dir).filter((f) => f.startsWith('state.json.damaged-'));
  check('damaged state.json is preserved, not discarded', preserved.length === 1 && fs.readFileSync(path.join(s1.dir, preserved[0]), 'utf8') === garbage);
  check('valid backup used: deadline intact, source reported to organizers', a3.state!.timer.endsAt === endsAt && a3.info?.health.source === 'backup');
  a3.close();
  await s3.stop();

  // --- parseable but INVALID state, no backups → recovery mode (nothing overwritten)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfi-test-'));
  const invalid = JSON.stringify({ rev: 40, timer: { status: 'running', durationMs: 86_400_000, remainingMs: 1000, endsAt: null, sessionId: 'x' }, announcements: [], settings: {} });
  fs.writeFileSync(path.join(dir, 'state.json'), invalid);
  const s4 = await startServer(dir);
  const st = await fetch(`http://localhost:${s4.port}/api/state`);
  check('invalid state is NOT treated as a first run (recovery mode, 503)', st.status === 503 && s4.alive());
  const disp = new Client(s4.port);
  await disp.opened;
  const rec = await disp.waitFor((m) => m.type === 'recovery');
  check('displays are told the server is recovering', !!rec);
  const a4 = await admin(s4.port);
  const blocked = await a4.cmd({ type: 'timer.start' });
  check('commands refused until recovery is resolved', !blocked.ok);
  check('damaged file left untouched on disk', fs.readFileSync(path.join(dir, 'state.json'), 'utf8') === invalid);
  // A display offers its cached copy; the organizer adopts it.
  const cached = { schema: 2, rev: 55, timer: { status: 'running', durationMs: 86_400_000, remainingMs: 86_400_000, endsAt: Date.now() + 5 * 3_600_000, startedAt: Date.now() - 19 * 3_600_000, scheduledStartAt: null, completedAt: null, sessionId: 'abc', rev: 7 }, announcements: [{ id: 'a1', text: 'Cached', active: true, priority: false, createdAt: 1, updatedAt: 1 }], settings: { tickerMode: 'scroll', effects: true, sound: true, milestones: true, showProgress: true, tagline: 'x', performance: false, scanlines: true, reducedGlow: false, rehearsal: false } };
  disp.sendJ({ type: 'cacheOffer', state: cached });
  disp.sendJ({ type: 'cacheOffer', state: { evil: true } });
  await sleep(500);
  check('organizer sees the validated cache offer (invalid offers ignored)', a4.info?.recovery?.offers.length === 1 && a4.info.recovery.offers[0].rev === 55);
  const freshBad = await (async () => { a4.sendJ({ type: 'recovery.fresh', reqId: 'f1', confirm: 'yes' }); return a4.waitFor((m) => m.type === 'result' && m.reqId === 'f1'); })();
  check('"start fresh" requires the typed confirmation', freshBad && !freshBad.ok);
  a4.sendJ({ type: 'recovery.adopt', reqId: 'ad1', rev: 55 });
  const adopted = await a4.waitFor((m) => m.type === 'result' && m.reqId === 'ad1');
  await sleep(300);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  check('adopting the display copy restores the live deadline and saves it', adopted?.ok && disp.state?.timer.endsAt === cached.timer.endsAt && disk.timer.endsAt === cached.timer.endsAt);
  check('the damaged original was preserved before being replaced', fs.readdirSync(dir).some((f) => f.startsWith('state.json.damaged-')));
  [disp, a4].forEach((c) => c.close());
  await s4.stop();

  // --- unwritable state → applied but NOT saved, visible; recovers when writable again
  const s5 = await startServer();
  const a5 = await admin(s5.port);
  const main = path.join(s5.dir, 'state.json');
  fs.rmSync(main);
  fs.mkdirSync(main); // a directory where the file should be: every save now fails (works even as root)
  fs.writeFileSync(path.join(main, 'blocker'), 'x');
  const r = await a5.cmd({ type: 'ann.add', text: 'unsaved' });
  await sleep(400);
  check('command reports "applied" but "NOT saved" when the disk write fails', r.ok === true && r.applied === true && r.saved === false);
  check('organizers see persistence health = failing with the error', a5.info?.health.status === 'failing' && !!a5.info.health.lastError);
  fs.rmSync(main, { recursive: true });
  await sleep(5600);
  check('saving resumes automatically once the disk is writable', a5.info?.health.status === 'ok' && a5.info.health.savedRev === a5.state!.rev);
  a5.close();
  await s5.stop();

  // --- first run (no files) is still a clean fresh start
  const s6 = await startServer();
  const a6 = await admin(s6.port);
  check('true first run starts fresh (timer ready)', a6.state?.timer.status === 'ready' && a6.info?.health.source === 'fresh');
  a6.close();
  await s6.stop();
}

async function reconnect() {
  console.log('\nNetwork loss & reconnection (server side)');
  const s = await startServer();
  const a = await admin(s.port);
  await a.cmd({ type: 'timer.start' });
  const endsAt = a.state!.timer.endsAt;
  await s.stop('SIGKILL'); // hard crash: no shutdown save (state was saved synchronously on the command)
  const s2 = await startServer(s.dir);
  const b = new Client(s2.port);
  await b.opened;
  await b.waitFor((m) => m.type === 'state');
  check('hard kill (no graceful shutdown) loses nothing: every command was saved before it was acknowledged', b.state?.timer.endsAt === endsAt);
  const unauth = await b.cmd({ type: 'timer.pause' });
  check('a reconnecting client is NOT authorised until it signs in again', !unauth.ok);
  b.close();
  await s2.stop();
}

(async () => {
  const t0 = Date.now();
  for (const f of [malformed, security, commands, persistence, reconnect]) {
    try { await f(); } catch (e) { fail++; console.log('  FAIL  scenario crashed:', e); }
  }
  console.log(`\n${pass} passed, ${fail} failed (${Math.round((Date.now() - t0) / 1000)} s).`);
  process.exit(fail ? 1 : 0);
})();
