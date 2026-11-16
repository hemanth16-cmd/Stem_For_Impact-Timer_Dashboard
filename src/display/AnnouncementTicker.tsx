import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Megaphone, Zap } from 'lucide-react';
import type { Announcement, TickerMode } from '../shared/model';

/** Active announcements, high-priority first, preserving organizer order otherwise. */
export const visibleAnnouncements = (list: Announcement[]) =>
  [...list.filter((a) => a.active && a.priority), ...list.filter((a) => a.active && !a.priority)];

const PX_PER_SEC = 120;
/** Reading time for one page in static mode: ~3 words/s plus a pause, never shorter than 8 s. */
export const readingMs = (text: string) => Math.max(8_000, 4_000 + text.trim().split(/\s+/).length * 400);

const contentKey = (items: Announcement[]) => items.map((a) => `${a.id}:${a.priority ? 1 : 0}:${a.text}`).join('|');

export const AnnouncementTicker = memo(function AnnouncementTicker({ items, mode, reduceMotion }: { items: Announcement[]; mode: TickerMode; reduceMotion?: boolean }) {
  const hasPriority = items.some((a) => a.priority);
  // Reduced motion: never scroll — page through complete announcements instead.
  const effective: TickerMode = reduceMotion ? 'static' : mode;
  return (
    <AnimatePresence>
      {items.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 30 }}
          transition={{ duration: reduceMotion ? 0.2 : 0.6 }}
          className={`glass flex w-full items-stretch overflow-hidden rounded-[22px] ${effective === 'static' ? 'min-h-[92px]' : 'h-[92px]'}`}
          data-testid="ticker"
        >
          <div className={`flex shrink-0 items-center gap-3 px-7 font-display text-[22px] tracking-wider text-night ${hasPriority ? 'bg-maker' : 'bg-block-yellow'}`}
            style={{ clipPath: 'polygon(0 0, 100% 0, calc(100% - 22px) 100%, 0 100%)', paddingRight: 46 }}>
            {hasPriority ? <Zap size={28} strokeWidth={2.6} /> : <Megaphone size={28} strokeWidth={2.4} />}
            {hasPriority ? 'PRIORITY' : 'ANNOUNCEMENTS'}
          </div>
          <div className="relative min-w-0 flex-1 overflow-hidden"
            style={effective === 'scroll' ? { maskImage: 'linear-gradient(90deg, transparent 0, #000 48px, #000 calc(100% - 48px), transparent 100%)' } : undefined}>
            {effective === 'scroll' ? <Scroller items={items} /> : <Pager items={items} />}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

function Item({ a }: { a: Announcement }) {
  return (
    <span className="inline-flex items-center">
      {a.priority && (
        <span className="mr-4 rounded-md bg-maker px-2.5 py-0.5 text-[20px] font-bold tracking-widest text-night">PRIORITY</span>
      )}
      <span className={a.priority ? 'text-maker' : 'text-white'}>{a.text}</span>
    </span>
  );
}

/**
 * Seamless scroller. One "sequence" is repeated enough times to always cover the visible width,
 * and the track moves by EXACTLY one sequence width (measured in px), so the loop point is
 * invisible and short lists never leave a gap. The animation restarts only when the content
 * actually changes — not on re-renders, timer updates or unrelated state.
 */
function Scroller({ items }: { items: Announcement[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef<HTMLSpanElement>(null);
  const key = contentKey(items);
  const [geo, setGeo] = useState<{ key: string; shift: number; copies: number } | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    const measure = () => {
      const seq = seqRef.current, box = boxRef.current;
      if (!seq || !box || cancelled) return;
      const shift = seq.offsetWidth;
      const copies = Math.max(2, Math.ceil(box.offsetWidth / Math.max(1, shift)) + 1);
      setGeo((g) => (g && g.key === key && g.shift === shift && g.copies === copies ? g : { key, shift, copies }));
    };
    measure();
    // Webfonts change text width once loaded; re-measure then (and only then).
    void document.fonts?.ready.then(measure);
    return () => { cancelled = true; };
  }, [key]);

  const copies = geo?.key === key ? geo.copies : 2;
  const seq = (rep: number) => (
    <span key={rep} ref={rep === 0 ? seqRef : undefined} className="inline-flex shrink-0 items-center">
      {items.map((a) => (
        <span key={a.id} className="inline-flex items-center">
          <Item a={a} />
          <span className="mx-12 inline-block h-3 w-3 rotate-45 bg-block-blue shadow-[0_0_14px_#2f7af7]" />
        </span>
      ))}
    </span>
  );
  const ready = geo?.key === key;
  return (
    <div ref={boxRef} className="absolute inset-0 flex items-center">
      <div key={ready ? `${key}#${geo!.shift}` : 'measuring'} className={`${ready ? 'ticker-track' : 'inline-flex whitespace-nowrap'} pl-12 text-[36px] font-medium`}
        style={ready ? { ['--ticker-shift' as string]: geo!.shift, ['--ticker-duration' as string]: `${Math.max(10, geo!.shift / PX_PER_SEC)}s` } : undefined}>
        {Array.from({ length: copies }, (_, i) => seq(i))}
      </div>
    </div>
  );
}

/**
 * Static mode: one COMPLETE announcement at a time — wrapped onto up to three lines and shrunk to
 * fit, never truncated — shown for a reading time based on its length. A newly published
 * priority announcement is shown immediately.
 */
function Pager({ items }: { items: Announcement[] }) {
  const [id, setId] = useState(items[0]?.id);
  const prevPriority = useRef(new Set(items.filter((a) => a.priority).map((a) => a.id)));

  // Jump to a NEW priority announcement as soon as it appears.
  useEffect(() => {
    const now = new Set(items.filter((a) => a.priority).map((a) => a.id));
    const fresh = items.find((a) => a.priority && !prevPriority.current.has(a.id));
    prevPriority.current = now;
    if (fresh) setId(fresh.id);
  }, [items]);

  const idx = Math.max(0, items.findIndex((a) => a.id === id));
  const a = items[idx] ?? items[0];
  const text = a?.text ?? '';

  useEffect(() => {
    if (items.length < 2 || !a) return;
    const t = window.setTimeout(() => setId(items[(idx + 1) % items.length].id), readingMs(text));
    return () => clearTimeout(t);
  }, [items, idx, a, text]);

  const fitRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(36);
  useLayoutEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    // Largest size (36 → 22 px) at which the FULL text fits the space between the progress labels
    // and the bottom edge (112 px of text height) — never overlapping other content.
    let s = 36;
    el.style.fontSize = `${s}px`;
    while (s > 22 && (el.scrollHeight > 112 || el.scrollWidth > el.clientWidth + 1)) {
      s -= 2;
      el.style.fontSize = `${s}px`;
    }
    setSize(s);
  }, [text, a?.priority]);

  const dots = useMemo(() => items.map((x) => x.id), [items]);
  if (!a) return null;
  return (
    <div className="flex h-full items-center py-3 pl-12 pr-24">
      <div key={a.id + text} ref={fitRef} data-testid="ticker-page" className="ann-in min-w-0 whitespace-normal break-words font-medium"
        style={{ fontSize: size, lineHeight: 1.25 }}>
        {a.priority && <span className="mr-4 inline-block rounded-md bg-maker px-2.5 py-0.5 align-middle text-[20px] font-bold tracking-widest text-night">PRIORITY</span>}
        <span className={a.priority ? 'text-maker' : 'text-white'}>{a.text}</span>
      </div>
      {dots.length > 1 && (
        <div className="absolute right-8 top-1/2 flex -translate-y-1/2 gap-2">
          {dots.map((x) => (
            <span key={x} className={`h-2.5 w-2.5 rounded-full ${x === a.id ? 'bg-block-yellow' : 'bg-white/30'}`} />
          ))}
        </div>
      )}
    </div>
  );
}
