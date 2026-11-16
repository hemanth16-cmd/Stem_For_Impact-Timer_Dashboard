import { useEffect } from 'react';
import { remainingAt, resolveTimer, simLifetime, type AppState, type Simulation, type TimerState, type TimerStatus } from '../shared/model';
import { setClockAnchor, useClock } from './clock';
import { displaySeconds } from './time';

export { simLifetime };

export interface CountdownView {
  status: TimerStatus;
  remainingMs: number;
  seconds: number;
  progress: number; // 0..1
  sim: Simulation | null; // active (non-expired) simulation
  simFinal: boolean; // display is showing a simulated final countdown
}

/** The active simulation, if any. The real event ALWAYS takes precedence over a simulation. */
export function activeSim(sim: Simulation | null, timer: TimerState, now: number, isolatedPreview = false): Simulation | null {
  if (!sim || now - sim.startedAt > simLifetime(sim)) return null;
  // An isolated preview (admin "Preview here") never reaches the projector, so it may run any time.
  if (isolatedPreview) return sim;
  const real = resolveTimer(timer, now).status;
  if (real === 'running' || real === 'paused' || real === 'completed') return null;
  return sim;
}

export function computeView(state: AppState, now: number, simOverride?: Simulation | null): CountdownView {
  const sim = activeSim(simOverride !== undefined ? simOverride : state.simulation, state.timer, now, simOverride !== undefined);
  if (sim?.kind === 'final') {
    const rem = Math.max(0, (sim.fromMs ?? 65_000) - (now - sim.startedAt));
    return {
      status: rem > 0 ? 'running' : 'completed', remainingMs: rem, seconds: displaySeconds(rem),
      progress: 1 - rem / state.timer.durationMs, sim, simFinal: true,
    };
  }
  const t = resolveTimer(state.timer, now);
  const rem = remainingAt(t, now);
  return {
    status: t.status, remainingMs: rem, seconds: displaySeconds(rem),
    progress: Math.min(1, Math.max(0, 1 - rem / t.durationMs)), sim, simFinal: false,
  };
}

/** Real (never simulated) timer values for organizer screens. */
export function realView(timer: TimerState, now: number) {
  const t = resolveTimer(timer, now);
  return { status: t.status, remainingMs: remainingAt(t, now), timer: t };
}

/** Select one derived value; the component re-renders only when that value changes. */
export function useView<T>(state: AppState | null, select: (v: CountdownView, now: number) => T, simOverride?: Simulation | null, isEqual?: (a: T, b: T) => boolean): T | null {
  return useClock((now) => (state ? select(computeView(state, now, simOverride), now) : null), isEqual as ((a: T | null, b: T | null) => boolean) | undefined);
}

/** Keep the shared clock aligned to whatever deadline the screen is counting toward. */
export function useClockAnchor(state: AppState | null, simOverride?: Simulation | null) {
  const t = state?.timer;
  const sim = simOverride !== undefined ? simOverride : state?.simulation;
  const anchor = sim?.kind === 'final' ? sim.startedAt + (sim.fromMs ?? 65_000)
    : sim ? sim.startedAt
    : t?.status === 'running' ? t.endsAt
    : t?.status === 'scheduled' ? t.scheduledStartAt : null;
  useEffect(() => { setClockAnchor(anchor); }, [anchor]);
}
