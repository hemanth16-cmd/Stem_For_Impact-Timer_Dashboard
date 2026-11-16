import { EVENT_TIMEZONE, HOUR } from '../shared/model';

export const pad = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

/** Whole seconds shown on screen. Ceil so 00:00:00 appears exactly at the deadline. */
export const displaySeconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000 - 1e-6));

export function splitHMS(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return { h, m, s };
}

export const fmtHMS = (ms: number) => {
  const { h, m, s } = splitHMS(displaySeconds(ms));
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
};

const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: EVENT_TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true });
const timeSecFmt = new Intl.DateTimeFormat('en-IN', { timeZone: EVENT_TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: EVENT_TIMEZONE, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
});
const shortDateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: EVENT_TIMEZONE, day: 'numeric', month: 'short' });

export const istTime = (ms: number) => timeFmt.format(ms).toUpperCase();
export const istTimeSec = (ms: number) => timeSecFmt.format(ms).toUpperCase();
export const istDateTime = (ms: number) => dateTimeFmt.format(ms) + ' IST';
export const istShortDate = (ms: number) => shortDateFmt.format(ms);

/** IST is a fixed UTC+05:30 offset (no DST). */
const IST_OFFSET = 5.5 * HOUR;
export function istInputToEpoch(date: string, time: string): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!dm || !tm) return null;
  return Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], +(tm[3] ?? 0)) - IST_OFFSET;
}
export function epochToIstInput(ms: number) {
  const d = new Date(ms + IST_OFFSET);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}
