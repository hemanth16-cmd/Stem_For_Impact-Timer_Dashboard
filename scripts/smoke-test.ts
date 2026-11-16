/**
 * End-to-end protocol test against a RUNNING **test** server (never the event server):
 *   set DATA_DIR=C:\temp\sfi-test& set PORT=8099& npm start          (terminal 1)
 *   npm run smoke -- --isolated ws://localhost:8099/ws                   (terminal 2)
 * It RESETS the timer, so it refuses to run without --isolated <url>.
 */
import WebSocket from 'ws';
import fs from 'node:fs';
import type { AppState, Command, ServerMsg } from '../src/shared/model';

const iso = process.argv.indexOf('--isolated');
if (iso < 0 || !process.argv[iso + 1]) {
  console.error('Refusing to run: this test resets the timer. Pass --isolated ws://localhost:<test-port>/ws for a TEST server.');
  process.exit(2);
}
const URL = process.argv[iso + 1];
const DATA = process.env.DATA_DIR ?? 'data';
const PIN = process.env.ADMIN_PIN ?? fs.readFileSync(`${DATA}/admin-pin.txt`, 'utf8').trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

class Client {
  ws: WebSocket; state!: AppState; private n = 0;
  private waiters = new Map<string, (m: { ok: boolean; error?: string }) => void>();
  private authW?: (ok: boolean) => void;
  ready: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'hello', role: 'display' })));
    this.ready = new Promise((res) => {
      this.ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as ServerMsg;
        if (m.type === 'state') { this.state = m.state; res(); }
        if (m.type === 'result') { this.waiters.get(m.reqId)?.(m); this.waiters.delete(m.reqId); }
        if (m.type === 'auth') this.authW?.(m.ok);
      });
    });
  }
  auth(pin: string) { return new Promise<boolean>((r) => { this.authW = r; this.ws.send(JSON.stringify({ type: 'auth', pin })); }); }
  async cmd(cmd: Command) {
    const reqId = String(++this.n);
    const r = await new Promise<{ ok: boolean; error?: string }>((res) => { this.waiters.set(reqId, res); this.ws.send(JSON.stringify({ type: 'cmd', reqId, cmd })); });
    await sleep(60); // let the broadcast arrive
    return r;
  }
}

const H = 3_600_000;
(async () => {
  const admin = new Client(), display = new Client();
  await Promise.all([admin.ready, display.ready]);

  check('unauthenticated client cannot mutate', !(await display.cmd({ type: 'timer.reset' })).ok);
  check('wrong PIN rejected', !(await admin.auth('000000x')));
  check('correct PIN accepted', await admin.auth(PIN));

  await admin.cmd({ type: 'sim.stop' });
  await admin.cmd({ type: 'timer.reset' });
  check('reset → ready with 24h', admin.state.timer.status === 'ready' && admin.state.timer.remainingMs === 24 * H);

  const t0 = Date.now();
  await admin.cmd({ type: 'timer.start' });
  const tt = display.state.timer;
  check('start → running (display received it)', tt.status === 'running');
  check('deadline = start + 24h', Math.abs((tt.endsAt ?? 0) - (t0 + 24 * H)) < 1000, `${(tt.endsAt ?? 0) - t0 - 24 * H} ms`);
  check('start while running is rejected', !(await admin.cmd({ type: 'timer.start' })).ok);
  check('schedule while running is rejected', !(await admin.cmd({ type: 'timer.schedule', startAt: Date.now() + H })).ok);

  const before = JSON.stringify(display.state.timer);
  await admin.cmd({ type: 'ann.add', text: 'Smoke test announcement', priority: true });
  const added = admin.state.announcements.find((a) => a.text === 'Smoke test announcement')!;
  await admin.cmd({ type: 'ann.update', id: added.id, patch: { text: 'Edited', active: false } });
  await admin.cmd({ type: 'settings.update', patch: { tickerMode: 'static' } });
  await admin.cmd({ type: 'settings.update', patch: { tickerMode: 'scroll' } });
  await admin.cmd({ type: 'ann.delete', id: added.id });
  check('announcement + settings edits leave timer byte-identical', JSON.stringify(display.state.timer) === before);
  check('announcement edits reached the display', !display.state.announcements.some((a) => a.id === added.id));

  await admin.cmd({ type: 'timer.pause' });
  const pausedRem = display.state.timer.remainingMs;
  check('pause → paused', display.state.timer.status === 'paused' && pausedRem > 24 * H - 5000);
  await sleep(1500);
  check('paused time does not move', display.state.timer.remainingMs === pausedRem);
  const tr = Date.now();
  await admin.cmd({ type: 'timer.resume' });
  check('resume → endsAt = now + remaining', Math.abs((display.state.timer.endsAt ?? 0) - (tr + pausedRem)) < 1000);

  await admin.cmd({ type: 'timer.setRemaining', ms: 12 * H + 3000 });
  check('adjust while running moves the deadline', Math.abs((display.state.timer.endsAt ?? 0) - Date.now() - (12 * H + 3000)) < 1000);
  await admin.cmd({ type: 'timer.setRemaining', ms: 99 * H });
  check('adjust is clamped to 24h', (display.state.timer.endsAt ?? 0) - Date.now() <= 24 * H + 50);

  await admin.cmd({ type: 'timer.reset' });
  check('reset issues new session id', display.state.timer.sessionId !== JSON.parse(before).sessionId);
  check('schedule >24h in the past rejected', !(await admin.cmd({ type: 'timer.schedule', startAt: Date.now() - 25 * H })).ok);
  check('schedule NaN rejected', !(await admin.cmd({ type: 'timer.schedule', startAt: Number.NaN })).ok);
  const past = Date.now() - H;
  await admin.cmd({ type: 'timer.schedule', startAt: past });
  check('schedule 1h in the past → running with ~23h left, anchored to start', display.state.timer.status === 'running' && display.state.timer.endsAt === past + 24 * H);

  await admin.cmd({ type: 'timer.reset' });
  await admin.cmd({ type: 'timer.schedule', startAt: Date.now() + 1500 });
  check('future schedule → scheduled', display.state.timer.status === 'scheduled');
  await sleep(2000);
  check('server auto-starts at scheduled moment', display.state.timer.status === 'running');

  await admin.cmd({ type: 'timer.setRemaining', ms: 1500 });
  await sleep(2200);
  check('server auto-completes at deadline', display.state.timer.status === 'completed' && display.state.timer.remainingMs === 0);
  check('resume after completion rejected', !(await admin.cmd({ type: 'timer.resume' })).ok);

  await sleep(200);
  const disk = JSON.parse(fs.readFileSync(`${DATA}/state.json`, 'utf8'));
  check('state persisted to disk', disk.timer.status === 'completed' && disk.timer.sessionId === display.state.timer.sessionId);

  // Changed in 1.1: projector simulations are refused once the REAL event has finished (real result wins).
  check('simulation after real completion is rejected', !(await admin.cmd({ type: 'sim.start', kind: 'final', fromMs: 65_000 })).ok && display.state.simulation === null);

  await admin.cmd({ type: 'timer.reset' });
  await admin.cmd({ type: 'settings.update', patch: { rehearsal: true } });
  const readyTimer = JSON.stringify(display.state.timer);
  await admin.cmd({ type: 'sim.start', kind: 'final', fromMs: 65_000 });
  check('rehearsal simulation (ready state) does not touch timer', display.state.simulation?.kind === 'final' && JSON.stringify(display.state.timer) === readyTimer);
  await admin.cmd({ type: 'sim.stop' });
  await admin.cmd({ type: 'settings.update', patch: { rehearsal: false } });
  console.log(`\n${pass} passed, ${fail} failed. Timer left in READY state.`);
  admin.ws.close(); display.ws.close();
  process.exit(fail ? 1 : 0);
})();
