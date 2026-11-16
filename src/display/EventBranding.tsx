import { memo } from 'react';
import { useClock } from '../lib/clock';
import { istTimeSec } from '../lib/time';

export type StatusTone = 'live' | 'idle' | 'paused' | 'done';

/** The only part of the top bar that changes every second. */
function IstClock() {
  const text = useClock((n) => istTimeSec(n));
  return <div className="font-mono text-[32px] font-bold tabular text-white/95">{text}</div>;
}

export const TopBar = memo(function TopBar({ statusLabel, statusTone }: { statusLabel: string; statusTone: StatusTone }) {
  const tone = { live: 'bg-club-green', idle: 'bg-block-blue', paused: 'bg-amber', done: 'bg-block-yellow' }[statusTone];
  return (
    <div className="absolute left-0 right-0 top-0 flex h-[110px] items-center justify-between px-[72px]">
      {/* Official header artwork cropped from the poster; `screen` blending drops its navy backdrop. */}
      <img src="/brand/presidency-header.png" alt="Presidency University | Presidency Makerspace"
        className="h-[54px] w-auto select-none" style={{ mixBlendMode: 'screen' }} draggable={false} />
      <div className="flex items-center gap-6">
        <div className="glass flex items-center gap-3 rounded-full px-5 py-2">
          <span className={`h-3 w-3 rounded-full ${tone} ${statusTone === 'live' ? 'live-dot' : ''}`} />
          <span className="text-[22px] font-bold tracking-[0.22em]">{statusLabel}</span>
        </div>
        <div className="text-right leading-tight">
          <IstClock />
          <div className="text-[18px] tracking-[0.24em] text-white/75">IST · 17–18 NOV 2026 · BENGALURU</div>
        </div>
      </div>
    </div>
  );
});

/** Connection / recovery warnings, sized to be read from the back of the hall. */
export const ConnectionBanner = memo(function ConnectionBanner({ kind, minutes }: { kind: 'reconnecting' | 'long-offline' | 'recovery' | 'connecting' | null; minutes: number }) {
  if (!kind) return null;
  const text = {
    connecting: 'Connecting to the event server…',
    reconnecting: 'Reconnecting… countdown continues',
    'long-offline': `Server unreachable ${minutes} min · countdown continues`,
    recovery: 'Server restoring data · countdown continues',
  }[kind];
  const strong = kind === 'long-offline' || kind === 'recovery';
  return (
    <div role="status" className={`absolute left-1/2 top-[30px] z-40 -translate-x-1/2 whitespace-nowrap rounded-full border px-7 py-2.5 text-[24px] font-bold tracking-wide ${strong ? 'border-red-400/70 bg-[#3a0f14] text-[#ffd7d7]' : 'border-amber/70 bg-[#2e2210] text-cream'}`}>
      {text}
    </div>
  );
});

export const EventTitle = memo(function EventTitle({ tagline }: { tagline: string }) {
  // Long taglines wrap onto two lines and shrink a little instead of being clipped.
  const size = tagline.length > 80 ? 22 : tagline.length > 50 ? 24 : 28;
  return (
    <div className="flex items-center justify-center gap-10">
      {/* Official event logo (crop of the supplied poster), framed like the poster's retro CRT */}
      <div className="relative shrink-0 rounded-[26px] p-[6px]"
        style={{ background: 'linear-gradient(160deg,#d9a24a,#8a5a1c)', boxShadow: '0 0 60px rgb(47 122 247 / 0.45)' }}>
        <img src="/brand/stem-for-impact-logo.png" alt="STEM FOR IMPACT" draggable={false}
          className="block h-[150px] w-auto select-none rounded-[20px]" />
      </div>
      <div className="h-[130px] w-px shrink-0 bg-gradient-to-b from-transparent via-white/30 to-transparent" />
      <div className="min-w-0 max-w-[1100px]">
        <div className="whitespace-nowrap font-display text-[76px] leading-[0.95] tracking-tight">
          STEM FOR IMPACT{' '}
          <span className="relative inline-block -rotate-2 rounded-md bg-block-yellow px-3 text-night shadow-[0_6px_0_#8a5a1c]">2026</span>
        </div>
        {tagline && (
          <div className="mt-4 flex items-start gap-4 font-medium leading-snug text-white/85" style={{ fontSize: size }}>
            <span className="mt-[0.55em] inline-block h-[6px] w-14 shrink-0 rounded bg-block-blue" />
            <span className="line-clamp-2 break-words">{tagline}</span>
          </div>
        )}
      </div>
    </div>
  );
});
