import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { Maximize, Minimize, Settings2, Volume2, VolumeX } from 'lucide-react';
import { BUILD_ID, onTestSound, queueAck, reportSoundTest, serverNow, setAckExtras, useStore, withMode } from '../lib/store';
import { clockNow, pokeClock, useClock } from '../lib/clock';
import { computeView, useClockAnchor, useView } from '../lib/useCountdown';
import { audioStatus, onAudioChange, playCelebration, unlockAudio } from '../lib/sound';
import { fmtHMS, istShortDate, istTime } from '../lib/time';
import { MILESTONES, MINUTE, SECOND, type AppState, type Simulation } from '../shared/model';
import { Background } from './Background';
import { ConnectionBanner, EventTitle, TopBar, type StatusTone } from './EventBranding';
import { CountdownTimer, type TimerMode } from './CountdownTimer';
import { ProgressIndicator } from './ProgressIndicator';
import { AnnouncementTicker, visibleAnnouncements } from './AnnouncementTicker';
import { MilestoneOverlay, TimesUp, type MilestoneInfo, type SimLabel } from './Overlays';

const STAGE_W = 1920, STAGE_H = 1080;

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

/** `?preview=final|last10|milestone-<ms>`: an isolated, client-only rehearsal (admin "Preview here"). */
function usePreviewSim(): Simulation | undefined {
  const [sim] = useState<Simulation | undefined>(() => {
    const p = new URLSearchParams(location.search).get('preview');
    if (!p) return undefined;
    const startedAt = serverNow() + 600;
    if (p === 'final') return { kind: 'final', fromMs: 65 * SECOND, startedAt, id: `preview-${startedAt}` };
    if (p === 'last10') return { kind: 'final', fromMs: 15 * SECOND, startedAt, id: `preview-${startedAt}` };
    const m = /^milestone-(\d+)$/.exec(p);
    if (m) return { kind: 'milestone', milestoneMs: Number(m[1]), startedAt, id: `preview-${startedAt}` };
    return undefined;
  });
  return sim;
}

function useStageScale() {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return scale;
}

function useFullscreen() {
  const [fs, setFs] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const on = () => { setFs(!!document.fullscreenElement); queueAck(true); };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggle = useCallback(() => {
    void unlockAudio();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }, []);
  return { fs, toggle };
}

/** Pointer activity → show dock / cursor; hidden after a short idle period. */
function useIdle(ms: number) {
  const [active, setActive] = useState(true);
  useEffect(() => {
    let t: number;
    const poke = () => { setActive(true); clearTimeout(t); t = window.setTimeout(() => setActive(false), ms); };
    poke();
    window.addEventListener('mousemove', poke);
    window.addEventListener('pointerdown', poke);
    return () => { clearTimeout(t); window.removeEventListener('mousemove', poke); window.removeEventListener('pointerdown', poke); };
  }, [ms]);
  return active;
}

function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia?.(q).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return;
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

function useDocHidden() {
  const [h, setH] = useState(document.visibilityState === 'hidden');
  useEffect(() => {
    const on = () => { setH(document.visibilityState === 'hidden'); queueAck(true); };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return h;
}

/** Phase = everything that changes rarely. The root re-renders only when one of these changes. */
interface Phase { status: string; mode: TimerMode; completed: boolean; simFinal: boolean; simId: string | null; simKind: string | null; milestonesCrossed: number }
const samePhase = (a: Phase | null, b: Phase | null) => !!a && !!b &&
  a.status === b.status && a.mode === b.mode && a.completed === b.completed && a.simFinal === b.simFinal && a.simId === b.simId && a.simKind === b.simKind && a.milestonesCrossed === b.milestonesCrossed;

export default function PublicCountdownDisplay() {
  const state = useStore((s) => s.state);
  const conn = useStore((s) => s.conn);
  const mode = useStore((s) => s.mode);
  const offlineSince = useStore((s) => s.offlineSince);
  const fromCache = useStore((s) => s.fromCache);
  const preview = usePreviewSim();
  useClockAnchor(state, preview);
  const scale = useStageScale();
  const { fs, toggle } = useFullscreen();
  const active = useIdle(2500);
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)');
  const hidden = useDocHidden();
  const [audio, setAudio] = useState(audioStatus());
  useEffect(() => onAudioChange(() => { setAudio(audioStatus()); queueAck(true); }), []);
  useEffect(() => { setAckExtras(() => ({ audio: audioStatus(), fullscreen: !!document.fullscreenElement })); }, []);
  useEffect(() => { pokeClock(); }, [state]);

  const phase = useView<Phase>(state, (v) => ({
    status: v.status,
    mode: v.status === 'running' && v.seconds <= 10 && v.seconds > 0 ? 'last10' : v.status === 'running' && v.seconds <= 60 && v.seconds > 0 ? 'final' : 'normal',
    completed: v.status === 'completed',
    simFinal: v.simFinal,
    simId: v.sim?.id ?? null,
    simKind: v.sim?.kind ?? null,
    milestonesCrossed: v.status === 'running' && !v.simFinal ? MILESTONES.filter((m) => v.remainingMs <= m.ms).length : -1,
  }), preview, samePhase);

  const settings = state?.settings;
  const timer = state?.timer;
  const simLabel: SimLabel = preview ? 'preview' : 'rehearsal';

  // ---------- keyboard: F = fullscreen ----------
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) toggle(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [toggle]);

  // ---------- milestones (once per event session, survives reloads) ----------
  const [milestone, setMilestone] = useState<MilestoneInfo | null>(null);
  const hideTimer = useRef<number>();
  const showMilestone = useCallback((m: MilestoneInfo, ms = 7000) => {
    setMilestone(m);
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setMilestone(null), ms);
  }, []);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  useEffect(() => {
    if (!state || !phase || phase.milestonesCrossed < 0 || preview) return;
    const t = state.timer;
    const v = computeView(state, clockNow());
    const key = `sfi.ms.${t.sessionId}`;
    let fired: number[] = [];
    try { fired = JSON.parse(lsGet(key) ?? '[]'); } catch { fired = []; }
    let changed = false;
    for (const m of MILESTONES) {
      if (v.remainingMs > m.ms || fired.includes(m.ms)) continue;
      fired.push(m.ms);
      changed = true;
      // Only animate if we crossed it "just now" — a reload long after the milestone stays quiet.
      if (v.remainingMs > m.ms - 20_000 && state.settings.milestones) {
        showMilestone({ key: `${t.sessionId}-${m.ms}`, title: m.title, subtitle: m.subtitle });
      }
    }
    if (changed) lsSet(key, JSON.stringify(fired));
  }, [phase?.milestonesCrossed, state?.timer.sessionId, state?.settings.milestones]); // eslint-disable-line react-hooks/exhaustive-deps

  // Simulated milestone (rehearsal on the projector, or isolated preview).
  const shownSim = useRef<string | null>(null);
  useEffect(() => {
    const sim = preview ?? state?.simulation;
    if (!phase || phase.simKind !== 'milestone' || !sim || shownSim.current === sim.id) return;
    shownSim.current = sim.id;
    const m = MILESTONES.find((x) => x.ms === sim.milestoneMs);
    if (m) showMilestone({ key: sim.id, title: m.title, subtitle: m.subtitle, simulated: simLabel });
  }, [phase?.simId, phase?.simKind]); // eslint-disable-line react-hooks/exhaustive-deps
  // Stopping a simulation removes its overlay immediately.
  useEffect(() => {
    if (phase && !phase.simId && milestone?.simulated) { clearTimeout(hideTimer.current); setMilestone(null); }
  }, [phase?.simId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- end of event: burst + sound exactly once, only for a live finish ----------
  const [burst, setBurst] = useState(0);
  const [soundBlocked, setSoundBlocked] = useState<string | null>(null);
  useEffect(() => {
    if (!phase?.completed || !state) return;
    const sim = preview ?? state.simulation;
    if (phase.simFinal && sim) {
      const k = `sim:${sim.id}`;
      if (shownSim.current === k) return;
      shownSim.current = k;
      setBurst(Date.now());
      if (state.settings.sound) playCelebration();
      return;
    }
    const t = state.timer;
    const completedAt = t.completedAt ?? (t.endsAt != null && t.status === 'running' ? t.endsAt : null);
    const endKey = `sfi.end.${t.sessionId}:${completedAt ?? 'unknown'}`;
    if (lsGet(endKey)) return; // already celebrated (or deliberately skipped) on this display
    const age = completedAt == null ? Infinity : serverNow() - completedAt;
    if (!(age >= -2_000 && age < 15_000)) { lsSet(endKey, 'not-live'); return; } // reload after the finish: stay quiet
    setBurst(Date.now());
    if (!state.settings.sound) { lsSet(endKey, 'muted'); return; }
    if (playCelebration()) { lsSet(endKey, 'played'); setSoundBlocked(null); }
    else setSoundBlocked(endKey); // NOT recorded as played — the organizer can still trigger it below
  }, [phase?.completed, phase?.simFinal, state?.timer.completedAt, state?.timer.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const playBlockedFinish = async () => {
    await unlockAudio();
    if (soundBlocked && playCelebration()) { lsSet(soundBlocked, 'played-late'); setSoundBlocked(null); }
  };

  // Organizer "Test sound on projector": report honestly whether THIS page could play it.
  useEffect(() => {
    onTestSound((id) => reportSoundTest(id, playCelebration(0.4)));
  }, []);

  // ---------- final-minute intensity: CSS variable + ref, no React re-render ----------
  const intensityRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const statusInfo = useMemo((): { label: string; tone: StatusTone } => {
    if (phase?.simId) return { label: preview ? 'PREVIEW' : 'REHEARSAL', tone: 'paused' };
    switch (phase?.status) {
      case 'running': return { label: 'LIVE', tone: 'live' };
      case 'paused': return { label: 'PAUSED', tone: 'paused' };
      case 'completed': return { label: 'COMPLETED', tone: 'done' };
      case 'scheduled': return { label: 'STARTING SOON', tone: 'idle' };
      default: return { label: 'GET READY', tone: 'idle' };
    }
  }, [phase?.status, phase?.simId, preview]);

  const items = useMemo(() => visibleAnnouncements(state?.announcements ?? []), [state?.announcements]);
  const perf = !!settings?.performance;
  const effects = settings?.effects ?? true;
  const motion = effects && !perf && !reducedMotion;
  const particles = motion && !hidden;

  const offlineMinutes = useClock(() => (offlineSince ? Math.floor((Date.now() - offlineSince) / MINUTE) : 0));
  const banner = mode !== 'remote' || preview ? null
    : conn === 'recovery' ? 'recovery'
    : conn === 'offline' ? (offlineMinutes >= 1 ? 'long-offline' : 'reconnecting')
    : conn === 'connecting' && fromCache ? 'connecting' : null;

  if (!state || !phase) {
    return (
      <div className="display-root flex items-center justify-center">
        <div className="text-center">
          <div className="font-display text-5xl">STEM FOR IMPACT 2026</div>
          <div className="mt-4 text-xl text-white/80">
            {conn === 'offline' ? 'Cannot reach the event server yet — retrying automatically…' : 'Connecting to the event server…'}
          </div>
        </div>
      </div>
    );
  }

  const finalPhase = phase.mode !== 'normal';
  const completed = phase.completed;
  const rootCls = ['display-root', !active && 'hide-cursor', perf && 'perf', reducedMotion && 'rm', hidden && 'doc-hidden', settings?.reducedGlow && 'reduced-glow', milestone && 'overlay-on'].filter(Boolean).join(' ');

  return (
    <MotionConfig reducedMotion="user">
      <div ref={rootRef} className={rootCls} data-phase={phase.mode} data-status={phase.status}>
        <IntensityDriver state={state} preview={preview} rootRef={rootRef} intensityRef={intensityRef} />
        <Background effects={effects} motion={motion} particles={particles} scanlines={settings?.scanlines ?? true} burst={burst} intensityRef={intensityRef} />

        <div className="stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
          <TopBar statusLabel={statusInfo.label} statusTone={statusInfo.tone} />
          <ConnectionBanner kind={banner} minutes={offlineMinutes} />

          <div className={`phase-fade absolute inset-x-0 top-[138px] ${finalPhase || completed ? 'phase-hidden' : ''}`}>
            <EventTitle tagline={settings?.tagline ?? ''} />
          </div>

          <Hero state={state} preview={preview} mode={phase.mode} completed={completed} paused={phase.status === 'paused'} />

          <div className={`phase-fade absolute inset-x-0 top-[728px] flex flex-col items-center ${finalPhase || completed ? 'phase-gone' : ''}`}>
            <div className="flex items-center gap-6 font-display text-[38px] tracking-[0.18em] text-block-yellow">
              <span className="h-[3px] w-24 bg-gradient-to-r from-transparent to-block-yellow" />
              24-HOUR HACKATHON
              <span className="h-[3px] w-24 bg-gradient-to-l from-transparent to-block-yellow" />
            </div>
          </div>

          <div className={`phase-fade absolute inset-x-0 top-[808px] flex justify-center ${finalPhase || completed ? 'phase-gone' : ''}`}>
            {phase.status === 'scheduled' && timer?.scheduledStartAt && !phase.simId ? (
              <ScheduledPill startAt={timer.scheduledStartAt} />
            ) : settings?.showProgress !== false ? (
              <Progress state={state} preview={preview} />
            ) : null}
          </div>

          <MilestoneOverlay m={milestone} />
          <TimesUp show={completed} simulated={phase.simFinal ? simLabel : false} />

          <div className="absolute inset-x-[72px] bottom-[34px] z-20">
            <AnnouncementTicker items={items} mode={settings?.tickerMode ?? 'scroll'} reduceMotion={reducedMotion} />
          </div>

          {phase.simId && !completed && (
            <div className="absolute left-1/2 top-[118px] z-30 -translate-x-1/2 rounded-full border border-amber/70 bg-[#2e2210] px-7 py-2.5 text-[24px] font-bold tracking-[0.3em] text-cream">
              {preview ? 'PREVIEW · THIS SCREEN ONLY' : 'REHEARSAL · REAL TIMER NOT RUNNING'}
            </div>
          )}
          {mode === 'local' && (
            <div className="absolute bottom-[140px] right-[72px] z-20 rounded-md bg-[#2e2210] px-4 py-1.5 text-[18px] font-bold tracking-widest text-cream">
              LOCAL MODE · THIS BROWSER ONLY
            </div>
          )}
        </div>

        {/* Organizer dock: hidden in fullscreen and when the mouse is idle */}
        {!fs && !preview && (
          <Dock active={active} audio={audio} soundOn={!!settings?.sound} toggle={toggle} fs={fs} />
        )}
        {soundBlocked && (
          <button onClick={playBlockedFinish} className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-xl bg-amber px-5 py-3 text-lg font-bold text-night">
            The browser blocked the finish sound — click to play it
          </button>
        )}
      </div>
    </MotionConfig>
  );
}

/** The ONLY component that re-renders every second for the countdown digits. */
const Hero = memo(function Hero({ state, preview, mode, completed, paused }: { state: AppState; preview?: Simulation; mode: TimerMode; completed: boolean; paused: boolean }) {
  const seconds = useView(state, (v) => v.seconds, preview) ?? 0;
  const finalPhase = mode !== 'normal';
  return (
    <div className={`phase-fade absolute inset-0 flex items-center justify-center ${completed ? 'phase-gone' : ''}`}
      style={{ transform: completed ? 'scale(0.9)' : mode === 'normal' ? 'translate3d(0,6px,0)' : 'translate3d(0,-30px,0)' }}>
      {finalPhase && (
        <div className="final-pulse pointer-events-none absolute h-[760px] w-[1500px] rounded-full"
          style={{ background: 'radial-gradient(ellipse, rgb(240 194 55 / 0.2) 0%, transparent 65%)' }} />
      )}
      <div key={mode} className="ann-in" style={{ animationDuration: '0.9s' }}>
        <CountdownTimer seconds={seconds} mode={mode} dim={paused} />
      </div>
    </div>
  );
});

const Progress = memo(function Progress({ state, preview }: { state: AppState; preview?: Simulation }) {
  // Quantised to 0.01 % so the bar updates at most a few times a minute.
  const progress = useView(state, (v) => Math.round(v.progress * 10_000) / 10_000, preview) ?? 0;
  const t = state.timer;
  const live = t.status === 'running' && !preview;
  const startLabel = t.startedAt ? `STARTED ${istTime(t.startedAt)} · ${istShortDate(t.startedAt).toUpperCase()}` : 'NOT STARTED';
  const endLabel = live && t.endsAt ? `ENDS ${istTime(t.endsAt)} · ${istShortDate(t.endsAt).toUpperCase()}`
    : t.status === 'paused' ? 'TIMER PAUSED' : '';
  return <ProgressIndicator progress={progress} startLabel={startLabel} endLabel={endLabel} />;
});

function ScheduledPill({ startAt }: { startAt: number }) {
  const left = useClock((n) => fmtHMS(startAt - n));
  return (
    <div className="glass flex items-center gap-6 rounded-full px-10 py-4 text-[30px]">
      <span className="tracking-[0.18em] text-white/85">BEGINS {istTime(startAt)} IST · {istShortDate(startAt).toUpperCase()}</span>
      <span className="h-8 w-px bg-white/25" />
      <span className="font-mono font-bold tabular text-block-yellow">IN {left}</span>
    </div>
  );
}

/** Final-minute brightening: writes a CSS variable + ref; re-renders only itself, once per second, only in the final minute. */
function IntensityDriver({ state, preview, rootRef, intensityRef }: { state: AppState; preview?: Simulation; rootRef: React.RefObject<HTMLDivElement>; intensityRef: React.MutableRefObject<number> }) {
  const intensity = useView(state, (v) => {
    if (v.status === 'completed') return 0.7;
    // Four steps over the final minute (each a short CSS fade) instead of a change every second.
    if (v.status === 'running' && v.seconds <= 60 && v.seconds > 0) return v.seconds > 45 ? 0.35 : v.seconds > 30 ? 0.55 : v.seconds > 15 ? 0.75 : 0.95;
    return 0;
  }, preview) ?? 0;
  useEffect(() => {
    intensityRef.current = intensity;
    rootRef.current?.style.setProperty('--intensity', String(intensity));
  }, [intensity, intensityRef, rootRef]);
  return null;
}

function Dock({ active, audio, soundOn, toggle, fs }: { active: boolean; audio: string; soundOn: boolean; toggle: () => void; fs: boolean }) {
  return (
    <div className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-2xl border border-white/15 bg-night/95 p-2 text-sm transition-opacity duration-500 ${active ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
      <button onClick={() => void unlockAudio()}
        className={`flex min-h-[40px] items-center gap-2 rounded-xl px-3 py-2 ${audio === 'ready' ? 'text-club-green' : 'bg-amber/25 text-cream hover:bg-amber/35'}`}
        title="Browsers only allow sound after a click on this page">
        {audio === 'ready' ? <Volume2 size={16} /> : <VolumeX size={16} />}
        {audio === 'unsupported' ? 'No audio support' : audio === 'ready' ? (soundOn ? 'Sound armed on this screen' : 'Sound muted in admin') : 'Click to enable sound'}
      </button>
      <a href={withMode('/admin')} target="_blank" rel="noreferrer" className="flex min-h-[40px] items-center gap-2 rounded-xl px-3 py-2 text-white/85 hover:bg-white/10">
        <Settings2 size={16} /> Organizer
      </a>
      <button onClick={toggle} className="flex min-h-[40px] items-center gap-2 rounded-xl bg-block-blue px-4 py-2 font-bold hover:brightness-110">
        {fs ? <Minimize size={16} /> : <Maximize size={16} />} Fullscreen (F)
      </button>
      <span className="px-2 font-mono text-[11px] text-white/45" title="Build identifier">{BUILD_ID}</span>
    </div>
  );
}
