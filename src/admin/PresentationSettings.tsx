import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Eye, FlaskConical, MonitorPlay, Square, Volume2, X } from 'lucide-react';
import { MAX_TAGLINE_LEN, MILESTONES, type AppState, type DisplayInfo } from '../shared/model';
import { playCelebration, unlockAudio } from '../lib/sound';
import { useDisplays, withMode } from '../lib/store';
import { useClock } from '../lib/clock';
import { activeSim } from '../lib/useCountdown';
import { Btn, Card, Toggle, useUi } from './ui';

export function PresentationSettings({ state, enabled }: { state: AppState; enabled: boolean }) {
  const { run, toast, confirm } = useUi();
  const s = state.settings;
  const [tagline, setTagline] = useState(s.tagline);
  const set = (patch: Partial<AppState['settings']>) => run({ type: 'settings.update', patch });
  const displays = useDisplays().filter((d) => d.role === 'display');
  const [testId, setTestId] = useState<number | null>(null);

  const testProjector = async () => {
    if (!(await confirm({ title: 'Play the finish sound on the projector?', body: 'Every connected projector/display will play the celebration sound OUT LOUD now. Use this before the event to check the speakers.', confirm: 'Play on projector' }))) return;
    setTestId(Date.now());
    run({ type: 'display.testSound' }, 'Test sent to displays');
  };

  return (
    <Card title="Presentation" icon={<MonitorPlay size={18} />} id="presentation">
      <div className="divide-y divide-white/5">
        <Toggle label="Performance mode" hint="Keeps branding, large digits, announcements and the final countdown; stops background motion, particles and heavy glow. Use if the projector laptop stutters." checked={s.performance} onChange={(v) => set({ performance: v })} disabled={!enabled} />
        <Toggle label="Background effects" hint="Particles, moving grid, ambient glows (ignored while Performance mode is on)." checked={s.effects} onChange={(v) => set({ effects: v })} disabled={!enabled} />
        <Toggle label="Scanline texture" hint="Turn off if the projector shows stripes or shimmer." checked={s.scanlines} onChange={(v) => set({ scanlines: v })} disabled={!enabled} />
        <Toggle label="Reduced glow" hint="Crisper digits on bright or washed-out projectors." checked={s.reducedGlow} onChange={(v) => set({ reducedGlow: v })} disabled={!enabled} />
        <Toggle label="Milestone overlays" hint="12h, 6h, 3h, 1h, 30m, 10m banners (once per event)." checked={s.milestones} onChange={(v) => set({ milestones: v })} disabled={!enabled} />
        <Toggle label="Final celebration sound" hint="Plays once at 00:00:00 on displays where sound is armed." checked={s.sound} onChange={(v) => set({ sound: v })} disabled={!enabled} />
        <Toggle label="Progress bar" checked={s.showProgress} onChange={(v) => set({ showProgress: v })} disabled={!enabled} />
      </div>
      <label className="mt-3 block text-xs text-white/70">Tagline under the title ({tagline.length}/{MAX_TAGLINE_LEN})
        <div className="mt-1 flex gap-2">
          <input className="admin-input" value={tagline} maxLength={MAX_TAGLINE_LEN} onChange={(e) => setTagline(e.target.value)} disabled={!enabled} />
          <Btn onClick={() => set({ tagline })} disabled={!enabled || tagline.trim() === s.tagline}>Save</Btn>
        </div>
      </label>

      <div className="mt-5 border-t border-white/10 pt-4">
        <div className="text-xs font-bold tracking-widest text-white/60">SOUND CHECK</div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Btn onClick={async () => { await unlockAudio(); if (!playCelebration(0.4)) toast(false, 'This browser blocked audio.'); }}>
            <Volume2 size={16} />Test on THIS device
          </Btn>
          <Btn tone="primary" onClick={testProjector} disabled={!enabled || displays.length === 0}>
            <Volume2 size={16} />Test on projector speakers
          </Btn>
        </div>
        <ul className="mt-2 space-y-1 text-xs">
          {displays.length === 0 && <li className="text-white/60">No projector display connected.</li>}
          {displays.map((d) => <AudioLine key={d.id} d={d} testId={testId} />)}
        </ul>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Btn tone="primary" allowBusy onClick={() => window.open(withMode('/'), 'sfi-display')}><ExternalLink size={16} />Open display window</Btn>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-white/65">
        Fullscreen and sound can only be enabled by a click <i>on the projector page itself</i>: click once on the display, then press <b className="text-white/90">F</b>.
      </p>
    </Card>
  );
}

function AudioLine({ d, testId }: { d: DisplayInfo; testId: number | null }) {
  const audio = d.audio === 'ready' ? <span className="text-club-green">sound armed</span>
    : d.audio === 'blocked' ? <span className="text-amber">sound BLOCKED — click once on that screen</span>
    : <span className="text-white/60">sound status unknown</span>;
  const test = d.soundTest && testId && d.soundTest.at >= testId - 2000
    ? (d.soundTest.ok ? <span className="text-club-green"> · test played ✓ (listen for it)</span> : <span className="text-red-300"> · test BLOCKED by browser</span>)
    : null;
  return <li className="text-white/80">Display {d.ip} ({d.viewport || '?'}): {audio}{test}</li>;
}

const PREVIEWS: { label: string; q: string }[] = [
  ...MILESTONES.map((m) => ({ label: m.title.replace(' REMAINING', ''), q: `milestone-${m.ms}` })),
  { label: 'Final 60 s', q: 'final' },
  { label: 'Last 10 s + end', q: 'last10' },
];

/**
 * Rehearsal tools.
 *  - "Preview here" plays any effect in an isolated window on THIS device only (never the projector).
 *  - Projector rehearsal requires an explicit Rehearsal mode and is refused while the real event is live.
 */
export function TestMode({ state, enabled }: { state: AppState; enabled: boolean }) {
  const { run, confirm } = useUi();
  const [preview, setPreview] = useState<string | null>(null);
  const simActive = useClock((n) => !!activeSim(state.simulation, state.timer, n));
  const t = state.timer.status;
  const eventLive = t === 'running' || t === 'paused';
  const rehearsalAllowed = t === 'ready' || t === 'scheduled';
  const rehearsal = state.settings.rehearsal;

  const startFinal = async (fromMs: number) => {
    if (await confirm({
      title: 'Run a rehearsal on the projector?',
      body: <>Every connected display shows a countdown from {fromMs / 1000}s labelled <b>REHEARSAL</b>, ending with TIME&apos;S UP{state.settings.sound ? ' and sound' : ''}. The real timer is not changed.</>,
      confirm: 'Run on projector',
    })) run({ type: 'sim.start', kind: 'final', fromMs }, 'Rehearsal started');
  };

  return (
    <Card title="Rehearsal & preview" icon={<FlaskConical size={18} />} id="rehearsal"
      right={simActive && <span className="rounded-full bg-amber/30 px-3 py-1 text-xs font-bold text-cream">PROJECTOR REHEARSAL RUNNING</span>}>
      <div className="text-xs font-bold tracking-widest text-white/60">PREVIEW ON THIS DEVICE ONLY</div>
      <p className="mt-1 text-xs text-white/65">Opens a private preview window. Nothing is sent to the projector — safe at any time, even during the live event.</p>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PREVIEWS.map((p) => <Btn key={p.q} allowBusy onClick={() => setPreview(p.q)}><Eye size={14} />{p.label}</Btn>)}
      </div>

      <div className="mt-5 border-t border-white/10 pt-4">
        <Toggle label="Rehearsal mode (projector)" disabled={!enabled || (!rehearsal && !rehearsalAllowed)}
          hint={eventLive ? 'Disabled: the real event is live.' : t === 'completed' ? 'Disabled: the event has finished. Reset to rehearse again.' : 'Allows effects to be played on the real projector before the event starts.'}
          checked={rehearsal} onChange={(v) => run({ type: 'settings.update', patch: { rehearsal: v } }, v ? 'Rehearsal mode on' : 'Rehearsal mode off')} />
        {rehearsal && (
          <>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {MILESTONES.map((m) => (
                <Btn key={m.ms} disabled={!enabled || !rehearsalAllowed} onClick={() => run({ type: 'sim.start', kind: 'milestone', milestoneMs: m.ms }, 'Rehearsal started')}>{m.title.replace(' REMAINING', '')}</Btn>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Btn tone="yellow" disabled={!enabled || !rehearsalAllowed} onClick={() => startFinal(65_000)}>Final 60 seconds</Btn>
              <Btn tone="yellow" disabled={!enabled || !rehearsalAllowed} onClick={() => startFinal(15_000)}>Last 10 seconds + end</Btn>
              <Btn tone="danger" disabled={!enabled || !state.simulation} onClick={() => run({ type: 'sim.stop' }, 'Rehearsal stopped')}><Square size={14} />Stop rehearsal</Btn>
            </div>
          </>
        )}
      </div>
      {preview && <PreviewModal q={preview} onClose={() => setPreview(null)} />}
    </Card>
  );
}

function PreviewModal({ q, onClose }: { q: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => { ro.disconnect(); document.removeEventListener('keydown', key); };
  }, [onClose]);
  const scale = w / 1920;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3" role="dialog" aria-modal="true" aria-label="Isolated preview">
      <div className="w-full max-w-5xl rounded-2xl border border-white/15 bg-navy p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-bold">Preview — this device only (projector unaffected)</div>
          <div className="flex gap-2">
            <Btn allowBusy onClick={() => setNonce((n) => n + 1)}>Replay</Btn>
            <Btn allowBusy onClick={onClose} autoFocus><X size={16} />Close</Btn>
          </div>
        </div>
        <div ref={box} className="relative w-full overflow-hidden rounded-lg bg-night" style={{ height: 1080 * scale }}>
          <iframe key={nonce} title="Display preview" src={withMode(`/?preview=${q}`)}
            style={{ width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: '0 0', border: 0 }} />
        </div>
      </div>
    </div>
  );
}
