import { useState } from 'react';
import { AlertOctagon, HardDrive, KeyRound, Loader2, LogOut, MonitorCheck, ServerCog, Wifi, WifiOff } from 'lucide-react';
import { BUILD_ID, login, logout, sendRecovery, switchToLocalMode, switchToServerMode, useDisplays, useStore } from '../lib/store';
import { istDateTime, istTimeSec } from '../lib/time';
import { TimerControls } from './TimerControls';
import { AnnouncementManager } from './AnnouncementManager';
import { PresentationSettings, TestMode } from './PresentationSettings';
import { Btn, Card, UiProvider, useUi } from './ui';

function ConnectionPill() {
  const mode = useStore((s) => s.mode);
  const conn = useStore((s) => s.conn);
  const authed = useStore((s) => s.authed);
  const pending = useStore((s) => s.pendingCount);
  if (mode === 'local')
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-amber/25 px-3 py-1.5 text-xs font-bold text-cream" title="No sync server — changes only reach tabs in this same browser">
        <HardDrive size={14} />LOCAL MODE · this browser only
      </span>
    );
  if (conn === 'online')
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-club-green/15 px-3 py-1.5 text-xs font-bold text-club-green">
        <Wifi size={14} />{authed ? 'CONNECTED' : 'CONNECTED · not signed in'}{pending ? ` · sending…` : ''}
      </span>
    );
  if (conn === 'recovery')
    return <span className="inline-flex items-center gap-2 rounded-full bg-red-500/25 px-3 py-1.5 text-xs font-bold text-red-200"><AlertOctagon size={14} />SERVER NEEDS RECOVERY</span>;
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-red-500/25 px-3 py-1.5 text-xs font-bold text-red-200" role="status">
      {conn === 'connecting' ? <Loader2 size={14} className="animate-spin" /> : <WifiOff size={14} />}
      {conn === 'connecting' ? 'CONNECTING…' : 'DISCONNECTED · retrying'}
    </span>
  );
}

function Login() {
  const [pin, setPin] = useState('');
  const err = useStore((s) => s.authError);
  const conn = useStore((s) => s.conn);
  const pending = useStore((s) => s.authPending);
  return (
    <div className="mx-auto mt-10 max-w-sm rounded-2xl border border-white/10 bg-white/[0.04] p-6 sm:mt-16 sm:p-7">
      <h1 className="flex items-center gap-2 text-lg font-bold"><KeyRound className="text-block-yellow" aria-hidden />Organizer sign-in</h1>
      <p className="mt-2 text-sm text-white/70">Enter the admin PIN shown in the server window on the organizer laptop.</p>
      <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); if (pin.trim() && !pending) login(pin); }}>
        <label htmlFor="pin" className="block text-xs font-bold tracking-widest text-white/60">ADMIN PIN</label>
        <input id="pin" type="password" className="admin-input text-center font-mono text-2xl tracking-[0.4em]" inputMode="numeric"
          autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus maxLength={32}
          value={pin} onChange={(e) => setPin(e.target.value)} aria-describedby={err ? 'pin-err' : undefined} aria-invalid={!!err} />
        {err && <div id="pin-err" role="alert" className="text-sm text-red-300">{err}</div>}
        <Btn type="submit" tone="primary" allowBusy className="w-full" disabled={conn !== 'online' || !pin.trim() || pending}>
          {pending ? <><Loader2 size={16} className="animate-spin" />Checking…</> : 'Unlock controls'}
        </Btn>
        {conn !== 'online' && <p className="text-xs text-amber">Waiting for the event server connection…</p>}
      </form>
    </div>
  );
}

/** Persistence health, build, and what each projector has actually rendered. */
function ServerStatus() {
  const info = useStore((s) => s.info);
  const rev = useStore((s) => s.state?.rev ?? 0);
  const displays = useDisplays().filter((d) => d.role === 'display');
  if (!info) return null;
  const h = info.health;
  const saveOk = h.status === 'ok';
  const savedCurrent = h.savedRev === rev;
  return (
    <Card title="Event server" icon={<ServerCog size={18} />} id="server">
      {!saveOk && (
        <div role="alert" className="mb-3 rounded-xl bg-red-600/25 p-3 text-sm text-red-100 ring-1 ring-red-400/50">
          <b>Changes are NOT being saved to disk.</b> The live countdown continues from memory, but a restart would lose recent changes.
          <div className="mt-1 font-mono text-xs opacity-90">{h.lastError}</div>
          <div className="mt-1 text-xs">Check free disk space and that the <code>data</code> folder is writable. Saving is retried automatically every 5 s.</div>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-white/60">Saved to disk</dt>
        <dd data-testid="persist-status" className={saveOk && savedCurrent ? 'text-club-green' : 'text-amber'}>
          {saveOk ? (savedCurrent ? `✓ revision ${h.savedRev} is safely saved` : `saving… (on disk: rev ${h.savedRev ?? '—'}, live: rev ${rev})`) : `✗ FAILING (last good: rev ${h.savedRev ?? '—'})`}
        </dd>
        <dt className="text-white/60">Last save</dt>
        <dd>{h.lastSavedAt ? `${istTimeSec(h.lastSavedAt)} IST` : '—'}</dd>
        <dt className="text-white/60">Start-up source</dt>
        <dd>{{ fresh: 'First run (new state)', restored: 'Restored saved state', backup: 'RECOVERED FROM BACKUP', 'cache-offer': 'Restored from a display’s cached copy', 'manual-fresh': 'Started fresh by organizer', none: '—' }[h.source]}</dd>
        <dt className="text-white/60">Build</dt>
        <dd className={info.buildMatches ? '' : 'text-red-300'}>
          <span className="font-mono text-xs">{info.build}</span>{BUILD_ID !== info.build && <span className="text-amber"> · this page is {BUILD_ID} — reload it</span>}
          {!info.buildMatches && ' · prepared build does not match the source!'}
        </dd>
      </dl>
      {h.notes.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-amber">{h.notes.slice(-4).map((n, i) => <li key={i}>{n}</li>)}</ul>}

      <div className="mt-4 flex items-center gap-2 text-xs font-bold tracking-widest text-white/60"><MonitorCheck size={14} />DISPLAYS — CONFIRMED BY THE SCREEN ITSELF</div>
      {displays.length === 0 ? (
        <p className="mt-1 text-sm text-amber">No projector display is connected.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {displays.map((d) => {
            const upToDate = (d.ackRev ?? -1) >= rev;
            return (
              <li key={d.id} className="flex flex-wrap gap-x-2">
                <span className="font-mono text-xs text-white/70">{d.ip}</span>
                <span className={upToDate ? 'text-club-green' : 'text-amber'}>{upToDate ? `✓ showing latest (rev ${d.ackRev})` : `waiting… (showing rev ${d.ackRev ?? '—'})`}</span>
                <span className={d.audio === 'ready' ? 'text-club-green' : 'text-amber'}>· sound {d.audio === 'ready' ? 'armed' : d.audio === 'blocked' ? 'NOT armed (click the screen once)' : d.audio}</span>
                <span className="text-white/60">· {d.fullscreen ? 'fullscreen' : 'windowed'}{d.visible ? '' : ' · TAB HIDDEN'} · {d.viewport}</span>
                {d.build && d.build !== info.build && <span className="text-red-300">· old page build — reload it</span>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function RecoveryPanel() {
  const info = useStore((s) => s.info);
  const reason = useStore((s) => s.recoveryReason);
  const { toast, confirm } = useUi();
  const [busy, setBusy] = useState(false);
  const rec = info?.recovery;
  const act = async (m: Parameters<typeof sendRecovery>[0], ok: string) => {
    setBusy(true);
    const r = await sendRecovery(m);
    setBusy(false);
    toast(r.ok ? 'ok' : r.unknown ? 'warn' : 'error', r.ok ? ok : r.error ?? 'Failed');
  };
  return (
    <Card title="Recovery needed" icon={<AlertOctagon size={18} />} id="recovery">
      <div role="alert" className="rounded-xl bg-red-600/20 p-3 text-sm text-red-100 ring-1 ring-red-400/50">
        <b>The saved event state could not be restored:</b> {rec?.reason ?? reason}
        <div className="mt-1 text-xs">Nothing has been overwritten. Connected projectors keep counting from their own last copy.</div>
      </div>
      {rec && rec.preservedFiles.length > 0 && <p className="mt-2 text-xs text-white/70">Damaged file preserved as: <code>{rec.preservedFiles.join(', ')}</code></p>}
      <h3 className="mt-4 text-sm font-bold">Option 1 — restore from a display’s cached copy (recommended)</h3>
      {!rec || rec.offers.length === 0 ? (
        <p className="mt-1 text-sm text-white/70">No cached copy offered yet. Open the projector page (it offers its copy automatically once connected).</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rec.offers.map((o) => (
            <li key={o.rev} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/5 p-2 text-sm">
              <span>rev {o.rev} · timer <b>{o.status}</b>{o.endsAt ? ` · ends ${istDateTime(o.endsAt)}` : ''} · {o.announcements} announcements · from {o.from}</span>
              <Btn tone="primary" allowBusy disabled={busy} onClick={async () => {
                if (await confirm({ title: 'Restore this copy?', body: `The server adopts revision ${o.rev} and saves it as the new state.`, confirm: 'Restore' })) act({ type: 'recovery.adopt', rev: o.rev }, 'State restored');
              }}>Restore</Btn>
            </li>
          ))}
        </ul>
      )}
      <h3 className="mt-4 text-sm font-bold">Option 2 — restore a backup file manually</h3>
      <p className="mt-1 text-xs text-white/70">Stop the server, copy a file from <code>data/backups/</code> to <code>data/state.json</code>, then start it again.</p>
      <h3 className="mt-4 text-sm font-bold">Option 3 — start a completely new event state</h3>
      <Btn tone="danger" allowBusy className="mt-2" disabled={busy} onClick={async () => {
        if (await confirm({ title: 'Start fresh?', body: 'The timer returns to 24:00:00 (ready) and announcements reset to defaults. The damaged file stays preserved.', confirm: 'Start fresh', danger: true, typeToConfirm: 'START FRESH' }))
          act({ type: 'recovery.fresh', confirm: 'START FRESH' }, 'Started fresh');
      }}>Start fresh…</Btn>
    </Card>
  );
}

function Unreachable() {
  const { confirm } = useUi();
  return (
    <div className="mx-auto mt-12 max-w-lg rounded-2xl border border-red-400/40 bg-red-500/10 p-6 text-center">
      <WifiOff className="mx-auto text-red-300" aria-hidden />
      <h1 className="mt-2 text-lg font-bold">Cannot reach the event server</h1>
      <p className="mt-2 text-sm text-white/75">Retrying automatically. Check that the server window is open on the organizer laptop and that this device is on the same Wi-Fi.</p>
      <Btn className="mt-4" allowBusy onClick={async () => {
        if (await confirm({
          title: 'Use LOCAL mode instead?', danger: true, confirm: 'Use local mode',
          body: <>Local mode stores the countdown <b>in this browser only</b>. It cannot control the projector, phones or any other device, and it never merges with the server’s state.</>,
        })) switchToLocalMode();
      }}>Use local mode (this browser only)…</Btn>
    </div>
  );
}

function Panels() {
  const state = useStore((s) => s.state);
  const authed = useStore((s) => s.authed);
  const mode = useStore((s) => s.mode);
  const conn = useStore((s) => s.conn);
  const fromCache = useStore((s) => s.fromCache);
  const info = useStore((s) => s.info);
  const pinSaved = useStore((s) => s.pinSaved);
  const authPending = useStore((s) => s.authPending);

  if (mode === 'remote' && conn === 'recovery') return authed ? <RecoveryPanel /> : <Login />;
  if (mode === 'remote' && !authed) {
    if (conn !== 'online' && !state) return <Unreachable />;
    // Signed in earlier in this tab and only the connection dropped: keep the panel visible
    // (read-only) and sign in again automatically once the server is back.
    const reconnecting = pinSaved && state && (conn !== 'online' || authPending);
    if (!reconnecting) return <Login />;
  }
  if (!state) return <div className="mt-20 text-center text-white/70"><Loader2 className="mx-auto mb-3 animate-spin" />Connecting to the event server…</div>;
  const enabled = mode === 'local' || (conn === 'online' && authed && !fromCache);
  return (
    <>
      {!enabled && (
        <div role="alert" className="mb-4 rounded-xl bg-red-600/25 p-3 text-sm text-red-100 ring-1 ring-red-400/50">
          {conn === 'online' ? 'Signing in again…' : 'Disconnected from the event server — reconnecting automatically.'} Controls are disabled until the connection is back and you are signed in again. Values below may be out of date.
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <TimerControls state={state} enabled={enabled} />
          {mode === 'remote' && info && <ServerStatus />}
          <TestMode state={state} enabled={enabled} />
        </div>
        <div className="space-y-5">
          <AnnouncementManager state={state} enabled={enabled} />
          <PresentationSettings state={state} enabled={enabled} />
        </div>
      </div>
    </>
  );
}

export default function OrganizerDashboard() {
  const authed = useStore((s) => s.authed);
  const mode = useStore((s) => s.mode);
  return (
    <UiProvider>
      <div className="admin-root min-h-full bg-night bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,#214687_0%,transparent_70%)]">
        <header className="sticky top-0 z-40 border-b border-white/10 bg-night/95">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-3 py-2.5 sm:px-4">
            <img src="/brand/stem-for-impact-logo.png" alt="" className="h-10 rounded-md" />
            <div className="mr-auto leading-tight">
              <div className="font-display text-base sm:text-lg">STEM FOR IMPACT 2026</div>
              <div className="text-[11px] tracking-[0.25em] text-white/60">ORGANIZER CONTROL PANEL</div>
            </div>
            <ConnectionPill />
            {mode === 'remote' && authed && (
              <button type="button" onClick={logout} className="grid h-11 w-11 place-items-center rounded-lg text-white/70 hover:bg-white/10" title="Sign out" aria-label="Sign out"><LogOut size={18} /></button>
            )}
          </div>
          {mode === 'local' && (
            <div className="bg-amber/20 px-4 py-2 text-center text-xs text-cream">
              <b>LOCAL MODE:</b> changes reach other tabs of <b>this browser on this computer only</b> — not the projector laptop, phones or any other device.{' '}
              <button type="button" className="underline" onClick={switchToServerMode}>Switch back to the event server</button>
            </div>
          )}
        </header>
        <main className="mx-auto max-w-7xl px-3 py-5 sm:px-4 sm:py-6">
          <Panels />
        </main>
      </div>
    </UiProvider>
  );
}
