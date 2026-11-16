/**
 * STEM FOR IMPACT 2026 — live sync server.
 *
 * Runs on the organizer laptop. It is the single authoritative clock + state store:
 *  - serves the prepared dashboard build (`/` display, `/admin` organizer panel)
 *  - pushes state to every connected screen over WebSocket (`/ws`)
 *  - persists to DATA_DIR/state.json atomically, keeps backups, and refuses to silently reset
 *    the event when saved state is damaged (recovery mode)
 *  - only PIN-authenticated admin connections may mutate state
 *
 * Environment: PORT (8080) · DATA_DIR (./data) · ADMIN_PIN · ALLOWED_ORIGINS · ALLOWED_HOSTS
 *              ALLOW_STALE_BUILD=1 (skip build check) · SFI_DEV=1 (dev mode, set by `npm run dev`)
 */
import express from 'express';
import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  applyCommand, CommandError, defaultState, parseClientMsg, resolveTimer, simLifetime, uid, validateCommand, validateState,
  type AppState, type DisplayInfo, type PersistenceHealth, type RecoveryInfo, type Role, type ServerInfo, type ServerMsg,
} from '../src/shared/model';
import { loadState, pathsFor, saveStateAtomic, snapshot } from './persistence';
import { computeSourceHash, readBuildInfo } from './sourceHash';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const PATHS = pathsFor(DATA_DIR);
const PIN_FILE = path.join(DATA_DIR, 'admin-pin.txt');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 8080);
const DEV = process.env.SFI_DEV === '1' || process.argv.includes('--dev');

const LIMITS = {
  maxPayload: 16 * 1024,
  maxClients: Number(process.env.MAX_CLIENTS ?? 64),
  maxClientsPerIp: Number(process.env.MAX_CLIENTS_PER_IP ?? 24),
  msgBurst: 40,
  msgPerSec: 20,
  maxMalformed: 20,
  pinFailsBeforeLock: 5,
  pinTrackMax: 1000,
  pinEntryTtl: 30 * 60_000,
  globalFailsPerMin: 30,
};

const log = (...a: unknown[]) => console.log(new Date().toLocaleTimeString('en-IN', { hour12: false }), ...a);

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- build verification ----------
const SOURCE_HASH = computeSourceHash(ROOT);
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
const BUILD_INFO = readBuildInfo(DIST);
const BUILD_ID = BUILD_INFO?.build ?? `${PKG_VERSION}-dev`;
const BUILD_MATCHES = !!BUILD_INFO && BUILD_INFO.sourceHash === SOURCE_HASH;
if (!DEV && !BUILD_MATCHES) {
  const why = BUILD_INFO ? 'the prepared build in dist/ was made from DIFFERENT source files' : 'there is no prepared build in dist/';
  if (process.env.ALLOW_STALE_BUILD === '1') {
    console.warn(`\n!! WARNING: ${why}. Continuing because ALLOW_STALE_BUILD=1.\n`);
  } else {
    console.error(`\n!! Cannot start: ${why}.\n!! Run PREPARE-EVENT.bat (or "npm run prepare-event") first, then start again.\n`);
    process.exit(2);
  }
}

// ---------- admin PIN ----------
function loadPin(): string {
  if (process.env.ADMIN_PIN) return process.env.ADMIN_PIN.trim();
  try {
    const p = fs.readFileSync(PIN_FILE, 'utf8').trim();
    if (p) return p;
  } catch { /* first run */ }
  const p = String(crypto.randomInt(100000, 999999));
  fs.writeFileSync(PIN_FILE, p + '\n');
  return p;
}
const ADMIN_PIN = loadPin();
const pinOk = (pin: string) => {
  const a = crypto.createHash('sha256').update(pin.trim()).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PIN).digest();
  return crypto.timingSafeEqual(a, b);
};

// PIN attempts are limited per IP address across ALL connections, with bounded, expiring storage.
const pinFails = new Map<string, { fails: number; lastAt: number; lockedUntil: number }>();
let globalFails: number[] = [];
const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1';
function pinLockedFor(ip: string, now: number): number {
  globalFails = globalFails.filter((t) => now - t < 60_000);
  // A burst of failures from many devices pauses PIN checks for remote devices, but can never lock
  // the organizer laptop itself (loopback) out of its own event.
  if (globalFails.length >= LIMITS.globalFailsPerMin && !isLoopback(ip)) return 30_000;
  const e = pinFails.get(ip);
  return e && e.lockedUntil > now ? e.lockedUntil - now : 0;
}
function recordPinFail(ip: string, now: number) {
  globalFails.push(now);
  const e = pinFails.get(ip) ?? { fails: 0, lastAt: now, lockedUntil: 0 };
  e.fails++;
  e.lastAt = now;
  if (e.fails >= LIMITS.pinFailsBeforeLock) e.lockedUntil = now + Math.min(15 * 60_000, 30_000 * 2 ** (e.fails - LIMITS.pinFailsBeforeLock));
  pinFails.delete(ip);
  pinFails.set(ip, e);
  while (pinFails.size > LIMITS.pinTrackMax) pinFails.delete(pinFails.keys().next().value as string);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of pinFails) if (now - e.lastAt > LIMITS.pinEntryTtl && e.lockedUntil < now) pinFails.delete(ip);
}, 60_000).unref();

// ---------- state + persistence ----------
let state: AppState | null = null;
let recovery: { reason: string; preserved: string[]; offers: Map<string, AppState & { from: string }> } | null = null;
const health: PersistenceHealth = { status: 'ok', lastSavedAt: null, savedRev: null, lastError: null, source: 'none', notes: [] };

const loaded = loadState(PATHS);
health.notes = loaded.notes;
switch (loaded.kind) {
  case 'fresh':
    state = defaultState();
    health.source = 'fresh';
    log('No saved state (first run) — starting fresh: timer ready, 24:00:00.');
    break;
  case 'restored':
    state = loaded.state;
    health.source = 'restored';
    log(`Restored saved state (rev ${state.rev}, timer ${state.timer.status}).`);
    break;
  case 'backup':
    state = loaded.state;
    health.source = 'backup';
    console.warn(`!! ${loaded.notes.join('\n!! ')}`);
    if (loaded.preserved.length) console.warn(`!! Damaged file preserved as: ${loaded.preserved.join(', ')}`);
    break;
  case 'recovery':
    recovery = { reason: loaded.reason, preserved: loaded.preserved, offers: new Map() };
    health.status = 'recovery';
    health.lastError = loaded.reason;
    console.error(`\n!! RECOVERY NEEDED: ${loaded.reason}\n!! ${loaded.notes.join('\n!! ')}`);
    console.error('!! Nothing will be overwritten. Open the organizer panel to restore from a display cache or start fresh.\n');
    break;
}

let retryTimer: NodeJS.Timeout | undefined;
/** Synchronously persist. Returns true when the current revision is safely on disk. */
function persistNow(): boolean {
  if (!state) return false;
  try {
    saveStateAtomic(PATHS, state);
    health.status = 'ok';
    health.lastSavedAt = Date.now();
    health.savedRev = state.rev;
    health.lastError = null;
    return true;
  } catch (e) {
    const msg = `${(e as NodeJS.ErrnoException).code ?? ''} ${(e as Error).message}`.trim();
    if (health.status !== 'failing' || health.lastError !== msg) console.error('!! FAILED TO SAVE STATE:', msg);
    health.status = 'failing';
    health.lastError = msg;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (persistNow()) { log('State saved again after earlier failure.'); broadcastInfo(); } }, 5_000);
    return false;
  }
}
let lastSnapRev = -1;
function takeSnapshot() {
  if (!state || state.rev === lastSnapRev) return; // only when something changed: backups span more time
  const err = snapshot(PATHS, state);
  if (err) { log('!! snapshot failed:', err); health.notes = [...health.notes, `Snapshot failed: ${err}`].slice(-20); } else lastSnapRev = state.rev;
}
if (state) { persistNow(); takeSnapshot(); }
setInterval(takeSnapshot, 10 * 60_000).unref();

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, serverNow: Date.now(), build: BUILD_ID, recovery: !!recovery });
});
app.get('/api/state', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!state) return res.status(503).json({ recovery: true });
  res.json({ state, serverNow: Date.now() });
});
if (fs.existsSync(DIST)) {
  app.use('/assets', express.static(path.join(DIST, 'assets'), { index: false, maxAge: '365d', immutable: true }));
  app.use(express.static(DIST, { index: false, maxAge: '1h' }));
  app.get(['/', '/admin', '/admin/*'], (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => res.type('text').send('Dashboard not built yet. Run PREPARE-EVENT.bat (or "npm run dev" for development).'));
}
const server = createServer(app);

// ---------- websocket ----------
interface Client extends WebSocket {
  connId: string; ip: string; role: Role; isAdmin: boolean; alive: boolean;
  tokens: number; lastRefill: number; malformed: number; info: DisplayInfo;
}
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const allowedHosts = new Set((process.env.ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const localAddrs = () => new Set(['localhost', '127.0.0.1', '::1', '[::1]', os.hostname().toLowerCase(),
  ...Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => i!.address.toLowerCase())]);

/** Hostname must be this machine (or explicitly allowed) — blocks DNS-rebinding pages. */
function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try { hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase(); } catch { return false; }
  return localAddrs().has(hostname) || localAddrs().has(hostname.replace(/^\[|\]$/g, '')) || allowedHosts.has(hostname)
    || hostname.endsWith('.local');
}
/** Browsers always send Origin; it must be the page that the server itself served. */
function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // non-browser tools (tests, scripts) — they still need the PIN to change anything
  if (allowedOrigins.has(origin)) return true;
  try { return new URL(origin).host.toLowerCase() === (host ?? '').toLowerCase(); } catch { return false; }
}
const ipOf = (req: IncomingMessage) => (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: LIMITS.maxPayload,
  verifyClient: (info, cb) => {
    const ip = ipOf(info.req);
    if (!hostAllowed(info.req.headers.host)) { log(`x rejected ws from ${ip}: host ${info.req.headers.host}`); return cb(false, 403, 'Host not allowed'); }
    if (!originAllowed(info.origin, info.req.headers.host)) { log(`x rejected ws from ${ip}: origin ${info.origin}`); return cb(false, 403, 'Origin not allowed'); }
    if (wss.clients.size >= LIMITS.maxClients) return cb(false, 503, 'Too many connections');
    let fromIp = 0;
    for (const c of wss.clients as Set<Client>) if (c.ip === ip) fromIp++;
    if (fromIp >= LIMITS.maxClientsPerIp) return cb(false, 429, 'Too many connections from this address');
    cb(true);
  },
});

const sendRaw = (ws: WebSocket, data: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); };
const send = (ws: WebSocket, msg: ServerMsg) => sendRaw(ws, JSON.stringify(msg));
const clients = () => wss.clients as Set<Client>;

function broadcastState() {
  if (!state) return;
  const msg = JSON.stringify({ type: 'state', state, serverNow: Date.now() } satisfies ServerMsg);
  for (const c of clients()) sendRaw(c, msg);
  scheduleInfo();
}
function serverInfo(): ServerInfo {
  const rec: RecoveryInfo | null = recovery && {
    reason: recovery.reason,
    preservedFiles: recovery.preserved.map((f) => path.relative(DATA_DIR, f)),
    offers: [...recovery.offers.values()].sort((a, b) => b.rev - a.rev).map((s) => ({
      rev: s.rev, status: s.timer.status, endsAt: s.timer.endsAt, remainingMs: s.timer.remainingMs, announcements: s.announcements.length, from: s.from,
    })),
  };
  return {
    build: BUILD_ID, buildMatches: BUILD_MATCHES || DEV, health,
    displays: [...clients()].filter((c) => c.role !== 'admin').map((c) => c.info),
    recovery: rec,
  };
}
function broadcastInfo() {
  const msg = JSON.stringify({ type: 'info', info: serverInfo() } satisfies ServerMsg);
  for (const c of clients()) if (c.isAdmin) sendRaw(c, msg);
}
let infoQueued: NodeJS.Timeout | null = null;
function scheduleInfo() {
  if (infoQueued) return;
  infoQueued = setTimeout(() => { infoQueued = null; broadcastInfo(); }, 250);
}

// Command de-duplication: a retried command (same cmdId) returns the original outcome.
const cmdCache = new Map<string, { at: number; result: Extract<ServerMsg, { type: 'result' }> }>();
function cacheResult(cmdId: string | undefined, result: Extract<ServerMsg, { type: 'result' }>) {
  if (!cmdId) return;
  cmdCache.set(cmdId, { at: Date.now(), result });
  while (cmdCache.size > 500) cmdCache.delete(cmdCache.keys().next().value as string);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cmdCache) if (now - v.at > 15 * 60_000) cmdCache.delete(k);
}, 60_000).unref();

function takeToken(ws: Client): boolean {
  const now = Date.now();
  ws.tokens = Math.min(LIMITS.msgBurst, ws.tokens + ((now - ws.lastRefill) / 1000) * LIMITS.msgPerSec);
  ws.lastRefill = now;
  if (ws.tokens < 1) return false;
  ws.tokens -= 1;
  return true;
}

function handleMessage(ws: Client, data: string) {
  const parsed = parseClientMsg(data);
  if (!parsed.ok) {
    ws.malformed++;
    send(ws, { type: 'error', error: parsed.error });
    if (ws.malformed > LIMITS.maxMalformed) ws.close(1008, 'Too many malformed messages');
    return;
  }
  const msg = parsed.msg;
  const now = Date.now();
  switch (msg.type) {
    case 'hello':
      ws.role = msg.role;
      ws.info.role = msg.role;
      if (msg.clientId) ws.info.id = msg.clientId;
      if (msg.build) ws.info.build = msg.build;
      scheduleInfo();
      return;

    case 'ping':
      return send(ws, { type: 'pong', clientSent: msg.clientSent, serverNow: now });

    case 'ack':
      ws.info.ackRev = msg.rev;
      ws.info.ackAt = now;
      if (msg.audio) ws.info.audio = msg.audio;
      if (msg.visible !== undefined) ws.info.visible = msg.visible;
      if (msg.fullscreen !== undefined) ws.info.fullscreen = msg.fullscreen;
      if (msg.viewport) ws.info.viewport = msg.viewport;
      if (msg.soundTest) ws.info.soundTest = { ...msg.soundTest, at: now };
      scheduleInfo();
      return;

    case 'auth': {
      const locked = pinLockedFor(ws.ip, now);
      if (locked > 0) return send(ws, { type: 'auth', ok: false, error: `Too many incorrect PINs. Try again in ${Math.ceil(locked / 1000)} s.`, retryAfterMs: locked });
      if (pinOk(msg.pin)) {
        pinFails.delete(ws.ip);
        ws.isAdmin = true;
        send(ws, { type: 'auth', ok: true });
        send(ws, { type: 'info', info: serverInfo() });
        return;
      }
      recordPinFail(ws.ip, now);
      log(`! wrong PIN from ${ws.ip}`);
      return send(ws, { type: 'auth', ok: false, error: 'Incorrect PIN.' });
    }

    case 'cacheOffer': {
      if (!recovery) return;
      const v = validateState(msg.state);
      if (!v.ok) return;
      recovery.offers.set(ws.connId, { ...v.state, from: `${ws.info.role} at ${ws.ip}` });
      while (recovery.offers.size > 10) recovery.offers.delete(recovery.offers.keys().next().value as string);
      scheduleInfo();
      return;
    }

    case 'recovery.adopt':
    case 'recovery.fresh': {
      const reply = (ok: boolean, error?: string) => send(ws, { type: 'result', reqId: msg.reqId, ok, error, applied: ok, saved: ok });
      if (!ws.isAdmin) return reply(false, 'Not authorised.');
      if (!recovery) return reply(false, 'The server is not in recovery mode.');
      let next: AppState;
      if (msg.type === 'recovery.adopt') {
        const offer = [...recovery.offers.values()].find((o) => o.rev === msg.rev);
        if (!offer) return reply(false, 'That cached copy is no longer available.');
        const { from: _f, ...s } = offer;
        next = { ...s, rev: s.rev + 1 };
        health.source = 'cache-offer';
      } else {
        if (msg.confirm !== 'START FRESH') return reply(false, 'Type START FRESH to confirm.');
        next = defaultState();
        health.source = 'manual-fresh';
      }
      state = next;
      if (!persistNow()) {
        state = null;
        health.status = 'recovery';
        return reply(false, `Could not save the restored state: ${health.lastError}`);
      }
      log(`Recovery completed (${health.source}); preserved files: ${recovery.preserved.join(', ') || 'none'}`);
      health.notes.push(`Recovered by organizer (${health.source}) at ${new Date().toISOString()}.`);
      recovery = null;
      reply(true);
      broadcastState();
      return;
    }

    case 'cmd': {
      const result = (r: Omit<Extract<ServerMsg, { type: 'result' }>, 'type' | 'reqId'>) => {
        const out = { type: 'result' as const, reqId: msg.reqId, cmdId: msg.cmdId, ...r };
        if (r.applied !== undefined) cacheResult(msg.cmdId, out);
        send(ws, out);
      };
      if (!ws.isAdmin) return result({ ok: false, error: 'Not authorised.' });
      if (!state) return result({ ok: false, error: 'The server is in recovery mode. Restore the saved state first.' });
      if (msg.cmdId && cmdCache.has(msg.cmdId)) {
        const prev = cmdCache.get(msg.cmdId)!.result;
        return send(ws, { ...prev, reqId: msg.reqId, duplicate: true });
      }
      let cmd;
      try {
        cmd = validateCommand(msg.cmd);
      } catch (e) {
        return result({ ok: false, error: e instanceof CommandError ? e.message : 'Invalid command.' });
      }
      if (cmd.type === 'display.testSound') {
        const id = msg.cmdId ?? uid();
        for (const c of clients()) if (c.role === 'display') send(c, { type: 'testSound', id });
        return result({ ok: true, applied: true, saved: true, rev: state.rev });
      }
      try {
        const nextState = applyCommand(state, cmd, now, { baseTimerRev: msg.baseTimerRev });
        if (nextState === state) return result({ ok: true, applied: false, saved: health.savedRev === state.rev, rev: state.rev });
        state = nextState;
        const saved = persistNow();
        broadcastState();
        log(`  ${cmd.type} → rev ${state.rev}, timer ${state.timer.status}${saved ? '' : '  (NOT SAVED)'}`);
        return result({ ok: true, applied: true, saved, rev: state.rev });
      } catch (e) {
        if (!(e instanceof CommandError)) throw e;
        return result({ ok: false, applied: false, error: e.message });
      }
    }
  }
}

wss.on('connection', (raw, req) => {
  const ws = raw as Client;
  ws.connId = uid();
  ws.ip = ipOf(req);
  ws.role = 'display';
  ws.isAdmin = false;
  ws.alive = true;
  ws.tokens = LIMITS.msgBurst;
  ws.lastRefill = Date.now();
  ws.malformed = 0;
  ws.info = {
    id: ws.connId, role: 'display', ip: ws.ip, connectedAt: Date.now(), ackRev: null, ackAt: null,
    audio: 'unknown', visible: true, fullscreen: false, viewport: '', build: '',
  };
  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', (e) => {
    // e.g. oversized frame (1009), invalid UTF-8, abrupt reset — affects only this socket.
    log(`! socket error from ${ws.ip}: ${e.message}`);
    ws.terminate();
  });
  log(`+ client connected from ${ws.ip} (${wss.clients.size} total)`);
  if (state) send(ws, { type: 'state', state, serverNow: Date.now() });
  else if (recovery) send(ws, { type: 'recovery', reason: recovery.reason, serverNow: Date.now() });

  ws.on('message', (data, isBinary) => {
    ws.alive = true;
    try {
      if (!takeToken(ws)) {
        send(ws, { type: 'error', error: 'Rate limit exceeded.' });
        ws.close(1008, 'Rate limit exceeded');
        return;
      }
      if (isBinary) { ws.malformed++; send(ws, { type: 'error', error: 'Binary messages are not supported.' }); return; }
      handleMessage(ws, String(data));
    } catch (e) {
      // Unexpected bug in one message handler: report it, drop THIS connection, keep serving others.
      console.error('!! error while handling a message:', e);
      send(ws, { type: 'error', error: 'Server error while handling that message.' });
      ws.close(1011, 'Internal error');
    }
  });
  ws.on('close', () => {
    recovery?.offers.delete(ws.connId);
    log(`- client disconnected (${wss.clients.size} left)`);
    scheduleInfo();
  });
});
wss.on('error', (e) => console.error('!! websocket server error:', e));

// Heartbeat: drop dead sockets so clients reconnect cleanly.
setInterval(() => {
  for (const c of clients()) {
    if (!c.alive) { c.terminate(); continue; }
    c.alive = false;
    c.ping();
  }
}, 10_000).unref();

// Automatic transitions (scheduled→running, running→completed) + simulation expiry.
// The real event always takes precedence: a simulation ends as soon as the real timer is live/finished.
setInterval(() => {
  if (!state) return;
  const now = Date.now();
  const t = resolveTimer(state.timer, now);
  let changed = t !== state.timer;
  let sim = state.simulation;
  if (sim && (now - sim.startedAt > simLifetime(sim) || t.status === 'running' || t.status === 'paused' || t.status === 'completed')) {
    sim = null;
    changed = true;
  }
  if (changed) {
    state = { ...state, timer: t, simulation: sim, rev: state.rev + 1 };
    persistNow();
    broadcastState();
    log(`  auto → timer ${t.status}`);
  }
}, 200);

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`\n!! Port ${PORT} is already in use. Is the server already running in another window?\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, process.env.HOST ?? '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
  const line = '─'.repeat(70);
  console.log(`\n${line}\n  STEM FOR IMPACT 2026 — live countdown server      build ${BUILD_ID}${DEV ? ' (dev)' : ''}`);
  console.log(`\n  Projector display : http://localhost:${PORT}/`);
  console.log(`  Organizer panel   : http://localhost:${PORT}/admin`);
  for (const ip of ips) console.log(`  On the same Wi-Fi : http://${ip}:${PORT}/  and  http://${ip}:${PORT}/admin`);
  console.log(`\n  Admin PIN         : ${ADMIN_PIN}   (set ADMIN_PIN env var or edit ${path.relative(ROOT, PIN_FILE) || PIN_FILE})`);
  console.log(`  Data folder       : ${DATA_DIR}`);
  console.log(`  Saved state       : ${recovery ? 'RECOVERY NEEDED — see organizer panel' : `${health.source}, rev ${state?.rev}`}\n${line}\n`);
});

let shuttingDown = false;
const shutdown = (sig: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (state) {
    const ok = persistNow();
    log(`${sig}: ${ok ? `state saved (rev ${state.rev})` : `!! FINAL SAVE FAILED: ${health.lastError}`}`);
  }
  for (const c of clients()) c.close(1001, 'Server shutting down');
  setTimeout(() => process.exit(0), 100).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
