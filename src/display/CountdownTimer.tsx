import { memo, useRef } from 'react';
import { pad, splitHMS } from '../lib/time';

/**
 * Tracks the current value plus the one it replaced. Rendering is bounded to two nodes and
 * animated with pure CSS, so a hidden / throttled window can never accumulate stale elements
 * (JS-driven exit animations stall when requestAnimationFrame is paused).
 */
function useFlip<T>(value: T) {
  const r = useRef({ cur: value, prev: null as T | null, n: 0 });
  if (r.current.cur !== value) r.current = { cur: value, prev: r.current.cur, n: r.current.n + 1 };
  return r.current;
}

const Digit = memo(function Digit({ ch, className }: { ch: string; className: string }) {
  const f = useFlip(ch);
  return (
    <span className="relative inline-block overflow-hidden text-center align-top" style={{ width: '0.62em', height: '1.08em' }}>
      {f.prev !== null && <span key={`o${f.n}`} className={`digit-out absolute inset-0 ${className}`}>{f.prev}</span>}
      <span key={`i${f.n}`} className={`absolute inset-0 ${className} ${f.n ? 'digit-in' : ''}`}>{f.cur}</span>
    </span>
  );
});

const BigNumber = memo(function BigNumber({ value }: { value: number }) {
  const f = useFlip(value);
  const cls = 'absolute font-sans font-bold leading-none tabular text-maker digit-glow-gold';
  return (
    <>
      {f.prev !== null && <div key={`o${f.n}`} className={`${cls} big-out`} style={{ fontSize: 600 }}>{f.prev}</div>}
      <div key={`i${f.n}`} className={`${cls} ${f.n ? 'big-in' : ''}`} style={{ fontSize: 600 }}>{f.cur}</div>
    </>
  );
});

const Group = memo(function Group({ value, label, size, gold, dim }: { value: string; label: string; size: number; gold?: boolean; dim?: boolean }) {
  return (
    <div className="flex flex-col items-center">
      <div className="glass rounded-[36px] px-[0.1em]" style={{ fontSize: size }}>
        <div className={`flex font-sans font-bold leading-[1.08] tabular transition-opacity duration-700 ${dim ? 'opacity-55' : ''}`}>
          {value.split('').map((ch, i) => (
            <Digit key={i} ch={ch} className={gold ? 'text-maker digit-glow-gold' : 'text-white digit-glow'} />
          ))}
        </div>
      </div>
      <div className="mt-5 text-[32px] font-bold tracking-[0.45em] text-white/85" style={{ paddingLeft: '0.45em' }}>{label}</div>
    </div>
  );
});

const Sep = memo(function Sep({ size, gold }: { size: number; gold?: boolean }) {
  return (
    <div className="sep-pulse flex flex-col justify-center gap-[0.22em] px-[0.12em]" style={{ fontSize: size, height: size * 1.08 }}>
      {[0, 1].map((i) => (
        <span key={i} className="block rounded-full" style={{
          width: '0.1em', height: '0.1em',
          background: gold ? '#f2df2b' : '#f0c237',
          boxShadow: '0 0 18px rgb(240 194 55 / 0.9), 0 0 40px rgb(240 194 55 / 0.45)',
        }} />
      ))}
    </div>
  );
});

export type TimerMode = 'normal' | 'final' | 'last10';

export const CountdownTimer = memo(function CountdownTimer({ seconds, mode, dim }: { seconds: number; mode: TimerMode; dim?: boolean }) {
  const { h, m, s } = splitHMS(seconds);

  if (mode === 'last10') {
    return (
      <div className="flex flex-col items-center">
        <div className="relative flex items-center justify-center" style={{ height: 640, width: 900 }}>
          <BigNumber value={seconds} />
        </div>
        <div className="text-[36px] font-bold tracking-[0.6em] text-white/90" style={{ paddingLeft: '0.6em' }}>SECONDS</div>
      </div>
    );
  }

  if (mode === 'final') {
    return (
      <div className="flex items-start justify-center">
        <Group value={pad(m)} label="MINUTES" size={370} gold />
        <Sep size={370} gold />
        <Group value={pad(s)} label="SECONDS" size={370} gold />
      </div>
    );
  }

  const hrs = h >= 100 ? String(h) : pad(h);
  return (
    <div className="flex items-start justify-center">
      <Group value={hrs} label="HOURS" size={270} dim={dim} />
      <Sep size={270} />
      <Group value={pad(m)} label="MINUTES" size={270} dim={dim} />
      <Sep size={270} />
      <Group value={pad(s)} label="SECONDS" size={270} dim={dim} />
    </div>
  );
});
