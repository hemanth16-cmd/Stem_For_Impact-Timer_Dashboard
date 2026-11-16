import { useState } from 'react';
import { CalendarClock, Pause, Play, RotateCcw, SlidersHorizontal, Timer, X } from 'lucide-react';
import { HOUR, MINUTE, SECOND, type AppState } from '../shared/model';
import { serverNow } from '../lib/store';
import { useClock } from '../lib/clock';
import { realView } from '../lib/useCountdown';
import { epochToIstInput, fmtHMS, istDateTime, istInputToEpoch, splitHMS, displaySeconds } from '../lib/time';
import { Btn, Card, useUi } from './ui';

const STATUS_STYLE: Record<string, string> = {
  ready: 'bg-block-blue/25 text-[#b5d0ff]',
  scheduled: 'bg-block-blue/25 text-[#b5d0ff]',
  running: 'bg-club-green/20 text-club-green',
  paused: 'bg-amber/30 text-cream',
  completed: 'bg-block-yellow/20 text-block-yellow',
};
const EVENT_DAY = '2026-11-17';

/**
 * Organizer timer controls. Every value shown here is the REAL timer computed from the
 * authoritative timestamps (resolveTimer/remainingAt at server time) — never a simulation and
 * never the stale stored `remainingMs` of a running timer.
 */
export function TimerControls({ state, enabled }: { state: AppState; enabled: boolean }) {
  const { run, confirm } = useUi();
  const stored = state.timer;
  const real = useClock((n) => {
    const v = realView(stored, n);
    return `${v.status}|${displaySeconds(v.remainingMs)}`;
  });
  const [status, secStr] = real.split('|');
  const realRemaining = Number(secStr) * 1000;
  const active = status === 'running' || status === 'paused';
  const base = { baseTimerRev: stored.rev };
  const exec = (cmd: Parameters<typeof run>[0], ok: string) => run(cmd, ok, base);

  // ---- schedule inputs: NO default time. The official start must be entered deliberately.
  const pre = stored.scheduledStartAt ? epochToIstInput(stored.scheduledStartAt) : null;
  const [date, setDate] = useState(pre?.date ?? EVENT_DAY);
  const [time, setTime] = useState(pre?.time ?? '');
  const startAt = time ? istInputToEpoch(date, time) : null;

  const [adj, setAdj] = useState({ h: '', m: '', s: '' });
  const adjValid = adj.h !== '' || adj.m !== '' || adj.s !== '';
  const adjMs = (Number(adj.h) || 0) * HOUR + (Number(adj.m) || 0) * MINUTE + (Number(adj.s) || 0) * SECOND;
  const adjErr = !adjValid ? null : Number(adj.m) > 59 || Number(adj.s) > 59 ? 'Minutes and seconds must be 0–59.' : adjMs > stored.durationMs ? 'Maximum is 24:00:00.' : null;

  const start = async () => {
    if (status === 'scheduled' && !(await confirm({ title: 'Start now instead of the schedule?', body: 'This replaces the scheduled start and begins the 24-hour countdown immediately on every display.', confirm: 'Start now' }))) return;
    if (status === 'ready' && !(await confirm({ title: 'Start the 24-hour countdown now?', body: <>The countdown begins immediately on every connected display and ends at <b>{istDateTime(serverNow() + stored.durationMs)}</b>.</>, confirm: 'Start' }))) return;
    exec({ type: 'timer.start' }, 'Countdown started');
  };

  const schedule = async () => {
    if (startAt == null) return;
    const now = serverNow();
    const wrongDay = date !== EVENT_DAY;
    const ok = await confirm({
      title: startAt < now ? 'That start time is in the past' : 'Confirm the automatic start',
      body: (
        <div className="space-y-2">
          <div className="rounded-lg bg-night/70 p-3 font-mono text-[13px] leading-relaxed">
            Starts: <b>{istDateTime(startAt)}</b><br />Ends:&nbsp;&nbsp; <b>{istDateTime(startAt + stored.durationMs)}</b>
          </div>
          {startAt < now && <div>The countdown will begin immediately with <b>{fmtHMS(startAt + stored.durationMs - now)}</b> remaining.</div>}
          {wrongDay && <div className="text-amber">Note: this is not 17 Nov 2026 — check the date.</div>}
          <div className="text-white/60">Make sure this is the officially confirmed start time.</div>
        </div>
      ),
      confirm: stored.status === 'scheduled' ? 'Update schedule' : 'Schedule start',
    });
    if (ok) exec({ type: 'timer.schedule', startAt }, 'Automatic start scheduled');
  };

  const reset = async () => {
    const live = active || status === 'completed';
    const ok = await confirm({
      title: live ? 'Reset the LIVE event?' : 'Reset the countdown?',
      body: live
        ? <>This <b>stops the {status === 'completed' ? 'finished' : 'live'} countdown</b> on every display and returns it to 24:00:00 as a new event. This cannot be undone.</>
        : 'Return the timer to 24:00:00 and clear any schedule.',
      confirm: 'Reset timer', danger: true, typeToConfirm: live ? 'RESET' : undefined,
    });
    if (ok) exec({ type: 'timer.reset' }, 'Timer reset');
  };

  const pause = async () => {
    if (await confirm({ title: 'Pause the countdown?', body: 'All displays will freeze at the current time until you resume.', confirm: 'Pause' }))
      exec({ type: 'timer.pause' }, 'Paused');
  };

  const applySet = async () => {
    if (!adjValid || adjErr) return;
    const target = Math.min(adjMs, stored.durationMs);
    const ok = await confirm({
      title: target === 0 ? 'End the event now?' : 'Set the remaining time?',
      body: <>Remaining time changes from <b className="font-mono">{fmtHMS(realRemaining)}</b> to <b className="font-mono">{fmtHMS(target)}</b>.
        {target === 0 ? ' The TIME’S UP screen and finish sound will play now.' : status === 'running' ? ' The countdown keeps running from the new value.' : ' The timer will be PAUSED at that value — press Resume to continue.'}</>,
      confirm: target === 0 ? 'End event now' : 'Apply', danger: status === 'running' || target === 0, typeToConfirm: target === 0 ? 'END' : undefined,
    });
    if (ok && await exec({ type: 'timer.setRemaining', ms: target }, 'Remaining time updated')) setAdj({ h: '', m: '', s: '' });
  };

  const adjust = async (deltaMs: number) => {
    const from = realRemaining;
    const to = Math.min(stored.durationMs, from + deltaMs);
    const ok = await confirm({
      title: `${deltaMs > 0 ? 'Add' : 'Remove'} ${Math.abs(deltaMs) / MINUTE} minute${Math.abs(deltaMs) === MINUTE ? '' : 's'}?`,
      body: <>About <b className="font-mono">{fmtHMS(from)}</b> → <b className="font-mono">{fmtHMS(to)}</b>. The change is applied to the exact remaining time when the server receives it, so pressing it twice changes the time twice.</>,
      confirm: 'Apply', danger: deltaMs < 0,
    });
    if (ok) exec({ type: 'timer.adjust', deltaMs }, `${deltaMs > 0 ? '+' : '−'}${Math.abs(deltaMs) / MINUTE} min applied`);
  };

  const useCurrent = () => {
    const v = splitHMS(displaySeconds(realView(stored, serverNow()).remainingMs));
    setAdj({ h: String(v.h), m: String(v.m), s: String(v.s) });
  };

  const canAdjust = status === 'running' || status === 'paused' || status === 'completed';

  return (
    <Card title="Timer" icon={<Timer size={18} />} id="timer"
      right={<span data-testid="admin-status" className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest ${STATUS_STYLE[status]}`}>{status}</span>}>
      <div className="rounded-xl bg-night/70 p-4 text-center ring-1 ring-white/10">
        <div className="text-[11px] font-bold tracking-[0.25em] text-white/60">REAL COUNTDOWN (NEVER A SIMULATION)</div>
        <div data-testid="admin-remaining" className="mt-1 font-mono text-5xl font-extrabold tabular sm:text-6xl">{fmtHMS(realRemaining)}</div>
        <div className="mt-3 grid gap-1 text-xs text-white/70 sm:grid-cols-2">
          <div>Start: <span className="text-white/90">{stored.startedAt ? istDateTime(stored.startedAt) : stored.scheduledStartAt ? `${istDateTime(stored.scheduledStartAt)} (scheduled)` : '—'}</span></div>
          <div>End: <span className="text-white/90">
            {status === 'running' && stored.endsAt ? istDateTime(stored.endsAt)
              : status === 'scheduled' && stored.scheduledStartAt ? istDateTime(stored.scheduledStartAt + stored.durationMs)
              : status === 'paused' ? 'paused — recalculated on resume'
              : status === 'completed' ? `finished ${stored.completedAt ? istDateTime(stored.completedAt) : ''}` : '—'}
          </span></div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Btn tone="green" onClick={start} disabled={!enabled || !(status === 'ready' || status === 'scheduled')}><Play size={16} />Start now</Btn>
        <Btn tone="yellow" onClick={pause} disabled={!enabled || status !== 'running'}><Pause size={16} />Pause</Btn>
        <Btn tone="primary" onClick={() => exec({ type: 'timer.resume' }, 'Resumed')} disabled={!enabled || status !== 'paused'}><Play size={16} />Resume</Btn>
        <Btn tone="danger" onClick={reset} disabled={!enabled}><RotateCcw size={16} />Reset</Btn>
      </div>

      <fieldset className="mt-5 border-t border-white/10 pt-4" disabled={!enabled}>
        <legend className="mb-2 flex items-center gap-2 pt-4 text-sm font-bold text-white/90"><CalendarClock size={16} />Automatic start (India Standard Time)</legend>
        {stored.status !== 'scheduled' && !time && (
          <p className="mb-2 text-xs text-amber">No start time is set. Enter the officially confirmed start time — nothing is assumed.</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-white/70">Date (IST)
            <input type="date" className="admin-input mt-1" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="text-xs text-white/70">Time (IST, 24-hour)
            <input type="time" className="admin-input mt-1" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        <div className="mt-2 text-xs text-white/70" aria-live="polite">
          {startAt != null ? <>Starts {istDateTime(startAt)} → ends {istDateTime(startAt + stored.durationMs)}</> : time ? 'Enter a valid date and time.' : ''}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Btn tone="primary" onClick={schedule} disabled={startAt == null || active}><CalendarClock size={16} />{status === 'scheduled' ? 'Update schedule' : 'Schedule start'}</Btn>
          {status === 'scheduled' && <Btn onClick={() => exec({ type: 'timer.cancelSchedule' }, 'Schedule cancelled')}><X size={16} />Cancel schedule</Btn>}
        </div>
        {active && <div className="mt-2 text-xs text-white/60">Reset the timer to schedule a new start.</div>}
        {status === 'completed' && <div className="mt-2 text-xs text-white/60">Scheduling after a finished event creates a NEW event (milestones and the finish sound will run again).</div>}
      </fieldset>

      <fieldset className="mt-5 border-t border-white/10 pt-4" disabled={!enabled}>
        <legend className="mb-2 flex items-center gap-2 pt-4 text-sm font-bold text-white/90"><SlidersHorizontal size={16} />Adjust time</legend>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => adjust(-5 * MINUTE)} disabled={!enabled || !(status === 'running' || status === 'paused') || realRemaining <= 5 * MINUTE}>−5 min</Btn>
          <Btn onClick={() => adjust(-MINUTE)} disabled={!enabled || !(status === 'running' || status === 'paused') || realRemaining <= MINUTE}>−1 min</Btn>
          <Btn onClick={() => adjust(MINUTE)} disabled={!enabled || !canAdjust}>+1 min</Btn>
          <Btn onClick={() => adjust(5 * MINUTE)} disabled={!enabled || !canAdjust}>+5 min</Btn>
        </div>
        <div className="mt-4 text-xs font-bold tracking-widest text-white/60">OR SET AN EXACT REMAINING TIME</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {(['h', 'm', 's'] as const).map((k) => (
            <label key={k} className="text-xs text-white/70">
              {k === 'h' ? 'Hours' : k === 'm' ? 'Minutes' : 'Seconds'}
              <input inputMode="numeric" className="admin-input mt-1 font-mono" value={adj[k]} placeholder="0"
                onChange={(e) => setAdj({ ...adj, [k]: e.target.value.replace(/\D/g, '').slice(0, 2) })} />
            </label>
          ))}
        </div>
        {adjErr && <div className="mt-1 text-xs text-red-300">{adjErr}</div>}
        <div className="mt-2 flex flex-wrap gap-2">
          <Btn onClick={useCurrent}>Use current</Btn>
          <Btn tone="yellow" onClick={applySet} disabled={!enabled || status === 'scheduled' || !adjValid || !!adjErr}>Set remaining time</Btn>
        </div>
      </fieldset>
    </Card>
  );
}
