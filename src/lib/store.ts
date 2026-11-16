/**
 * Client sync store.
 *
 * REMOTE mode (always the default): WebSocket to /ws. The server is the authoritative clock and
 * state. If it cannot be reached we keep retrying forever and keep counting from the last cached
 * deadline — we never fork into local state on our own.
 *
 * LOCAL mode (explicit choice only: `?local=1` or the "Use local mode" button): no server.
 * State lives in this browser's localStorage and is shared between tabs of the SAME browser only.
 * Local and remote state are stored under different keys and are never merged.
 */
import { useSyncExternalStore } from 'react';
import {
  applyCommand, CommandError, defaultState, uid, validateCommand, validateState,
  type AppState, type AudioStatus, type ClientMsg, type Command, type ServerInfo, type ServerMsg,
} from '../shared/model';

export type Mode = 'remote' | 'local';
export type Conn = 'connecting' | 'online' | 'offline' | 'recovery';

export interface Snapshot {
  mode: Mode;
  conn: Conn;
  state: AppState | null;
  /** True when `state` came from this device's cache and has not been confirmed by the server yet. */
  fromCache: boolean;
  offset: number;
  authed: boolean;
  authPending: boolean;
  authError: string | null;
  lastSyncAt: number | null;
  offlineSince: number | null;
  info: ServerInfo | null;
  recoveryReason: string | null;
  pendingCount: number;
  /** A PIN is remembered for this tab: after a reconnect we sign in again automatically. */
  pinSaved: boolean;
}

declare const __BUILD_ID__: string;
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

const CACHE_KEY = 'sfi.cache.v2';
const LOCAL_KEY = 'sfi.local.state.v2';
const PIN_KEY = 'sfi.admin.pin';
const CLIENT_ID_KEY = 'sfi.client.id';

const store = (s: Storage | undefined) => ({
  get: (k: string) => { try { return s?.getItem(k) ?? null; } catch { return null; } },
  set: (k: string, v: string) => { try { s?.setItem(k, v); } catch { /* ignore */ } },
  del: (k: string) => { try { s?.removeItem(k); } catch { /* ignore */ } },
});
const ls = store(typeof localStorage !== 'undefined' ? localStorage : undefined);
const ss = store(typeof sessionStorage !== 'undefined' ? sessionStorage : undefined);

export const isLocalRequested = () => typeof location !== 'undefined' && new URLSearchParams(location.search).has('local');
/** Append the current mode to an internal link so display/admin links keep the chosen mode. */
export const withMode = (href: string) => (snap.mode === 'local' ? `${href}${href.includes('?') ? '&' : '?'}local=1` : href);

let snap: Snapshot = {
  mode: isLocalRequested() ? 'local' : 'remote', conn: 'connecting', state: null, fromCache: false, offset: 0,
  authed: false, authPending: false, authError: null, lastSyncAt: null, offlineSince: null, info: null,
  recoveryReason: null, pendingCount: 0, pinSaved: !!ss.get(PIN_KEY),
};
const listeners = new Set<() => void>();
function set(patch: Partial<Snapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}
export const getSnapshot = () => snap;
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useStore<T>(sel: (s: Snapshot) => T): T {
  return useSyncExternalStore(subscribe, () => sel(snap));
}

/** Authoritative "now" (server clock in remote mode). */
export const serverNow = () => Date.now() + snap.offset;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
/**
 * Keep object identity for unchanged slices so a timer change does not re-render the ticker,
 * an announcement edit does not restart the clock, and an identical re-send changes nothing.
 */
function share(prev: AppState | null, next: AppState): AppState {
  if (!prev) return next;
  const timer = same(prev.timer, next.timer) ? prev.timer : next.timer;
  const settings = same(prev.settings, next.settings) ? prev.settings : next.settings;
  const simulation = same(prev.simulation, next.simulation) ? prev.simulation : next.simulation;
  let announcements = next.announcements;
  if (same(prev.announcements, next.announcements)) announcements = prev.announcements;
  else {
    const byId = new Map(prev.announcements.map((a) => [a.id, a]));
    announcements = next.announcements.map((a) => { const p = byId.get(a.id); return p && same(p, a) ? p : a; });
  }
  if (prev.rev === next.rev && timer === prev.timer && settings === prev.settings && simulation === prev.simulation && announcements === prev.announcements) return prev;
  return { ...next, timer, settings, simulation, announcements };
}

// ---------- remote ----------
let ws: WebSocket | null = null;
let role: 'display' | 'admin' | 'preview' = 'display';
let retry = 0;
let reconnectTimer: number | undefined;
let pingTimer: number | undefined;
let watchdog: number | undefined;
let lastMsgAt = 0;
let bestRtt = Infinity;
const STALE_MS = 12_000;

interface Pending { reqId: string; cmdId: string; msg: ClientMsg; resolve: (r: CmdResult) => void; timer: number; sentOn: WebSocket | null }
const pending = new Map<string, Pending>();
export interface CmdResult { ok: boolean; error?: string; saved?: boolean; unknown?: boolean; applied?: boolean; duplicate?: boolean }

function wsSend(m: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(m)); return true; }
  return false;
}
function ping() { wsSend({ type: 'ping', clientSent: Date.now() }); }

const clientId = (() => {
  let id = ss.get(CLIENT_ID_KEY);
  if (!id) { id = uid(); ss.set(CLIENT_ID_KEY, id); }
  return id;
})();

function markOffline() {
  if (snap.conn === 'offline') return;
  set({ conn: 'offline', authed: false, authPending: false, offlineSince: snap.offlineSince ?? Date.now() });
}

function connect() {
  clearTimeout(reconnectTimer);
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  if (snap.conn !== 'offline' && snap.conn !== 'recovery') set({ conn: 'connecting' });
  let sock: WebSocket;
  try { sock = new WebSocket(url); } catch { return scheduleReconnect(); }
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    bestRtt = Infinity;
    lastMsgAt = Date.now();
    sock.send(JSON.stringify({ type: 'hello', role, clientId, build: BUILD_ID } satisfies ClientMsg));
    for (let i = 0; i < 4; i++) setTimeout(ping, 150 + i * 300);
    clearInterval(pingTimer);
    pingTimer = window.setInterval(ping, 4_000);
    const pin = ss.get(PIN_KEY);
    if (role === 'admin' && pin) { set({ authPending: true }); wsSend({ type: 'auth', pin }); }
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    lastMsgAt = Date.now();
    let m: ServerMsg;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'state': {
        const v = validateState(m.state);
        if (!v.ok) { console.error('Ignoring invalid state from server', v.errors); return; }
        const offset = bestRtt === Infinity ? m.serverNow - Date.now() : snap.offset;
        const next = share(snap.fromCache ? null : snap.state, { ...v.state, simulation: m.state.simulation ?? null });
        set({ state: next, fromCache: false, conn: 'online', lastSyncAt: Date.now(), offset, offlineSince: null, recoveryReason: null });
        ls.set(CACHE_KEY, JSON.stringify({ state: next, offset }));
        queueAck();
        // After a reconnect, re-send commands whose acknowledgement was lost (same cmdId → no double-apply).
        if (role !== 'admin' || snap.authed) flushPending();
        return;
      }
      case 'recovery':
        set({ conn: 'recovery', recoveryReason: m.reason, offlineSince: null });
        if (snap.state) wsSend({ type: 'cacheOffer', state: snap.state });
        return;
      case 'pong': {
        const now = Date.now();
        const rtt = now - m.clientSent;
        if (rtt <= bestRtt * 1.2 || rtt < 50) {
          bestRtt = Math.min(rtt, bestRtt);
          const offset = m.serverNow + rtt / 2 - now;
          if (Math.abs(offset - snap.offset) > 2 || snap.conn !== 'online') set({ offset, lastSyncAt: now, conn: snap.conn === 'recovery' ? 'recovery' : 'online' });
        }
        bestRtt *= 1.05;
        return;
      }
      case 'auth':
        if (!m.ok && !m.retryAfterMs) ss.del(PIN_KEY);
        set({ authed: m.ok, authPending: false, authError: m.ok ? null : m.error ?? 'Authentication failed.', pinSaved: !!ss.get(PIN_KEY) });
        if (m.ok) flushPending();
        return;
      case 'info':
        set({ info: m.info });
        return;
      case 'result': {
        const p = pending.get(m.reqId);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(m.reqId);
        set({ pendingCount: pending.size });
        p.resolve({ ok: m.ok, error: m.error, saved: m.saved, applied: m.applied, duplicate: m.duplicate });
        return;
      }
      case 'testSound':
        testSoundHandler?.(m.id);
        return;
      case 'error':
        console.warn('Server:', m.error);
        return;
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(pingTimer);
    markOffline();
    scheduleReconnect();
  };
  sock.onerror = () => sock.close();
}

function scheduleReconnect() {
  retry++;
  const delay = Math.min(5000, 400 * 2 ** Math.min(retry, 4)) * (0.8 + Math.random() * 0.4);
  clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, delay);
}

/** A socket that delivers nothing for STALE_MS is treated as dead (Wi-Fi drops often never close TCP). */
function startWatchdog() {
  clearInterval(watchdog);
  watchdog = window.setInterval(() => {
    if (snap.mode !== 'remote' || !ws) return;
    if (ws.readyState === WebSocket.OPEN && Date.now() - lastMsgAt > STALE_MS) {
      const dead = ws;
      ws = null;
      try { dead.close(); } catch { /* ignore */ }
      clearInterval(pingTimer);
      markOffline();
      scheduleReconnect();
    }
  }, 1_000);
  const wake = () => { if (document.visibilityState === 'visible' && snap.mode === 'remote' && !ws) { retry = 0; connect(); } };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
}

// ---------- display acknowledgements ----------
type AckExtras = () => { audio: AudioStatus; fullscreen: boolean };
let ackExtras: AckExtras | null = null;
let ackQueued = false;
let soundTestResult: { id: string; ok: boolean } | undefined;
let testSoundHandler: ((id: string) => void) | null = null;
export const setAckExtras = (f: AckExtras) => { ackExtras = f; };
export const onTestSound = (h: (id: string) => void) => { testSoundHandler = h; };
export function reportSoundTest(id: string, ok: boolean) { soundTestResult = { id, ok }; queueAck(true); }

/** Sent after the browser has actually painted the revision (two animation frames). */
export function queueAck(force = false) {
  if (role !== 'display' || snap.mode !== 'remote' || (ackQueued && !force)) return;
  ackQueued = true;
  const done = () => {
    ackQueued = false;
    const st = snap.state;
    if (!st) return;
    const extra = ackExtras?.() ?? { audio: 'unknown' as AudioStatus, fullscreen: false };
    wsSend({
      type: 'ack', rev: st.rev, audio: extra.audio, fullscreen: extra.fullscreen,
      visible: document.visibilityState === 'visible', viewport: `${innerWidth}×${innerHeight}`, soundTest: soundTestResult,
    });
  };
  // Hidden tabs do not run rAF; acknowledge from a timer so the organizer still sees "received (hidden)".
  if (document.visibilityState === 'visible') requestAnimationFrame(() => requestAnimationFrame(done));
  else setTimeout(done, 50);
}

// ---------- local ----------
let channel: BroadcastChannel | null = null;
function loadLocal(): AppState {
  const raw = ls.get(LOCAL_KEY);
  if (!raw) return defaultState();
  try {
    const v = validateState(JSON.parse(raw));
    if (v.ok) return v.state;
  } catch { /* fall through */ }
  ls.set(`${LOCAL_KEY}.damaged-${Date.now()}`, raw);
  return defaultState();
}
function startLocal() {
  const st = loadLocal();
  set({ mode: 'local', conn: 'online', state: st, offset: 0, authed: true, lastSyncAt: Date.now() });
  try {
    channel = new BroadcastChannel('sfi-local');
    channel.onmessage = (e) => set({ state: share(snap.state, e.data as AppState), lastSyncAt: Date.now() });
  } catch { /* old browser: storage event still works */ }
  window.addEventListener('storage', (e) => {
    if (e.key === LOCAL_KEY && e.newValue) {
      try {
        const v = validateState(JSON.parse(e.newValue));
        if (v.ok) set({ state: share(snap.state, { ...v.state, simulation: snap.state?.simulation ?? null }) });
      } catch { /* ignore */ }
    }
  });
}

// ---------- public API ----------
let started = false;
export function initStore(r: 'display' | 'admin' | 'preview') {
  if (started) return;
  started = true;
  role = r;
  if (snap.mode === 'local') return startLocal();
  const cached = ls.get(CACHE_KEY);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      const v = validateState(c.state);
      if (v.ok) set({ state: v.state, fromCache: true, offset: Number(c.offset) || 0 });
    } catch { /* ignore */ }
  }
  connect();
  startWatchdog();
}

/** Explicit, organizer-chosen switch to local mode (reloads with ?local=1). */
export function switchToLocalMode() {
  const u = new URL(location.href);
  u.searchParams.set('local', '1');
  location.href = u.toString();
}
export function switchToServerMode() {
  const u = new URL(location.href);
  u.searchParams.delete('local');
  location.href = u.toString();
}

export function login(pin: string) {
  const p = pin.trim();
  ss.set(PIN_KEY, p);
  set({ authError: null, authPending: true, pinSaved: true });
  if (!wsSend({ type: 'auth', pin: p })) set({ authPending: false, authError: 'Not connected to the event server.' });
}
export function logout() {
  ss.del(PIN_KEY);
  set({ authed: false, pinSaved: false });
  ws?.close();
}

function flushPending() {
  for (const p of pending.values()) {
    if (p.sentOn !== ws && ws?.readyState === WebSocket.OPEN) {
      p.sentOn = ws;
      wsSend(p.msg);
    }
  }
}

const CMD_TIMEOUT = 10_000;

/**
 * Send an organizer command. Each logical action has ONE cmdId: if the connection drops before
 * the result arrives, it is re-sent after reconnect and the server returns the original outcome
 * instead of applying it twice. If no result arrives in time the outcome is reported as UNKNOWN.
 */
export function send(cmd: Command, opts: { baseTimerRev?: number } = {}): Promise<CmdResult> {
  if (snap.mode === 'local') {
    try {
      const cur = snap.state ?? loadLocal();
      const next = applyCommand(cur, validateCommand(cmd), Date.now(), opts);
      if (next !== cur) {
        ls.set(LOCAL_KEY, JSON.stringify({ ...next, simulation: null }));
        set({ state: next, lastSyncAt: Date.now() });
        channel?.postMessage(next);
      }
      return Promise.resolve({ ok: true, saved: true, applied: next !== cur });
    } catch (e) {
      return Promise.resolve({ ok: false, error: e instanceof CommandError ? e.message : 'Error' });
    }
  }
  if (!ws || ws.readyState !== WebSocket.OPEN || !snap.authed)
    return Promise.resolve({ ok: false, error: 'Not connected to the event server — nothing was sent.' });
  const reqId = uid();
  const cmdId = uid() + uid();
  const msg: ClientMsg = { type: 'cmd', reqId, cmdId, baseTimerRev: opts.baseTimerRev, cmd };
  return new Promise((resolve) => {
    const p: Pending = {
      reqId, cmdId, msg, resolve, sentOn: ws,
      timer: window.setTimeout(() => {
        pending.delete(reqId);
        set({ pendingCount: pending.size });
        resolve({ ok: false, unknown: true, error: 'No reply from the server. The action MAY have been applied — check the live state before trying again.' });
      }, CMD_TIMEOUT),
    };
    pending.set(reqId, p);
    set({ pendingCount: pending.size });
    wsSend(msg);
  });
}

export function sendRecovery(m: { type: 'recovery.adopt'; rev: number } | { type: 'recovery.fresh'; confirm: string }): Promise<CmdResult> {
  const reqId = uid();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => { pending.delete(reqId); resolve({ ok: false, unknown: true, error: 'No reply from the server.' }); }, CMD_TIMEOUT);
    pending.set(reqId, { reqId, cmdId: reqId, msg: { ...m, reqId } as ClientMsg, resolve, timer, sentOn: ws });
    if (!wsSend({ ...m, reqId } as ClientMsg)) { clearTimeout(timer); pending.delete(reqId); resolve({ ok: false, error: 'Not connected.' }); }
  });
}

const NO_DISPLAYS: ServerInfo['displays'] = [];
/** Connected projector/display screens (excludes previews and admins). Stable identity when unchanged. */
export function useDisplays() {
  const all = useStore((s) => s.info?.displays ?? NO_DISPLAYS);
  return all;
}
