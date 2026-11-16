/**
 * Pure model tests (no server, no browser). Run: npm run test:unit
 */
import {
  applyCommand, defaultState, durableState, parseClientMsg, remainingAt, resolveTimer, validateCommand, validateState,
  CommandError, HOUR, MINUTE, SECOND, type AppState, type Command,
} from '../src/shared/model';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const throws = (f: () => unknown) => { try { f(); return false; } catch (e) { return e instanceof CommandError; } };
const T0 = Date.UTC(2026, 10, 17, 4, 30); // 17 Nov 2026 10:00 IST
const apply = (s: AppState, c: Command, now: number, o = {}) => applyCommand(s, validateCommand(c), now, o);

console.log('\nDefaults');
{
  const d = defaultState();
  const drafts = d.announcements.filter((a) => /mentoring|lunch|evaluation/i.test(a.text));
  check('timetable samples are inactive drafts', drafts.length === 3 && drafts.every((a) => !a.active && /DRAFT/.test(a.text)));
  check('no invented times are published', d.announcements.filter((a) => a.active).every((a) => !/\d{1,2}:\d{2}/.test(a.text)));
  check('default state validates', validateState(JSON.parse(JSON.stringify(durableState(d)))).ok);
}

console.log('\nCompletion & session identity');
{
  let s = apply(defaultState(), { type: 'timer.start' }, T0);
  const sid = s.timer.sessionId;
  const r = resolveTimer(s.timer, T0 + 24 * HOUR + 5);
  check('deadline completion records completedAt = endsAt', r.status === 'completed' && r.completedAt === T0 + 24 * HOUR);
  s = { ...s, timer: r };
  s = apply(s, { type: 'timer.setRemaining', ms: 10 * MINUTE }, T0 + 24 * HOUR + 60_000);
  check('extend after completion → paused, same event, completion cleared', s.timer.status === 'paused' && s.timer.sessionId === sid && s.timer.completedAt === null);
  s = apply(s, { type: 'timer.resume' }, T0 + 25 * HOUR);
  s = apply(s, { type: 'timer.setRemaining', ms: 0 }, T0 + 25 * HOUR + 1000);
  check('manual end records completedAt = now', s.timer.status === 'completed' && s.timer.completedAt === T0 + 25 * HOUR + 1000);
  s = apply(s, { type: 'timer.schedule', startAt: T0 + 48 * HOUR }, T0 + 26 * HOUR);
  check('scheduling after a finished event creates a NEW session id', s.timer.status === 'scheduled' && s.timer.sessionId !== sid);
  const sid2 = s.timer.sessionId;
  s = apply(s, { type: 'timer.schedule', startAt: T0 + 49 * HOUR }, T0 + 26 * HOUR);
  check('rescheduling a not-yet-started event keeps its session id', s.timer.sessionId === sid2);
}

console.log('\nAdjustments');
{
  let s = apply(defaultState(), { type: 'timer.start' }, T0);
  const now = T0 + HOUR;
  s = apply(s, { type: 'timer.adjust', deltaMs: 5 * MINUTE }, now);
  s = apply(s, { type: 'timer.adjust', deltaMs: 5 * MINUTE }, now);
  check('two +5 min actions add 10 min (cumulative)', remainingAt(s.timer, now) === 23 * HOUR + 10 * MINUTE);
  s = apply(s, { type: 'timer.adjust', deltaMs: -5 * MINUTE }, now);
  check('−5 min subtracts from the REAL remaining time', remainingAt(s.timer, now) === 23 * HOUR + 5 * MINUTE);
  check('adjust capped at 24 h', remainingAt(apply(s, { type: 'timer.adjust', deltaMs: 2 * HOUR }, now).timer, now) === 24 * HOUR);
  check('adjust that would end the event is refused', throws(() => apply(s, { type: 'timer.adjust', deltaMs: -24 * HOUR }, now)));
  check('adjust before start is refused', throws(() => apply(defaultState(), { type: 'timer.adjust', deltaMs: MINUTE }, now)));
  const stale = s.timer.rev;
  const s2 = apply(s, { type: 'timer.pause' }, now, { baseTimerRev: stale });
  check('timer command with current rev accepted', s2.timer.status === 'paused');
  check('timer command based on a stale rev is rejected (conflict)', throws(() => apply(s2, { type: 'timer.reset' }, now, { baseTimerRev: stale })));
  check('announcement command is never blocked by timer rev', !throws(() => apply(s2, { type: 'ann.add', text: 'x' }, now, { baseTimerRev: stale })));
}

console.log('\nSimulations');
{
  const d = defaultState();
  check('projector simulation needs rehearsal mode', throws(() => apply(d, { type: 'sim.start', kind: 'final', fromMs: 65_000 }, T0)));
  const r = apply(d, { type: 'settings.update', patch: { rehearsal: true } }, T0);
  const sim = apply(r, { type: 'sim.start', kind: 'final', fromMs: 65_000 }, T0);
  check('rehearsal simulation allowed while ready', sim.simulation?.kind === 'final' && sim.timer === r.timer);
  const running = apply(sim, { type: 'timer.start' }, T0 + 1000);
  check('starting the real event clears the simulation', running.simulation === null);
  check('simulation refused while running', throws(() => apply(running, { type: 'sim.start', kind: 'final' }, T0 + 2000)));
  const paused = apply(running, { type: 'timer.pause' }, T0 + 3000);
  check('simulation refused while paused', throws(() => apply(paused, { type: 'sim.start', kind: 'milestone', milestoneMs: HOUR }, T0 + 4000)));
  const sched = apply(r, { type: 'timer.schedule', startAt: T0 + 30 * SECOND }, T0);
  check('simulation refused when the scheduled start is too close', throws(() => apply(sched, { type: 'sim.start', kind: 'final', fromMs: 65_000 }, T0)));
  const off = apply(sim, { type: 'settings.update', patch: { rehearsal: false } }, T0 + 500);
  check('leaving rehearsal mode stops the simulation immediately', off.simulation === null);
  check('sim.stop clears it', apply(sim, { type: 'sim.stop' }, T0 + 500).simulation === null);
}

console.log('\nCommand validation');
{
  const bad: unknown[] = [null, [], 5, 'x', {}, { type: 1 }, { type: 'nope' }, { type: 'timer.schedule' }, { type: 'timer.schedule', startAt: 'x' },
    { type: 'timer.setRemaining', ms: Infinity }, { type: 'ann.add' }, { type: 'ann.update', id: 'a' }, { type: 'ann.move', id: 'a', dir: 2 },
    { type: 'settings.update', patch: { effects: 'yes' } }, { type: 'settings.update', patch: { evil: true } }, { type: 'sim.start', kind: 'x' },
    { type: 'ann.add', text: 'x'.repeat(3000) }];
  check(`${bad.length} malformed commands are rejected with CommandError`, bad.every((b) => throws(() => validateCommand(b))));
  check('valid command passes and drops unknown fields', JSON.stringify(validateCommand({ type: 'timer.reset', extra: 1 })) === '{"type":"timer.reset"}');
  check('announcement > 280 chars rejected by reducer', throws(() => apply(defaultState(), { type: 'ann.add', text: 'y'.repeat(281) }, T0)));
}

console.log('\nEnvelope parsing');
{
  const bad = ['null', '[]', '1', '"s"', 'true', '{', '{}', '{"type":5}', '{"type":"cmd"}', '{"type":"cmd","reqId":"a"}', '{"type":"cmd","reqId":"a","cmd":null}',
    '{"type":"auth"}', '{"type":"auth","pin":5}', '{"type":"ping"}', '{"type":"hello","role":"root"}', '{"type":"ack"}', '{"type":"zzz"}'];
  check(`${bad.length} malformed envelopes rejected without throwing`, bad.every((b) => { try { return !parseClientMsg(b).ok; } catch { return false; } }));
  check('valid cmd envelope accepted', parseClientMsg('{"type":"cmd","reqId":"a","cmdId":"b","cmd":{"type":"timer.start"}}').ok);
}

console.log('\nState validation (persistence)');
{
  const good = JSON.parse(JSON.stringify(durableState(apply(defaultState(), { type: 'timer.start' }, T0))));
  check('valid saved state accepted', validateState(good).ok);
  const v1 = JSON.parse(JSON.stringify(good)); delete v1.schema; delete v1.timer.rev; delete v1.timer.completedAt; delete v1.settings.performance;
  const m = validateState(v1);
  check('older (v1.0) file migrates with defaults', m.ok && m.migrated && m.state.settings.performance === false);
  const cases: [string, (s: any) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['running without deadline', (s) => { s.timer.endsAt = null; }],
    ['bad status', (s) => { s.timer.status = 'exploded'; }],
    ['remaining out of range', (s) => { s.timer.remainingMs = -5; }],
    ['wrong duration', (s) => { s.timer.durationMs = 5; }],
    ['announcement without id', (s) => { delete s.announcements[0].id; }],
    ['duplicate announcement ids', (s) => { s.announcements[1].id = s.announcements[0].id; }],
    ['setting of wrong type', (s) => { s.settings.sound = 'yes'; }],
    ['missing settings', (s) => { delete s.settings; }],
    ['rev not a number', (s) => { s.rev = 'x'; }],
  ];
  for (const [name, mut] of cases) {
    const s = JSON.parse(JSON.stringify(good)); mut(s);
    check(`damaged state rejected: ${name}`, !validateState(s).ok);
  }
  check('null / array rejected', !validateState(null).ok && !validateState([]).ok);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
