/**
 * Shared, framework-free model used by BOTH the Node sync server and the browser
 * (local fallback mode). All timer math is timestamp based — nothing here counts ticks.
 */

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
export const SECOND = 1_000;
export const EVENT_DURATION_MS = 24 * HOUR;
export const EVENT_TIMEZONE = 'Asia/Kolkata';
export const STATE_SCHEMA = 2;

export const MAX_ANNOUNCEMENTS = 50;
export const MAX_ANNOUNCEMENT_LEN = 280;
export const MAX_TAGLINE_LEN = 120;

/**
 * Timer state machine
 *   ready ──start──▶ running ──pause──▶ paused ──resume──▶ running
 *   ready ──schedule──▶ scheduled ──(clock reaches startAt)──▶ running
 *   running ──(clock reaches endsAt)──▶ completed          (completedAt = endsAt)
 *   running/paused ──set remaining 0──▶ completed           (completedAt = now)
 *   completed ──set remaining / +time──▶ paused (same event, completedAt cleared)
 *   completed ──schedule──▶ scheduled (NEW session id: a new event)
 *   any ──reset──▶ ready (new session id)
 */
export type TimerStatus = 'ready' | 'scheduled' | 'running' | 'paused' | 'completed';
const STATUSES: TimerStatus[] = ['ready', 'scheduled', 'running', 'paused', 'completed'];

export interface TimerState {
  status: TimerStatus;
  durationMs: number;
  /** Epoch ms. Set while `scheduled` (and kept for reference afterwards). */
  scheduledStartAt: number | null;
  /** Epoch ms of the authoritative deadline. Only meaningful while `running`. */
  endsAt: number | null;
  /** Remaining ms when NOT running (ready / paused / completed). */
  remainingMs: number;
  /** When the current session first started running (info only). */
  startedAt: number | null;
  /** Epoch ms at which the event actually finished (deadline or manual). null unless completed. */
  completedAt: number | null;
  /** Identity of this event run. Milestone + end-sound bookkeeping is keyed by it. */
  sessionId: string;
  /** Bumped on every timer change (commands AND automatic transitions). Used to detect conflicts. */
  rev: number;
}

export interface Announcement {
  id: string;
  text: string;
  active: boolean;
  priority: boolean;
  createdAt: number;
  updatedAt: number;
}

export type TickerMode = 'scroll' | 'static';

export interface Settings {
  tickerMode: TickerMode;
  effects: boolean;
  sound: boolean;
  milestones: boolean;
  showProgress: boolean;
  tagline: string;
  /** Keeps branding, digits, announcements and final countdown; drops expensive decoration. */
  performance: boolean;
  /** CRT scanline texture (turn off for projectors that moiré). */
  scanlines: boolean;
  /** Softer digit glow for washed-out projectors. */
  reducedGlow: boolean;
  /** Projector simulations are only accepted while this is on (and the real event is not live). */
  rehearsal: boolean;
}

export interface Simulation {
  /** 'milestone' shows one overlay; 'final' runs a fake countdown from `fromMs`. */
  kind: 'milestone' | 'final';
  milestoneMs?: number;
  fromMs?: number;
  /** Server-clock epoch ms when the simulation started. */
  startedAt: number;
  id: string;
}

export interface AppState {
  schema: number;
  timer: TimerState;
  announcements: Announcement[];
  settings: Settings;
  simulation: Simulation | null;
  /** Monotonic revision, bumped on every mutation. */
  rev: number;
}

export const MILESTONES: { ms: number; title: string; subtitle: string }[] = [
  { ms: 12 * HOUR, title: '12 HOURS REMAINING', subtitle: 'Halfway to impact.' },
  { ms: 6 * HOUR, title: '6 HOURS REMAINING', subtitle: 'The home stretch begins.' },
  { ms: 3 * HOUR, title: '3 HOURS REMAINING', subtitle: 'Polish. Test. Perfect.' },
  { ms: 1 * HOUR, title: '1 HOUR REMAINING', subtitle: 'Final hour. Make it count.' },
  { ms: 30 * MINUTE, title: '30 MINUTES REMAINING', subtitle: 'Lock in your build.' },
  { ms: 10 * MINUTE, title: '10 MINUTES REMAINING', subtitle: 'Prepare your submissions.' },
];

export const simLifetime = (s: Pick<Simulation, 'kind' | 'fromMs'>) =>
  s.kind === 'milestone' ? 9_000 : (s.fromMs ?? 65_000) + 14_000;

export const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const DEFAULT_SETTINGS: Settings = {
  tickerMode: 'scroll',
  effects: true,
  sound: true,
  milestones: true,
  showProgress: true,
  tagline: 'Innovate. Build. Create Impact.',
  performance: false,
  scanlines: true,
  reducedGlow: false,
  rehearsal: false,
};

export function defaultState(): AppState {
  const now = Date.now();
  const mk = (text: string, active: boolean): Announcement => ({
    id: uid(), text, active, priority: false, createdAt: now, updatedAt: now,
  });
  return {
    schema: STATE_SCHEMA,
    rev: 1,
    timer: {
      status: 'ready',
      durationMs: EVENT_DURATION_MS,
      scheduledStartAt: null,
      endsAt: null,
      remainingMs: EVENT_DURATION_MS,
      startedAt: null,
      completedAt: null,
      sessionId: uid(),
      rev: 1,
    },
    // Only generic messages are live. Timetable items are INACTIVE drafts with placeholder times:
    // organizers must confirm the official times before publishing them.
    announcements: [
      mk('Welcome to STEM FOR IMPACT 2026!', true),
      mk('All teams, please remain at your assigned venues.', true),
      mk('[DRAFT – confirm time] Mentoring Round 1 begins at __:__.', false),
      mk('[DRAFT – confirm time] Lunch break: __:__ – __:__.', false),
      mk('[DRAFT – confirm time] Evaluation Round 1 begins at __:__.', false),
    ],
    settings: { ...DEFAULT_SETTINGS },
    simulation: null,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Pure: advance automatic transitions (scheduled → running, running → completed)
 * for a given clock reading. Returns the same object when nothing changes.
 */
export function resolveTimer(t: TimerState, now: number): TimerState {
  let s = t;
  if (s.status === 'scheduled' && s.scheduledStartAt != null && now >= s.scheduledStartAt) {
    // Deadline is anchored to the scheduled moment, not to when we noticed it.
    s = {
      ...s,
      status: 'running',
      endsAt: s.scheduledStartAt + s.durationMs,
      startedAt: s.scheduledStartAt,
    };
  }
  if (s.status === 'running' && s.endsAt != null && now >= s.endsAt) {
    s = { ...s, status: 'completed', remainingMs: 0, completedAt: s.endsAt };
  }
  if (s !== t) s = { ...s, rev: t.rev + 1 };
  return s;
}

/** Remaining ms, always within [0, durationMs]. */
export function remainingAt(t: TimerState, now: number): number {
  const r = resolveTimer(t, now);
  switch (r.status) {
    case 'running':
      return clamp((r.endsAt ?? now) - now, 0, r.durationMs);
    case 'scheduled':
      return r.durationMs;
    case 'completed':
      return 0;
    default:
      return clamp(r.remainingMs, 0, r.durationMs);
  }
}

export type Command =
  | { type: 'timer.start' }
  | { type: 'timer.schedule'; startAt: number }
  | { type: 'timer.cancelSchedule' }
  | { type: 'timer.pause' }
  | { type: 'timer.resume' }
  | { type: 'timer.reset' }
  | { type: 'timer.setRemaining'; ms: number }
  | { type: 'timer.adjust'; deltaMs: number }
  | { type: 'ann.add'; text: string; priority?: boolean; active?: boolean }
  | { type: 'ann.update'; id: string; patch: Partial<Pick<Announcement, 'text' | 'active' | 'priority'>> }
  | { type: 'ann.delete'; id: string }
  | { type: 'ann.move'; id: string; dir: -1 | 1 }
  | { type: 'settings.update'; patch: Partial<Settings> }
  | { type: 'sim.start'; kind: 'milestone' | 'final'; milestoneMs?: number; fromMs?: number }
  | { type: 'sim.stop' }
  /** Not a state change: the server relays it to displays, which report whether they could play it. */
  | { type: 'display.testSound' };

export const TIMER_COMMANDS = new Set([
  'timer.start', 'timer.schedule', 'timer.cancelSchedule', 'timer.pause', 'timer.resume',
  'timer.reset', 'timer.setRemaining', 'timer.adjust',
]);

export class CommandError extends Error {}

/**
 * Strict structural validation of an untrusted command object. Throws CommandError.
 * Returns a NEW object containing only known fields.
 */
export function validateCommand(raw: unknown): Command {
  if (!isObj(raw) || typeof raw.type !== 'string') throw new CommandError('Malformed command.');
  const str = (k: string, max: number) => {
    const v = raw[k];
    if (typeof v !== 'string' || v.length > max) throw new CommandError(`Invalid field "${k}".`);
    return v;
  };
  const num = (k: string) => {
    const v = raw[k];
    if (!isFiniteNum(v)) throw new CommandError(`Invalid field "${k}".`);
    return v;
  };
  const optBool = (o: Record<string, unknown>, k: string) => {
    if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new CommandError(`Invalid field "${k}".`);
    return o[k] as boolean | undefined;
  };
  switch (raw.type) {
    case 'timer.start': case 'timer.cancelSchedule': case 'timer.pause': case 'timer.resume':
    case 'timer.reset': case 'sim.stop': case 'display.testSound':
      return { type: raw.type };
    case 'timer.schedule': return { type: 'timer.schedule', startAt: num('startAt') };
    case 'timer.setRemaining': return { type: 'timer.setRemaining', ms: num('ms') };
    case 'timer.adjust': return { type: 'timer.adjust', deltaMs: num('deltaMs') };
    case 'ann.add': return {
      type: 'ann.add', text: str('text', 2000), priority: optBool(raw, 'priority'), active: optBool(raw, 'active'),
    };
    case 'ann.update': {
      const id = str('id', 64);
      if (!isObj(raw.patch)) throw new CommandError('Invalid field "patch".');
      const p = raw.patch;
      const patch: Partial<Pick<Announcement, 'text' | 'active' | 'priority'>> = {};
      if (p.text !== undefined) { if (typeof p.text !== 'string' || p.text.length > 2000) throw new CommandError('Invalid field "text".'); patch.text = p.text; }
      const a = optBool(p, 'active'); if (a !== undefined) patch.active = a;
      const pr = optBool(p, 'priority'); if (pr !== undefined) patch.priority = pr;
      return { type: 'ann.update', id, patch };
    }
    case 'ann.delete': return { type: 'ann.delete', id: str('id', 64) };
    case 'ann.move': {
      if (raw.dir !== -1 && raw.dir !== 1) throw new CommandError('Invalid field "dir".');
      return { type: 'ann.move', id: str('id', 64), dir: raw.dir };
    }
    case 'settings.update': {
      if (!isObj(raw.patch)) throw new CommandError('Invalid field "patch".');
      const p = raw.patch;
      const patch: Partial<Settings> = {};
      for (const [k, v] of Object.entries(p)) {
        if (!(k in DEFAULT_SETTINGS)) throw new CommandError(`Unknown setting "${k}".`);
        const expected = typeof DEFAULT_SETTINGS[k as keyof Settings];
        if (typeof v !== expected) throw new CommandError(`Invalid setting "${k}".`);
        if (k === 'tickerMode' && v !== 'scroll' && v !== 'static') throw new CommandError('Invalid ticker mode.');
        if (k === 'tagline' && (v as string).length > MAX_TAGLINE_LEN) throw new CommandError(`Tagline is longer than ${MAX_TAGLINE_LEN} characters.`);
        (patch as Record<string, unknown>)[k] = v;
      }
      return { type: 'settings.update', patch };
    }
    case 'sim.start': {
      if (raw.kind !== 'milestone' && raw.kind !== 'final') throw new CommandError('Invalid simulation kind.');
      if (raw.kind === 'milestone') return { type: 'sim.start', kind: 'milestone', milestoneMs: num('milestoneMs') };
      return { type: 'sim.start', kind: 'final', fromMs: raw.fromMs === undefined ? undefined : num('fromMs') };
    }
    default:
      throw new CommandError('Unknown command.');
  }
}

export interface ApplyOpts {
  /** Timer revision the organizer was looking at. Timer commands are rejected if it is stale. */
  baseTimerRev?: number;
}

/**
 * Pure reducer. Throws CommandError for invalid transitions so the caller can report
 * it to the organizer. Announcement / settings commands never touch `timer`.
 */
export function applyCommand(prev: AppState, cmd: Command, now: number, opts: ApplyOpts = {}): AppState {
  const state: AppState = { ...prev, timer: resolveTimer(prev.timer, now) };
  const t = state.timer;
  const next = (patch: Partial<AppState>): AppState => ({ ...state, ...patch, rev: prev.rev + 1 });
  const timer = (patch: Partial<TimerState>) => next({ timer: { ...t, ...patch, rev: t.rev + 1 } });

  if (TIMER_COMMANDS.has(cmd.type) && opts.baseTimerRev !== undefined && opts.baseTimerRev !== t.rev) {
    throw new CommandError('The timer was changed by another organizer (or started/finished automatically) since you looked. Check the current state and try again.');
  }

  switch (cmd.type) {
    case 'timer.start':
      if (t.status !== 'ready' && t.status !== 'scheduled')
        throw new CommandError(`Cannot start while ${t.status}. Reset first.`);
      return {
        ...timer({ status: 'running', endsAt: now + t.durationMs, startedAt: now, scheduledStartAt: null, completedAt: null }),
        simulation: null, // the real event always takes precedence
      };

    case 'timer.schedule': {
      if (t.status === 'running' || t.status === 'paused')
        throw new CommandError('Timer is active. Reset it before scheduling a new start.');
      if (!isFiniteNum(cmd.startAt)) throw new CommandError('Invalid start time.');
      if (cmd.startAt + t.durationMs <= now)
        throw new CommandError('That start time is more than 24 hours in the past — the event would already be over.');
      if (cmd.startAt > now + 60 * 24 * HOUR) throw new CommandError('Start time is more than 60 days away.');
      const scheduled: TimerState = {
        ...t,
        status: 'scheduled',
        scheduledStartAt: cmd.startAt,
        endsAt: null,
        remainingMs: t.durationMs,
        startedAt: null,
        completedAt: null,
        // A finished event must not share its identity with the next one (milestones/sound bookkeeping).
        sessionId: t.status === 'completed' ? uid() : t.sessionId,
        rev: t.rev + 1,
      };
      // If the start is in the past (but within 24h), resolve immediately into running.
      const resolved = resolveTimer(scheduled, now);
      return next({ timer: { ...resolved, rev: t.rev + 1 }, simulation: resolved.status === 'running' ? null : state.simulation });
    }

    case 'timer.cancelSchedule':
      if (t.status !== 'scheduled') throw new CommandError('Nothing is scheduled.');
      return timer({ status: 'ready', scheduledStartAt: null, remainingMs: t.durationMs });

    case 'timer.pause':
      if (t.status !== 'running') throw new CommandError('Timer is not running.');
      return timer({ status: 'paused', remainingMs: clamp((t.endsAt ?? now) - now, 0, t.durationMs), endsAt: null });

    case 'timer.resume':
      if (t.status !== 'paused') throw new CommandError('Timer is not paused.');
      if (t.remainingMs <= 0) return timer({ status: 'completed', remainingMs: 0, completedAt: now });
      return { ...timer({ status: 'running', endsAt: now + t.remainingMs, startedAt: t.startedAt ?? now }), simulation: null };

    case 'timer.reset':
      return {
        ...timer({
          status: 'ready', endsAt: null, scheduledStartAt: null, startedAt: null, completedAt: null,
          remainingMs: t.durationMs, sessionId: uid(),
        }),
      };

    case 'timer.setRemaining': {
      if (!isFiniteNum(cmd.ms) || cmd.ms < 0) throw new CommandError('Invalid duration.');
      const ms = clamp(Math.round(cmd.ms), 0, t.durationMs);
      return setRemaining(t, ms, now, timer);
    }

    case 'timer.adjust': {
      if (!isFiniteNum(cmd.deltaMs) || cmd.deltaMs === 0 || Math.abs(cmd.deltaMs) > t.durationMs)
        throw new CommandError('Invalid adjustment.');
      if (t.status === 'ready' || t.status === 'scheduled')
        throw new CommandError('The countdown has not started. Use "Set remaining time" or start it first.');
      const cur = remainingAt(t, now);
      const target = Math.round(cur + cmd.deltaMs);
      if (target <= 0)
        throw new CommandError('That adjustment would end the event. To end it, set the remaining time to 00:00:00 explicitly.');
      return setRemaining(t, clamp(target, 0, t.durationMs), now, timer);
    }

    case 'ann.add': {
      const text = String(cmd.text ?? '').trim();
      if (!text) throw new CommandError('Announcement text is empty.');
      if (text.length > MAX_ANNOUNCEMENT_LEN) throw new CommandError(`Announcement is longer than ${MAX_ANNOUNCEMENT_LEN} characters.`);
      if (state.announcements.length >= MAX_ANNOUNCEMENTS) throw new CommandError(`At most ${MAX_ANNOUNCEMENTS} announcements. Delete old ones first.`);
      const a: Announcement = {
        id: uid(), text, active: cmd.active ?? true, priority: !!cmd.priority, createdAt: now, updatedAt: now,
      };
      return next({ announcements: [...state.announcements, a] });
    }

    case 'ann.update': {
      if (!state.announcements.some((a) => a.id === cmd.id)) throw new CommandError('Announcement not found.');
      const p = cmd.patch ?? {};
      return next({
        announcements: state.announcements.map((a) => {
          if (a.id !== cmd.id) return a;
          const text = p.text !== undefined ? String(p.text).trim() : a.text;
          if (!text) throw new CommandError('Announcement text is empty.');
          if (text.length > MAX_ANNOUNCEMENT_LEN) throw new CommandError(`Announcement is longer than ${MAX_ANNOUNCEMENT_LEN} characters.`);
          return {
            ...a,
            text,
            active: p.active !== undefined ? !!p.active : a.active,
            priority: p.priority !== undefined ? !!p.priority : a.priority,
            updatedAt: now,
          };
        }),
      });
    }

    case 'ann.delete':
      if (!state.announcements.some((a) => a.id === cmd.id)) throw new CommandError('Announcement not found (already deleted?).');
      return next({ announcements: state.announcements.filter((a) => a.id !== cmd.id) });

    case 'ann.move': {
      const list = [...state.announcements];
      const i = list.findIndex((a) => a.id === cmd.id);
      const j = i + (cmd.dir === -1 ? -1 : 1);
      if (i < 0) throw new CommandError('Announcement not found.');
      if (j < 0 || j >= list.length) return prev;
      [list[i], list[j]] = [list[j], list[i]];
      return next({ announcements: list });
    }

    case 'settings.update': {
      const p = cmd.patch ?? {};
      const s = { ...state.settings };
      if (p.tickerMode === 'scroll' || p.tickerMode === 'static') s.tickerMode = p.tickerMode;
      for (const k of ['effects', 'sound', 'milestones', 'showProgress', 'performance', 'scanlines', 'reducedGlow', 'rehearsal'] as const)
        if (typeof p[k] === 'boolean') s[k] = p[k] as boolean;
      if (typeof p.tagline === 'string') {
        if (p.tagline.length > MAX_TAGLINE_LEN) throw new CommandError(`Tagline is longer than ${MAX_TAGLINE_LEN} characters.`);
        s.tagline = p.tagline.trim();
      }
      // Leaving rehearsal mode immediately ends any projector simulation.
      return next({ settings: s, simulation: s.rehearsal ? state.simulation : null });
    }

    case 'sim.start': {
      if (!state.settings.rehearsal)
        throw new CommandError('Projector simulations need Rehearsal mode. Use "Preview here" to rehearse without touching the projector.');
      if (t.status === 'running' || t.status === 'paused')
        throw new CommandError('The real countdown is live. Projector simulations are disabled — use "Preview here" instead.');
      if (t.status === 'completed')
        throw new CommandError('The real event has finished; its result stays on the projector. Reset first to rehearse again.');
      let sim: Simulation;
      if (cmd.kind === 'milestone') {
        if (!MILESTONES.some((m) => m.ms === cmd.milestoneMs)) throw new CommandError('Unknown milestone.');
        sim = { kind: 'milestone', milestoneMs: cmd.milestoneMs, startedAt: now, id: uid() };
      } else {
        const fromMs = clamp(isFiniteNum(cmd.fromMs) ? cmd.fromMs : 65 * SECOND, 5 * SECOND, 10 * MINUTE);
        sim = { kind: 'final', fromMs, startedAt: now, id: uid() };
      }
      if (t.status === 'scheduled' && t.scheduledStartAt != null && t.scheduledStartAt - now < simLifetime(sim) + 60 * SECOND)
        throw new CommandError('The real event starts too soon to run this simulation.');
      return next({ simulation: sim });
    }

    case 'sim.stop':
      if (!state.simulation) return prev;
      return next({ simulation: null });

    case 'display.testSound':
      return prev;

    default:
      throw new CommandError('Unknown command.');
  }
}

function setRemaining(t: TimerState, ms: number, now: number, timer: (p: Partial<TimerState>) => AppState): AppState {
  if (t.status === 'scheduled') throw new CommandError('Cancel the schedule before adjusting time.');
  if (t.status === 'running') {
    if (ms === 0) return timer({ status: 'completed', remainingMs: 0, endsAt: null, completedAt: now });
    return timer({ endsAt: now + ms });
  }
  // ready / paused / completed → paused with the new remaining time (organizer resumes explicitly).
  // From `completed` this EXTENDS the same event (same session); completion is cleared.
  return timer({
    status: ms === 0 ? 'completed' : 'paused',
    remainingMs: ms,
    endsAt: null,
    completedAt: ms === 0 ? now : null,
  });
}

// ---------------------------------------------------------------------------------------------
// Persistence validation
// ---------------------------------------------------------------------------------------------

export type ValidationResult = { ok: true; state: AppState; migrated: boolean } | { ok: false; errors: string[] };

/**
 * Strictly validate a state loaded from disk / storage. Never silently replaces damaged data with
 * defaults: anything structurally wrong is reported so the caller can preserve it and recover.
 * Fields added in later versions (schema 1 → 2) are filled in with defaults (`migrated: true`).
 */
export function validateState(raw: unknown): ValidationResult {
  const errors: string[] = [];
  let migrated = false;
  if (!isObj(raw)) return { ok: false, errors: ['State is not a JSON object.'] };
  if (raw.schema !== undefined && raw.schema !== 1 && raw.schema !== STATE_SCHEMA) errors.push(`Unknown schema version ${String(raw.schema)}.`);
  if (raw.schema !== STATE_SCHEMA) migrated = true;
  if (!isFiniteNum(raw.rev) || raw.rev < 0 || !Number.isInteger(raw.rev)) errors.push('rev must be a non-negative integer.');

  // ---- timer
  const t = raw.timer;
  let timer: TimerState | null = null;
  if (!isObj(t)) errors.push('timer is missing.');
  else {
    const e0 = errors.length;
    const nullableNum = (k: string) => t[k] === null || t[k] === undefined || isFiniteNum(t[k]);
    if (!STATUSES.includes(t.status as TimerStatus)) errors.push('timer.status is invalid.');
    if (t.durationMs !== EVENT_DURATION_MS) errors.push('timer.durationMs must be 24 hours.');
    if (!isFiniteNum(t.remainingMs) || t.remainingMs < 0 || t.remainingMs > EVENT_DURATION_MS) errors.push('timer.remainingMs is out of range.');
    for (const k of ['scheduledStartAt', 'endsAt', 'startedAt', 'completedAt']) if (!nullableNum(k)) errors.push(`timer.${k} is invalid.`);
    if (typeof t.sessionId !== 'string' || !t.sessionId || t.sessionId.length > 64) errors.push('timer.sessionId is invalid.');
    if (t.status === 'running' && !isFiniteNum(t.endsAt)) errors.push('Running timer has no deadline.');
    if (t.status === 'running' && isFiniteNum(t.endsAt) && isFiniteNum(t.startedAt) && t.endsAt - t.startedAt > 3 * EVENT_DURATION_MS)
      errors.push('Running deadline is implausible.');
    if (t.status === 'scheduled' && !isFiniteNum(t.scheduledStartAt)) errors.push('Scheduled timer has no start time.');
    if (t.rev !== undefined && (!isFiniteNum(t.rev) || t.rev < 0)) errors.push('timer.rev is invalid.');
    if (t.rev === undefined || t.completedAt === undefined) migrated = true;
    if (errors.length === e0) {
      timer = {
        status: t.status as TimerStatus,
        durationMs: EVENT_DURATION_MS,
        scheduledStartAt: (t.scheduledStartAt as number | null) ?? null,
        endsAt: (t.endsAt as number | null) ?? null,
        remainingMs: t.remainingMs as number,
        startedAt: (t.startedAt as number | null) ?? null,
        completedAt: (t.completedAt as number | null) ?? (t.status === 'completed' ? (t.endsAt as number | null) ?? null : null),
        sessionId: t.sessionId as string,
        rev: (t.rev as number | undefined) ?? 1,
      };
    }
  }

  // ---- announcements
  const anns: Announcement[] = [];
  if (!Array.isArray(raw.announcements)) errors.push('announcements must be a list.');
  else {
    if (raw.announcements.length > MAX_ANNOUNCEMENTS * 2) errors.push('Too many announcements.');
    const ids = new Set<string>();
    raw.announcements.forEach((a: unknown, i: number) => {
      if (!isObj(a)) { errors.push(`announcement #${i + 1} is not an object.`); return; }
      if (typeof a.id !== 'string' || !a.id || a.id.length > 64 || ids.has(a.id)) { errors.push(`announcement #${i + 1} has a missing or duplicate id.`); return; }
      if (typeof a.text !== 'string' || !a.text.trim() || a.text.length > MAX_ANNOUNCEMENT_LEN) { errors.push(`announcement #${i + 1} text is invalid.`); return; }
      if (typeof a.active !== 'boolean' || typeof a.priority !== 'boolean') { errors.push(`announcement #${i + 1} flags are invalid.`); return; }
      if (!isFiniteNum(a.createdAt) || !isFiniteNum(a.updatedAt)) { errors.push(`announcement #${i + 1} timestamps are invalid.`); return; }
      ids.add(a.id);
      anns.push({ id: a.id, text: a.text, active: a.active, priority: a.priority, createdAt: a.createdAt, updatedAt: a.updatedAt });
    });
  }

  // ---- settings
  const settings: Settings = { ...DEFAULT_SETTINGS };
  if (!isObj(raw.settings)) errors.push('settings are missing.');
  else {
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = raw.settings[k];
      if (v === undefined) { migrated = true; continue; }
      if (typeof v !== typeof DEFAULT_SETTINGS[k]) { errors.push(`settings.${k} has the wrong type.`); continue; }
      (settings as unknown as Record<string, unknown>)[k] = v;
    }
    if (settings.tickerMode !== 'scroll' && settings.tickerMode !== 'static') errors.push('settings.tickerMode is invalid.');
    if (settings.tagline.length > MAX_TAGLINE_LEN) errors.push('settings.tagline is too long.');
  }

  if (errors.length || !timer) return { ok: false, errors: errors.length ? errors : ['timer is invalid.'] };
  return {
    ok: true,
    migrated,
    state: { schema: STATE_SCHEMA, rev: raw.rev as number, timer, announcements: anns, settings, simulation: null },
  };
}

/** Durable part of the state (simulations are never persisted). */
export const durableState = (s: AppState) => {
  const { simulation: _sim, ...durable } = s;
  return durable;
};

// ---------------------------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------------------------

export type Role = 'display' | 'admin' | 'preview';
export type AudioStatus = 'ready' | 'blocked' | 'unsupported' | 'unknown';

export interface PersistenceHealth {
  /** ok: last save succeeded; failing: saves are failing (changes only in memory); recovery: restore needed */
  status: 'ok' | 'failing' | 'recovery';
  lastSavedAt: number | null;
  /** Revision that is safely on disk. */
  savedRev: number | null;
  lastError: string | null;
  /** How the state was obtained at startup. */
  source: 'fresh' | 'restored' | 'backup' | 'cache-offer' | 'manual-fresh' | 'none';
  notes: string[];
}

export interface DisplayInfo {
  id: string;
  role: Role;
  ip: string;
  connectedAt: number;
  ackRev: number | null;
  ackAt: number | null;
  audio: AudioStatus;
  visible: boolean;
  fullscreen: boolean;
  viewport: string;
  build: string;
  soundTest?: { id: string; ok: boolean; at: number };
}

export interface ServerInfo {
  build: string;
  buildMatches: boolean;
  health: PersistenceHealth;
  displays: DisplayInfo[];
  recovery: RecoveryInfo | null;
}

export interface RecoveryInfo {
  reason: string;
  preservedFiles: string[];
  offers: { rev: number; status: TimerStatus; endsAt: number | null; remainingMs: number; announcements: number; from: string }[];
}

export type ServerMsg =
  | { type: 'state'; state: AppState; serverNow: number }
  | { type: 'pong'; clientSent: number; serverNow: number }
  | { type: 'auth'; ok: boolean; error?: string; retryAfterMs?: number }
  | { type: 'result'; reqId: string; cmdId?: string; ok: boolean; error?: string; applied?: boolean; saved?: boolean; rev?: number; duplicate?: boolean }
  | { type: 'info'; info: ServerInfo }
  | { type: 'recovery'; reason: string; serverNow: number }
  | { type: 'testSound'; id: string }
  | { type: 'error'; error: string };

export type ClientMsg =
  | { type: 'hello'; role: Role; clientId?: string; build?: string }
  | { type: 'ping'; clientSent: number }
  | { type: 'auth'; pin: string }
  | { type: 'cmd'; reqId: string; cmdId?: string; baseTimerRev?: number; cmd: Command }
  | { type: 'ack'; rev: number; audio?: AudioStatus; visible?: boolean; fullscreen?: boolean; viewport?: string; soundTest?: { id: string; ok: boolean } }
  | { type: 'cacheOffer'; state: unknown }
  | { type: 'recovery.adopt'; reqId: string; rev: number }
  | { type: 'recovery.fresh'; reqId: string; confirm: string };

const ROLES: Role[] = ['display', 'admin', 'preview'];
const AUDIO: AudioStatus[] = ['ready', 'blocked', 'unsupported', 'unknown'];

/**
 * Validate the complete envelope of an untrusted client message BEFORE any property is used.
 * Returns an error string for anything malformed.
 */
export function parseClientMsg(text: string): { ok: true; msg: ClientMsg } | { ok: false; error: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'Invalid JSON.' }; }
  if (!isObj(raw)) return { ok: false, error: 'Message must be a JSON object.' };
  if (typeof raw.type !== 'string') return { ok: false, error: 'Message has no type.' };
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 64;
  switch (raw.type) {
    case 'hello':
      if (!ROLES.includes(raw.role as Role)) return { ok: false, error: 'Invalid role.' };
      if (raw.clientId !== undefined && !id(raw.clientId)) return { ok: false, error: 'Invalid clientId.' };
      if (raw.build !== undefined && (typeof raw.build !== 'string' || raw.build.length > 64)) return { ok: false, error: 'Invalid build.' };
      return { ok: true, msg: { type: 'hello', role: raw.role as Role, clientId: raw.clientId as string | undefined, build: raw.build as string | undefined } };
    case 'ping':
      if (!isFiniteNum(raw.clientSent)) return { ok: false, error: 'Invalid ping.' };
      return { ok: true, msg: { type: 'ping', clientSent: raw.clientSent } };
    case 'auth':
      if (typeof raw.pin !== 'string' || raw.pin.length > 32) return { ok: false, error: 'Invalid PIN format.' };
      return { ok: true, msg: { type: 'auth', pin: raw.pin } };
    case 'cmd': {
      if (!id(raw.reqId)) return { ok: false, error: 'Invalid reqId.' };
      if (raw.cmdId !== undefined && !id(raw.cmdId)) return { ok: false, error: 'Invalid cmdId.' };
      if (raw.baseTimerRev !== undefined && (!isFiniteNum(raw.baseTimerRev) || raw.baseTimerRev < 0)) return { ok: false, error: 'Invalid baseTimerRev.' };
      if (!isObj(raw.cmd)) return { ok: false, error: 'Missing command.' };
      return { ok: true, msg: { type: 'cmd', reqId: raw.reqId as string, cmdId: raw.cmdId as string | undefined, baseTimerRev: raw.baseTimerRev as number | undefined, cmd: raw.cmd as unknown as Command } };
    }
    case 'ack': {
      if (!isFiniteNum(raw.rev)) return { ok: false, error: 'Invalid ack.' };
      if (raw.audio !== undefined && !AUDIO.includes(raw.audio as AudioStatus)) return { ok: false, error: 'Invalid audio status.' };
      if (raw.viewport !== undefined && (typeof raw.viewport !== 'string' || raw.viewport.length > 32)) return { ok: false, error: 'Invalid viewport.' };
      let soundTest: { id: string; ok: boolean } | undefined;
      if (raw.soundTest !== undefined) {
        if (!isObj(raw.soundTest) || !id(raw.soundTest.id) || typeof raw.soundTest.ok !== 'boolean') return { ok: false, error: 'Invalid soundTest.' };
        soundTest = { id: raw.soundTest.id as string, ok: raw.soundTest.ok };
      }
      return {
        ok: true, msg: {
          type: 'ack', rev: raw.rev, audio: raw.audio as AudioStatus | undefined,
          visible: raw.visible === undefined ? undefined : !!raw.visible,
          fullscreen: raw.fullscreen === undefined ? undefined : !!raw.fullscreen,
          viewport: raw.viewport as string | undefined, soundTest,
        },
      };
    }
    case 'cacheOffer':
      return { ok: true, msg: { type: 'cacheOffer', state: raw.state } };
    case 'recovery.adopt':
      if (!id(raw.reqId) || !isFiniteNum(raw.rev)) return { ok: false, error: 'Invalid recovery.adopt.' };
      return { ok: true, msg: { type: 'recovery.adopt', reqId: raw.reqId as string, rev: raw.rev } };
    case 'recovery.fresh':
      if (!id(raw.reqId) || typeof raw.confirm !== 'string') return { ok: false, error: 'Invalid recovery.fresh.' };
      return { ok: true, msg: { type: 'recovery.fresh', reqId: raw.reqId as string, confirm: raw.confirm } };
    default:
      return { ok: false, error: 'Unknown message type.' };
  }
}
