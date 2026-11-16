import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { send, type CmdResult } from '../lib/store';
import type { Command } from '../shared/model';

export function Card({ title, icon, children, right, id }: { title: string; icon: ReactNode; children: ReactNode; right?: ReactNode; id?: string }) {
  const hid = useId();
  return (
    <section id={id} aria-labelledby={hid} className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 shadow-xl shadow-black/20 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id={hid} className="flex items-center gap-2.5 text-[15px] font-bold tracking-[0.14em] text-white/90">
          <span className="text-block-yellow" aria-hidden>{icon}</span>{title.toUpperCase()}
        </h2>
        {right}
      </div>
      {children}
    </section>
  );
}

type BtnTone = 'primary' | 'ghost' | 'danger' | 'yellow' | 'green';
/** Buttons are automatically disabled while an organizer command is in flight (no double submits). */
export function Btn({ tone = 'ghost', className = '', allowBusy, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: BtnTone; allowBusy?: boolean }) {
  const ui = useContext(Ctx);
  const tones: Record<BtnTone, string> = {
    primary: 'bg-block-blue text-white hover:brightness-110',
    green: 'bg-club-green text-night hover:brightness-110',
    yellow: 'bg-block-yellow text-night hover:brightness-105',
    danger: 'bg-red-500/15 text-red-200 ring-1 ring-red-400/50 hover:bg-red-500/25',
    ghost: 'bg-white/[0.07] text-white/95 ring-1 ring-white/15 hover:bg-white/10',
  };
  const disabled = p.disabled || (!allowBusy && !!ui?.busy);
  return (
    <button type="button" {...p} disabled={disabled} aria-busy={!allowBusy && ui?.busy ? true : undefined}
      className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-35 ${tones[tone]} ${className}`} />
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  const ui = useContext(Ctx);
  const id = useId();
  const off = disabled || !!ui?.busy;
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl px-1 py-2.5">
      <span>
        <span id={id} className="block text-sm font-medium">{label}</span>
        {hint && <span id={`${id}-h`} className="block text-xs text-white/60">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} aria-labelledby={id} aria-describedby={hint ? `${id}-h` : undefined}
        disabled={off} onClick={() => onChange(!checked)}
        className={`relative h-8 w-14 shrink-0 rounded-full transition disabled:opacity-40 ${checked ? 'bg-club-green' : 'bg-white/20'}`}>
        <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${checked ? 'left-7' : 'left-1'}`} />
      </button>
    </div>
  );
}

// ---------- confirm + toast + command runner ----------
export interface ConfirmOpts { title: string; body: ReactNode; confirm: string; danger?: boolean; typeToConfirm?: string }
type ToastKind = 'ok' | 'error' | 'warn';
interface Toast { id: number; kind: ToastKind; text: string }
interface UiApi {
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  /** Run a command. Resolves true only if the server APPLIED it. */
  run: (cmd: Command, okText?: string, opts?: { baseTimerRev?: number }) => Promise<boolean>;
  toast: (kind: ToastKind | boolean, text: string) => void;
  busy: boolean;
}
const Ctx = createContext<UiApi | null>(null);
export const useUi = () => useContext(Ctx)!;

export function UiProvider({ children }: { children: ReactNode }) {
  const [dlg, setDlg] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const n = useRef(0);

  const toast = useCallback((k: ToastKind | boolean, text: string) => {
    const kind: ToastKind = k === true ? 'ok' : k === false ? 'error' : k;
    const id = ++n.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'ok' ? 2600 : 9000);
  }, []);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setDlg({ ...o, resolve })), []);
  const run = useCallback(async (cmd: Command, okText?: string, opts?: { baseTimerRev?: number }) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    let r: CmdResult;
    try { r = await send(cmd, opts); } finally { busyRef.current = false; setBusy(false); }
    if (r.unknown) toast('warn', r.error ?? 'No reply — outcome unknown.');
    else if (!r.ok) toast('error', r.error ?? 'Failed.');
    else if (r.saved === false) toast('warn', `${okText ?? 'Applied'} — but NOT saved to disk. See "Event server" status.`);
    else if (okText) toast('ok', r.duplicate ? `${okText} (confirmed after reconnect)` : okText);
    return r.ok;
  }, [toast]);
  const close = (v: boolean) => { dlg?.resolve(v); setDlg(null); };

  return (
    <Ctx.Provider value={{ confirm, run, toast, busy }}>
      {children}
      <AnimatePresence>{dlg && <ConfirmDialog dlg={dlg} close={close} />}</AnimatePresence>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-3" aria-live="polite" role="status">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className={`pointer-events-auto flex max-w-xl items-start gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-xl ${t.kind === 'ok' ? 'bg-club-green text-night' : t.kind === 'warn' ? 'bg-amber text-night' : 'bg-red-600 text-white'}`}>
              <span className="mt-0.5 shrink-0">{t.kind === 'ok' ? <CheckCircle2 size={16} /> : t.kind === 'warn' ? <Info size={16} /> : <XCircle size={16} />}</span>{t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

/** Modal with focus trap, Escape to cancel, focus restored afterwards, optional typed confirmation. */
function ConfirmDialog({ dlg, close }: { dlg: ConfirmOpts; close: (v: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState('');
  const tid = useId();
  const ok = !dlg.typeToConfirm || typed.trim().toUpperCase() === dlg.typeToConfirm;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>(dlg.typeToConfirm ? 'input' : '[data-cancel]');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Tab' && box.current) {
        const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), input')];
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); prev?.focus?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => close(false)}>
      <motion.div ref={box} role="alertdialog" aria-modal="true" aria-labelledby={`${tid}-t`} aria-describedby={`${tid}-b`}
        className="w-full max-w-md rounded-2xl border border-white/15 bg-navy p-6 shadow-2xl"
        initial={{ scale: 0.97, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97 }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <AlertTriangle className={`shrink-0 ${dlg.danger ? 'text-red-400' : 'text-block-yellow'}`} aria-hidden />
          <div className="min-w-0">
            <h3 id={`${tid}-t`} className="text-lg font-bold">{dlg.title}</h3>
            <div id={`${tid}-b`} className="mt-2 text-sm text-white/80">{dlg.body}</div>
          </div>
        </div>
        {dlg.typeToConfirm && (
          <label className="mt-4 block text-sm text-white/80">
            Type <b className="font-mono text-white">{dlg.typeToConfirm}</b> to confirm
            <input className="admin-input mt-1 font-mono uppercase" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off"
              onKeyDown={(e) => { if (e.key === 'Enter' && ok) close(true); }} />
          </label>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Btn data-cancel allowBusy onClick={() => close(false)}>Cancel</Btn>
          <Btn tone={dlg.danger ? 'danger' : 'primary'} allowBusy disabled={!ok} onClick={() => close(true)}>{dlg.confirm}</Btn>
        </div>
      </motion.div>
    </motion.div>
  );
}
