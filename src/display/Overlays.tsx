import { memo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

export type SimLabel = false | 'rehearsal' | 'preview';
export interface MilestoneInfo { key: string; title: string; subtitle: string; simulated?: SimLabel }

/** Cinematic banner sweeping across the stage. The timer keeps running underneath. */
export const MilestoneOverlay = memo(function MilestoneOverlay({ m }: { m: MilestoneInfo | null }) {
  return (
    <AnimatePresence>
      {m && (
        <motion.div key={m.key} className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.8 }}>
          <div className="absolute inset-0 bg-night/80" />
          <motion.div className="absolute h-[2px] w-full"
            style={{ background: 'linear-gradient(90deg,transparent,#f0c237,transparent)', top: 'calc(50% - 170px)' }}
            initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }} />
          <motion.div className="absolute h-[2px] w-full"
            style={{ background: 'linear-gradient(90deg,transparent,#2f7af7,transparent)', top: 'calc(50% + 170px)' }}
            initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 1.1, delay: 0.1, ease: [0.22, 1, 0.36, 1] }} />
          <div className="relative text-center">
            {m.simulated && <div className="mb-6 text-[26px] font-bold tracking-[0.4em] text-amber">{m.simulated === 'preview' ? 'PREVIEW · THIS SCREEN ONLY' : 'REHEARSAL · NOT THE REAL TIMER'}</div>}
            <motion.div className="font-display text-[150px] leading-none tracking-[0.02em] text-white"
              style={{ textShadow: '0 0 40px rgb(240 194 55 / 0.55), 0 0 120px rgb(47 122 247 / 0.6)' }}
              initial={{ scaleX: 1.35, opacity: 0 }}
              animate={{ scaleX: 1, opacity: 1 }}
              transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}>
              {m.title}
            </motion.div>
            <motion.div className="mt-8 text-[48px] font-medium text-block-yellow"
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6, duration: 0.8 }}>
              {m.subtitle}
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

export const TimesUp = memo(function TimesUp({ show, simulated }: { show: boolean; simulated: SimLabel }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div className="absolute inset-0 z-40 flex flex-col items-center justify-center text-center"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6 }}>
          {simulated && <div className="mb-8 text-[28px] font-bold tracking-[0.4em] text-amber">{simulated === 'preview' ? 'PREVIEW · THIS SCREEN ONLY' : 'REHEARSAL · NOT THE REAL TIMER'}</div>}
          <motion.div className="font-display leading-none text-maker"
            style={{ fontSize: 260, textShadow: '0 0 50px rgb(242 223 43 / 0.6), 0 0 160px rgb(240 194 55 / 0.45), 0 10px 0 #8a5a1c' }}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 120, damping: 14, mass: 1.1 }}>
            TIME&apos;S UP!
          </motion.div>
          <motion.div className="mt-14 flex items-center gap-8"
            initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7, duration: 0.9 }}>
            <img src="/brand/stem-for-impact-logo.png" alt="STEM FOR IMPACT" className="h-[130px] rounded-[18px] ring-[5px] ring-amber/80" />
            <div className="text-left">
              <div className="font-display text-[72px] leading-none">STEM FOR IMPACT 2026</div>
              <div className="mt-4 text-[40px] font-medium text-white/80">24 Hours. Endless Innovation.</div>
            </div>
          </motion.div>
          <motion.div className="mt-16 h-[3px] w-[900px] rounded"
            style={{ background: 'linear-gradient(90deg,transparent,#2f7af7,#f0c237,#2f7af7,transparent)' }}
            initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: 1.1, duration: 1.4 }} />
          <motion.div className="mt-6 text-[28px] tracking-[0.36em] text-white/80"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.6, duration: 1 }}>
            PENS DOWN · THANK YOU, INNOVATORS
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
