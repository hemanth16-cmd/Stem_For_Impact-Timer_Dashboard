/**
 * One shared, timestamp-based clock for the whole page.
 *
 * It wakes exactly when a displayed value can change — the next whole second of the countdown
 * deadline (anchor) and the next whole wall-clock second — and NOT on every animation frame.
 * Components subscribe through `useClock(selector)` and only re-render when the value they select
 * changes, so the static branding, background and ticker never re-render because time passed.
 * Values are always recomputed from timestamps, so a throttled/hidden tab is correct the moment
 * it runs again (no accumulated drift), whatever the frame rate.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { serverNow } from './store';

let now = serverNow();
let anchor = 0;
let timer: number | undefined;
const subs = new Set<() => void>();

function nextDelay(n: number) {
  const toWall = 1000 - (n % 1000);
  const toAnchor = (((anchor - n) % 1000) + 1000) % 1000 || 1000;
  return Math.max(15, Math.min(toWall, toAnchor) + 4);
}
function tick() {
  now = serverNow();
  subs.forEach((l) => l());
  clearTimeout(timer);
  timer = window.setTimeout(tick, nextDelay(now));
}
function start() {
  if (timer !== undefined) return;
  tick();
  const wake = () => tick();
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
}

/** The moment whose whole seconds the countdown displays (deadline, sim end, scheduled start). */
export function setClockAnchor(a: number | null) {
  const v = a ?? 0;
  if (v === anchor) return;
  anchor = v;
  if (timer !== undefined) tick();
}
export const clockNow = () => now;
/** Force an immediate recompute (e.g. state arrived from the server). */
export const pokeClock = () => { if (timer !== undefined) tick(); };

const subscribe = (l: () => void) => { start(); subs.add(l); return () => { subs.delete(l); }; };

/** Subscribe to a value derived from "now". Re-renders only when the selected value changes. */
export function useClock<T>(select: (now: number) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const last = useRef<{ v: T } | null>(null);
  const selRef = useRef(select);
  selRef.current = select;
  const get = useCallback(() => {
    const v = selRef.current(now);
    if (last.current && isEqual(last.current.v, v)) return last.current.v;
    last.current = { v };
    return v;
  }, [isEqual]);
  return useSyncExternalStore(subscribe, get);
}
