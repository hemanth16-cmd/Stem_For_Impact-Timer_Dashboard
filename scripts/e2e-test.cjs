/**
 * Browser end-to-end tests against a throwaway server (temporary DATA_DIR, random port) using the
 * prepared dist/ build. Requires Playwright (dev machine only — not needed on event day):
 *   npx playwright install chromium   (once)
 *   node scripts/e2e-test.cjs
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const PIN = '482913';
const H = 3_600_000, MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sfi-e2e-'));
const PORT = 19100 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
let srv;
async function startServer() {
  srv = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/index.ts')], {
    cwd: ROOT, env: { ...process.env, DATA_DIR: DIR, PORT: String(PORT), ADMIN_PIN: PIN, ALLOW_STALE_BUILD: '1', HOST: '127.0.0.1' }, stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* wait */ } await sleep(100); }
  throw new Error('server did not start');
}
async function stopServer(sig = 'SIGTERM') { if (!srv) return; const p = new Promise((r) => srv.on('exit', r)); srv.kill(sig); await p; srv = null; }

function adminWs() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`); let n = 0; const wait = new Map(); const api = { state: null };
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'state') api.state = m.state; if (m.type === 'auth' && m.ok) resolve(api); if (m.type === 'result') { wait.get(m.reqId)?.(m); wait.delete(m.reqId); } });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', role: 'admin' })); ws.send(JSON.stringify({ type: 'auth', pin: PIN })); });
    api.cmd = (cmd) => new Promise((r) => {
      const reqId = 'e' + ++n; wait.set(reqId, r);
      if (ws.readyState !== 1) return r({ ok: false, error: 'socket closed' });
      ws.send(JSON.stringify({ type: 'cmd', reqId, cmd }));
      setTimeout(() => { if (wait.has(reqId)) { wait.delete(reqId); r({ ok: false, error: 'timeout' }); } }, 5000);
    }).then(async (x) => { await sleep(80); return x; });
    api.close = () => ws.close();
  });
}
const digits = (page) => page.evaluate(() => [...document.querySelectorAll('.stage .tabular')].map((e) => e.textContent).join('|'));
const shownSeconds = async (page) => {
  // Read the visible (incoming) digits of the hero countdown: H:M:S groups.
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll('.stage .glass .tabular')].slice(0, 3);
    const val = (g) => [...g.children].map((d) => d.lastElementChild?.textContent ?? '').join('');
    if (groups.length < 3) return null;
    const [h, m, s] = groups.map(val).map(Number);
    return h * 3600 + m * 60 + s;
  });
};

(async () => {
  await startServer();
  const a = await adminWs();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const display = await ctx.newPage();
  const errors = [];
  display.on('pageerror', (e) => errors.push(e.message));

  console.log('\nDisplay basics, refresh, announcements');
  await a.cmd({ type: 'timer.start' });
  await a.cmd({ type: 'timer.setRemaining', ms: 23 * H });
  await display.goto(BASE + '/');
  await display.waitForSelector('[data-status="running"]');
  await sleep(1200);
  const s1 = await shownSeconds(display);
  check('display shows the running countdown', s1 > 23 * 3600 - 10 && s1 <= 23 * 3600, String(s1));
  await display.reload();
  await display.waitForSelector('[data-status="running"]');
  await sleep(800);
  const s2 = await shownSeconds(display);
  check('refresh restores the exact countdown', Math.abs(s2 - (s1 - 2)) <= 2, `${s1} → ${s2}`);

  const before = JSON.stringify(a.state.timer);
  await a.cmd({ type: 'ann.add', text: 'Live update while counting', priority: false });
  await sleep(600);
  const tickerText = await display.textContent('[data-testid="ticker"]');
  check('announcement appears on the display while running', tickerText.includes('Live update while counting'));
  check('announcement change leaves the timer untouched', JSON.stringify(a.state.timer) === before);
  const sAfter = await shownSeconds(display);
  check('countdown keeps counting through announcement edits (no reset/pause)', sAfter < s2 && sAfter > s2 - 6);

  await a.cmd({ type: 'ann.add', text: 'URGENT: Priority test', priority: true });
  await sleep(500);
  const first = await display.evaluate(() => document.querySelector('.ticker-track span span')?.textContent ?? '');
  check('new priority announcement is shown first, promptly (scroll mode)', /PRIORITY/.test(first) || first.includes('URGENT'), first.slice(0, 40));

  // Short list: the scroller must always cover the box (no gap at the loop point)
  const cover = await display.evaluate(() => {
    const t = document.querySelector('.ticker-track'); const box = t.parentElement;
    const seq = t.firstElementChild.offsetWidth; const copies = t.children.length;
    return { ok: seq * (copies - 1) >= box.offsetWidth, seq, copies, box: box.offsetWidth };
  });
  check('scrolling ticker has no gap at the loop boundary', cover.ok, JSON.stringify(cover));

  // Static mode + long announcement fully visible
  const long = 'IMPORTANT: All teams must submit their GitHub repository link, a two-minute demo video and the completed project abstract form through the official portal before the final deadline. Late submissions cannot be evaluated by the judging panel under any circumstances.';
  await a.cmd({ type: 'settings.update', patch: { tickerMode: 'static' } });
  const all = a.state.announcements;
  for (const x of all) if (x.active) await a.cmd({ type: 'ann.update', id: x.id, patch: { active: false } });
  await a.cmd({ type: 'ann.add', text: long, priority: true });
  await sleep(900);
  const fit = await display.evaluate(() => {
    const el = document.querySelector('[data-testid="ticker-page"]'); const box = document.querySelector('[data-testid="ticker"]');
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    return { text: el.textContent, inside: r.bottom <= b.bottom + 1 && r.top >= b.top - 1, overflow: el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2, size: parseFloat(el.style.fontSize) };
  });
  check(`static mode shows the ENTIRE ${long.length}-char announcement (no truncation/clipping)`, fit.text.includes(long) && fit.inside && !fit.overflow && fit.size >= 22, `font ${fit.size}px`);
  await a.cmd({ type: 'settings.update', patch: { tickerMode: 'scroll' } });

  console.log('\nOrganizer panel: real timer, controls, PIN');
  const adm = await ctx.newPage();
  await adm.goto(BASE + '/admin');
  const pinType = await adm.getAttribute('#pin', 'type');
  check('PIN input is masked', pinType === 'password');
  await adm.fill('#pin', PIN);
  await adm.click('button[type=submit]');
  await adm.waitForSelector('[data-testid="admin-remaining"]');
  // Stored remainingMs is stale (24h) while running; endsAt says ~23h → admin must show ~23h.
  await a.cmd({ type: 'timer.setRemaining', ms: 23 * H - 30 * MIN });
  await sleep(1300);
  const admText = await adm.textContent('[data-testid="admin-remaining"]');
  check('admin shows the REAL remaining time while running (not the stale stored 24h)', admText.startsWith('22:29') || admText.startsWith('22:30'), admText);
  await adm.click('text=Use current');
  const hrs = await adm.inputValue('input[placeholder="0"] >> nth=0');
  check('"Use current" uses the real remaining time', hrs === '22', hrs);

  // Confirm dialog: focus + Escape
  await adm.click('button:has-text("Pause")');
  await adm.waitForSelector('[role=alertdialog]');
  const focused = await adm.evaluate(() => document.activeElement?.textContent);
  await adm.keyboard.press('Escape');
  await sleep(900);
  const dlgGone = !(await adm.$('[role=alertdialog]'));
  check('confirmation dialog takes focus (Cancel) and closes with Escape without acting', focused === 'Cancel' && dlgGone && a.state.timer.status === 'running', `focus=${focused} gone=${dlgGone} status=${a.state.timer.status}`);

  // Reset of a live event needs typed confirmation
  await adm.click('button:has-text("Reset")');
  await adm.waitForSelector('[role=alertdialog] input');
  const resetBtn = adm.locator('[role=alertdialog] button:has-text("Reset timer")');
  const disabledFirst = await resetBtn.isDisabled();
  await adm.keyboard.press('Escape');
  check('resetting a LIVE event requires typing RESET', disabledFirst && a.state.timer.status === 'running');

  // +5 twice accumulates
  const end0 = a.state.timer.endsAt;
  for (let i = 0; i < 2; i++) {
    await adm.click('button:has-text("+5 min")');
    await adm.click('[role=alertdialog] button:has-text("Apply")');
    await sleep(500);
  }
  check('pressing +5 min twice adds 10 minutes', Math.abs(a.state.timer.endsAt - end0 - 10 * MIN) < 1500, `${Math.round((a.state.timer.endsAt - end0) / 1000)} s`);

  // Pause / resume through the UI reach the display
  await adm.click('button:has-text("Pause")');
  await adm.click('[role=alertdialog] button:has-text("Pause")');
  await display.waitForSelector('[data-status="paused"]', { timeout: 3000 });
  const p1 = await shownSeconds(display); await sleep(1500); const p2 = await shownSeconds(display);
  check('pause from the admin UI freezes the projector', p1 === p2);
  await adm.click('button:has-text("Resume")');
  await display.waitForSelector('[data-status="running"]', { timeout: 3000 });
  check('resume from the admin UI restarts the projector', true);

  console.log('\nNetwork loss and reconnection (browser)');
  const sBefore = await shownSeconds(display);
  await stopServer('SIGKILL');
  await sleep(14000); // > stale-connection timeout
  const banner = await display.textContent('[role=status]').catch(() => '');
  const sDuring = await shownSeconds(display);
  check('projector keeps counting with a visible reconnect warning while the server is down', /Reconnecting|unreachable/i.test(banner) && sDuring < sBefore - 10, `${banner} | ${sBefore} → ${sDuring}`);
  const disabled = await adm.locator('button:has-text("Pause")').isDisabled();
  const admAlert = await adm.textContent('body');
  check('admin: disconnection shown and controls disabled', disabled && /Disconnected|DISCONNECTED|not signed in|Cannot reach/i.test(admAlert), `disabled=${disabled} ${admAlert.replace(/\s+/g, ' ').slice(0, 160)}`);
  await startServer();
  await display.waitForFunction(() => !document.querySelector('[role=status]')?.textContent?.match(/Reconnect|unreachable/), null, { timeout: 15000 });
  check('projector reconnects automatically after the server returns', true);
  await adm.waitForSelector('button:has-text("Pause"):not([disabled])', { timeout: 15000 });
  check('admin re-authenticates automatically and controls come back', true);
  const a2 = await adminWs();

  console.log('\nCompletion and finish sound');
  await display.mouse.click(10, 10); // arms audio on the projector page (a real click)
  await sleep(300);
  await a2.cmd({ type: 'timer.setRemaining', ms: 3000 });
  await display.waitForSelector('[data-status="completed"]', { timeout: 8000 });
  await sleep(800);
  let snd = await display.evaluate(() => window.__sfiSound);
  check('finish sound plays exactly once for a live completion', snd.played === 1, JSON.stringify(snd));
  const comp = a2.state.timer;
  check('server records completedAt for the finish', comp.status === 'completed' && Math.abs(comp.completedAt - Date.now()) < 3000);
  await display.reload();
  await display.waitForSelector('[data-status="completed"]');
  await sleep(1500);
  snd = await display.evaluate(() => window.__sfiSound);
  check('reloading after the finish does not replay the sound', snd.played === 0 && snd.blocked === 0, JSON.stringify(snd));
  // Extend after completion → finishes again → plays again (new completion)
  await display.mouse.click(10, 10);
  await a2.cmd({ type: 'timer.setRemaining', ms: 2500 });
  await a2.cmd({ type: 'timer.resume' });
  await display.waitForSelector('[data-status="running"]');
  await display.waitForSelector('[data-status="completed"]', { timeout: 8000 });
  await sleep(700);
  snd = await display.evaluate(() => window.__sfiSound);
  check('extending and finishing again plays the sound once more (new completion)', snd.played === 1, JSON.stringify(snd));

  // Completion during disconnection
  await a2.cmd({ type: 'timer.setRemaining', ms: 6000 });
  await a2.cmd({ type: 'timer.resume' });
  await display.waitForSelector('[data-status="running"]');
  await display.mouse.click(10, 10);
  a2.close(); a.close();
  await stopServer('SIGKILL');
  await display.waitForSelector('[data-status="completed"]', { timeout: 12000 });
  await sleep(800);
  const sndOff = await display.evaluate(() => window.__sfiSound.played);
  await startServer();
  await sleep(4000);
  const sndOn = await display.evaluate(() => window.__sfiSound.played);
  check('completion while disconnected still shows TIME’S UP and plays once; no replay after reconnect', sndOff === 2 && sndOn === 2, `${sndOff} → ${sndOn}`);

  // Blocked audio is reported honestly
  const blockedCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const bp = await blockedCtx.newPage();
  const a3 = await adminWs();
  await a3.cmd({ type: 'timer.setRemaining', ms: 4000 });
  await a3.cmd({ type: 'timer.resume' });
  await bp.goto(BASE + '/'); // no click → browser will not allow sound
  await bp.waitForSelector('[data-status="completed"]', { timeout: 10000 });
  await sleep(600);
  const blk = await bp.evaluate(() => ({ s: window.__sfiSound, banner: document.body.innerText.includes('blocked the finish sound'), keys: Object.entries(localStorage).filter(([k]) => k.startsWith('sfi.end.')) }));
  check('blocked finish sound is NOT recorded as played; a click-to-play prompt appears', blk.s.played === 0 && blk.banner && blk.keys.length === 0, JSON.stringify(blk.keys));
  await blockedCtx.close();

  console.log('\nRehearsal, preview, modes');
  await a3.cmd({ type: 'timer.reset' });
  await a3.cmd({ type: 'settings.update', patch: { rehearsal: true } });
  await a3.cmd({ type: 'sim.start', kind: 'milestone', milestoneMs: 12 * H });
  await display.waitForSelector('text=REHEARSAL · NOT THE REAL TIMER', { timeout: 3000 });
  await a3.cmd({ type: 'sim.stop' });
  await sleep(1300); // overlay fade-out
  const stillThere = await display.$('text=REHEARSAL · NOT THE REAL TIMER');
  check('stopping a rehearsal removes its overlay immediately', !stillThere);
  await a3.cmd({ type: 'settings.update', patch: { rehearsal: false } });
  await a3.cmd({ type: 'timer.start' });
  const pv = await ctx.newPage();
  await pv.goto(BASE + '/?preview=final');
  await pv.waitForSelector('text=PREVIEW · THIS SCREEN ONLY', { timeout: 5000 });
  await sleep(500);
  check('isolated preview runs during the live event without touching server state', a3.state.simulation === null && a3.state.timer.status === 'running');
  await pv.close();

  await a3.cmd({ type: 'settings.update', patch: { performance: true } });
  await sleep(500);
  const perf = await display.evaluate(() => ({ cls: document.querySelector('.display-root').className, anim: getComputedStyle(document.querySelector('.bg-glow') ?? document.body).animationPlayState, digits: !!document.querySelector('.stage .glass'), ticker: !!document.querySelector('[data-testid="ticker"]') }));
  check('Performance mode keeps digits + announcements and stops decoration', perf.cls.includes('perf') && perf.digits && perf.ticker);
  await a3.cmd({ type: 'settings.update', patch: { performance: false } });

  const rmCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  const rm = await rmCtx.newPage();
  await rm.goto(BASE + '/');
  await rm.waitForSelector('[data-status="running"]');
  await sleep(800);
  const rmInfo = await rm.evaluate(() => ({ cls: document.querySelector('.display-root').className, scrolling: !!document.querySelector('.ticker-track'), page: !!document.querySelector('[data-testid="ticker-page"]') }));
  check('reduced motion: no scrolling ticker (paged instead), .rm applied', rmInfo.cls.includes(' rm') && !rmInfo.scrolling && rmInfo.page);
  await rmCtx.close();

  // Hidden tab pauses decoration
  await display.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(300);
  const hid = await display.evaluate(() => document.querySelector('.display-root').className.includes('doc-hidden'));
  await display.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  check('hidden document pauses decorative animation', hid);

  console.log('\nFallback: no automatic local mode');
  const lctx = await browser.newContext();
  const lp = await lctx.newPage();
  await lp.goto(BASE + '/admin');
  await lp.waitForSelector('#pin');
  await stopServer('SIGKILL');
  await lp.evaluate(() => localStorage.clear());
  await lp.reload().catch(() => {});
  // page cannot load without the server — emulate a first load by navigating with the cached document via a data proxy is not
  // possible here; instead check the in-page behaviour: the store keeps retrying the server and never switches itself to local.
  await startServer();
  const lp2 = await lctx.newPage();
  await lp2.goto(BASE + '/admin');
  await stopServer('SIGKILL');
  await sleep(14000);
  const modeText = await lp2.textContent('header');
  check('server loss never switches the organizer into local mode by itself', !/LOCAL MODE/.test(modeText) && /DISCONNECTED|CONNECTING/.test(modeText), modeText.replace(/\s+/g, ' ').slice(0, 80));
  await startServer();
  const lp3 = await lctx.newPage();
  await lp3.goto(BASE + '/admin?local=1');
  await lp3.waitForSelector('text=LOCAL MODE');
  const link = await lp3.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Open display window')); return !!b; });
  const banner2 = await lp3.textContent('header');
  check('explicit local mode is clearly labelled as this-browser-only', /this browser on this computer only/i.test(banner2) && link);
  await lctx.close();

  check('no uncaught errors on the projector page', errors.length === 0, errors.join(' | '));
  await browser.close();
  await stopServer();
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await stopServer(); } catch { /* */ } process.exit(1); });
