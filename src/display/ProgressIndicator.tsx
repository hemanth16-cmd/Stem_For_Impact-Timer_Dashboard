import { memo } from 'react';

export const ProgressIndicator = memo(function ProgressIndicator({ progress, startLabel, endLabel }: {
  progress: number; startLabel: string; endLabel: string;
}) {
  const pct = Math.min(100, Math.max(0, progress * 100));
  const shown = pct > 0 && pct < 1 ? pct.toFixed(1) : Math.floor(pct).toString();
  return (
    <div className="w-[1440px]">
      <div className="mb-3 flex items-end justify-between">
        <div className="text-[22px] font-bold tracking-[0.3em] text-white/80">HACKATHON PROGRESS</div>
        <div className="font-mono text-[26px] font-bold tabular">
          <span className="text-block-yellow">{shown}%</span>
          <span className="ml-3 text-[19px] tracking-[0.26em] text-white/75">COMPLETE</span>
        </div>
      </div>
      <div className="relative h-[12px] overflow-hidden rounded-full bg-white/10 ring-1 ring-white/15">
        {/* Width is driven by a transform (scaleX) so the bar never triggers layout. */}
        <div className="absolute inset-0 origin-left rounded-full transition-transform duration-1000 ease-linear"
          style={{ transform: `scaleX(${pct / 100})`, background: 'linear-gradient(90deg,#2f7af7 0%,#7fb0ff 55%,#f0c237 100%)', boxShadow: '0 0 22px rgb(47 122 247 / 0.7)' }} />
        <div className="absolute inset-0 overflow-hidden rounded-full" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>
          <div className="progress-sheen absolute inset-y-0 w-1/4 bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        </div>
        {[25, 50, 75].map((t) => (
          <div key={t} className="absolute inset-y-0 w-[2px] bg-night/80" style={{ left: `${t}%` }} />
        ))}
      </div>
      <div className="mt-2.5 flex justify-between text-[20px] tracking-[0.16em] text-white/75">
        <span>{startLabel}</span>
        <span>{endLabel}</span>
      </div>
    </div>
  );
});
