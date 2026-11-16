/**
 * Celebration sound, synthesised with WebAudio (no audio file to load or fail).
 * Browsers block audio until a user gesture on THIS page; `unlockAudio()` is wired to the first
 * click/key. `audioStatus()` reports honestly whether this page can currently make sound.
 */
import type { AudioStatus } from '../shared/model';

let ctx: AudioContext | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

const AC = typeof window !== 'undefined'
  ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  : undefined;

export function audioStatus(): AudioStatus {
  if (!AC) return 'unsupported';
  return ctx?.state === 'running' ? 'ready' : 'blocked';
}
export const audioUnlocked = () => audioStatus() === 'ready';
export const onAudioChange = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export async function unlockAudio() {
  try {
    if (!AC) return false;
    if (!ctx) {
      ctx = new AC();
      ctx.onstatechange = notify;
    }
    if (ctx.state !== 'running') await ctx.resume();
    notify();
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

/** Returns true only if playback was actually scheduled on a running audio context. */
/** Diagnostics (read by the automated browser tests and visible in devtools). */
const diag = { played: 0, blocked: 0 };
if (typeof window !== 'undefined') (window as unknown as { __sfiSound: typeof diag }).__sfiSound = diag;

export function playCelebration(volume = 0.5): boolean {
  if (!ctx || ctx.state !== 'running') { diag.blocked++; return false; }
  diag.played++;
  const c = ctx;
  const t0 = c.currentTime + 0.05;
  const master = c.createGain();
  master.gain.value = volume;
  const comp = c.createDynamicsCompressor();
  master.connect(comp).connect(c.destination);

  const tone = (freq: number, start: number, dur: number, type: OscillatorType, gain: number) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0 + start);
    g.gain.linearRampToValueAtTime(gain, t0 + start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    o.connect(g).connect(master);
    o.start(t0 + start);
    o.stop(t0 + start + dur + 0.05);
  };
  // Rising fanfare arpeggio (C major) then a bright sustained chord with shimmer.
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    tone(f, i * 0.11, 0.35, 'triangle', 0.35);
    tone(f * 2, i * 0.11, 0.2, 'sine', 0.08);
  });
  [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f) => {
    tone(f, 0.5, 2.4, 'sawtooth', 0.045);
    tone(f, 0.5, 2.6, 'triangle', 0.16);
  });
  for (let i = 0; i < 14; i++) tone(2093 + Math.random() * 2000, 0.55 + i * 0.09, 0.25, 'sine', 0.05);
  // Low "impact" thump
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.setValueAtTime(140, t0 + 0.5);
  o.frequency.exponentialRampToValueAtTime(45, t0 + 1.1);
  g.gain.setValueAtTime(0.6, t0 + 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.3);
  o.connect(g).connect(master);
  o.start(t0 + 0.5);
  o.stop(t0 + 1.4);
  return true;
}

if (typeof window !== 'undefined') {
  const handler = () => { void unlockAudio(); };
  window.addEventListener('pointerdown', handler, { passive: true });
  window.addEventListener('keydown', handler);
}
