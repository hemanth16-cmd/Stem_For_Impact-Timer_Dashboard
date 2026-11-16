import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Eye, EyeOff, Megaphone, Pencil, Plus, Trash2, X, Zap } from 'lucide-react';
import { MAX_ANNOUNCEMENT_LEN, type Announcement, type AppState, type TickerMode } from '../shared/model';
import { AnnouncementTicker, visibleAnnouncements } from '../display/AnnouncementTicker';
import { useDisplays, useStore } from '../lib/store';
import { Btn, Card, useUi } from './ui';

/** Renders the real ticker component at projector size, scaled down to fit the panel. */
export function TickerPreview({ items, mode }: { items: Announcement[]; mode: TickerMode }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1776));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="relative overflow-hidden rounded-xl bg-night ring-1 ring-white/10" style={{ height: (mode === 'static' ? 150 : 92) * scale + 24 }}>
      <div className="absolute left-0 top-3 origin-top-left" style={{ width: 1776, transform: `scale(${scale})` }}>
        {items.length ? <AnnouncementTicker items={items} mode={mode} /> : (
          <div className="flex h-[92px] items-center justify-center text-[32px] text-white/50">No active announcements — the ticker is hidden.</div>
        )}
      </div>
    </div>
  );
}

/** Honest delivery status: server acceptance is NOT proof that a projector rendered it. */
function DeliveryStatus({ rev }: { rev: number }) {
  const displays = useDisplays().filter((d) => d.role === 'display');
  if (!displays.length) return <span className="text-amber">No projector display connected — nobody is seeing this right now.</span>;
  const confirmed = displays.filter((d) => (d.ackRev ?? -1) >= rev);
  if (confirmed.length === displays.length)
    return <span className="text-club-green">✓ Shown on {displays.length === 1 ? 'the projector' : `all ${displays.length} displays`} (confirmed rev {rev})</span>;
  return <span className="text-amber">Waiting for {displays.length - confirmed.length} of {displays.length} display(s) to confirm rev {rev}…</span>;
}

export function AnnouncementManager({ state, enabled }: { state: AppState; enabled: boolean }) {
  const { run, confirm } = useUi();
  const [text, setText] = useState('');
  const [priority, setPriority] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const list = state.announcements;
  const mode = state.settings.tickerMode;
  const mode_ = useStore((s) => s.mode);

  const now = Date.now();
  const draft: Announcement[] = text.trim()
    ? [{ id: 'draft', text: text.trim(), active: true, priority, createdAt: now, updatedAt: now }]
    : [];

  const publish = async (active: boolean) => {
    if (!text.trim()) return;
    if (active && !(await confirm({ title: priority ? 'Publish PRIORITY announcement?' : 'Publish announcement?', body: <>“{text.trim()}” appears on the projector{priority ? ' immediately, first in line' : ''}.</>, confirm: 'Publish' }))) return;
    if (await run({ type: 'ann.add', text, priority, active }, active ? 'Published to the server' : 'Saved as draft (not shown)')) {
      setText(''); setPriority(false);
    }
  };

  const saveEdit = async (id: string) => {
    if (await run({ type: 'ann.update', id, patch: { text: editText } }, 'Announcement updated')) setEditing(null);
  };

  const del = async (a: Announcement) => {
    if (await confirm({ title: 'Delete announcement?', body: `“${a.text}”`, confirm: 'Delete', danger: true }))
      run({ type: 'ann.delete', id: a.id }, 'Deleted');
  };

  return (
    <Card title="Announcements" icon={<Megaphone size={18} />} id="announcements"
      right={
        <div className="flex rounded-lg bg-white/5 p-1 text-xs font-bold ring-1 ring-white/10" role="group" aria-label="Ticker mode">
          {(['scroll', 'static'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} disabled={!enabled} onClick={() => run({ type: 'settings.update', patch: { tickerMode: m } })}
              className={`min-h-[36px] rounded-md px-3 py-1.5 ${mode === m ? 'bg-block-blue text-white' : 'text-white/70'}`}>
              {m === 'scroll' ? 'Scrolling ticker' : 'Static pages'}
            </button>
          ))}
        </div>
      }>
      <div className="mb-2 text-xs font-bold tracking-widest text-white/60">CURRENT PROJECTOR CONTENT</div>
      <TickerPreview items={visibleAnnouncements(list)} mode={mode} />
      <div className="mt-2 text-xs" aria-live="polite">{mode_ === 'remote' ? <DeliveryStatus rev={state.rev} /> : <span className="text-amber">Local mode: only tabs in this browser receive it.</span>}</div>

      <div className="mt-5 rounded-xl bg-night/50 p-3 ring-1 ring-white/10">
        <label className="block text-xs font-bold tracking-widest text-white/60" htmlFor="new-ann">NEW ANNOUNCEMENT</label>
        <textarea id="new-ann" className="admin-input mt-1 min-h-[70px] resize-y" placeholder="Type a new announcement…" maxLength={MAX_ANNOUNCEMENT_LEN}
          value={text} onChange={(e) => setText(e.target.value)} disabled={!enabled} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" aria-pressed={priority} onClick={() => setPriority(!priority)} disabled={!enabled}
            className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ring-1 ${priority ? 'bg-maker text-night ring-maker' : 'text-white/80 ring-white/20'}`}>
            <Zap size={14} />High priority
          </button>
          <span className="text-xs text-white/60">{text.length}/{MAX_ANNOUNCEMENT_LEN}</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Btn onClick={() => publish(false)} disabled={!enabled || !text.trim()}>Save as draft</Btn>
            <Btn tone="yellow" onClick={() => publish(true)} disabled={!enabled || !text.trim()}><Plus size={16} />Publish</Btn>
          </div>
        </div>
        {draft.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-xs font-bold tracking-widest text-amber">DRAFT PREVIEW — NOT SENT TO THE PROJECTOR</div>
            <TickerPreview items={draft} mode={mode} />
          </div>
        )}
      </div>

      <ul className="mt-4 space-y-2">
        {list.length === 0 && <li className="py-4 text-center text-sm text-white/60">No announcements yet.</li>}
        {list.map((a, i) => (
          <li key={a.id} className={`rounded-xl p-3 ring-1 ${a.active ? 'bg-white/[0.05] ring-white/10' : 'bg-transparent ring-white/10'}`}>
            {editing === a.id ? (
              <div>
                <label className="sr-only" htmlFor={`edit-${a.id}`}>Edit announcement</label>
                <textarea id={`edit-${a.id}`} className="admin-input min-h-[60px]" value={editText} maxLength={MAX_ANNOUNCEMENT_LEN} autoFocus onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveEdit(a.id); } if (e.key === 'Escape') setEditing(null); }} />
                <div className="mt-2 flex justify-end gap-2">
                  <Btn allowBusy onClick={() => setEditing(null)}><X size={14} />Cancel</Btn>
                  <Btn tone="primary" onClick={() => saveEdit(a.id)} disabled={!editText.trim()}><Check size={14} />Save</Btn>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {a.priority && <span className="rounded bg-maker px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-night">PRIORITY</span>}
                    <span className={`text-[11px] font-bold tracking-wider ${a.active ? 'text-club-green' : 'text-white/60'}`}>{a.active ? '● PUBLISHED' : '○ DRAFT / HIDDEN'}</span>
                  </div>
                  <div className={`mt-1 break-words text-sm ${a.active ? '' : 'text-white/70'}`}>{a.text}</div>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  <IconBtn title="Move up" disabled={!enabled || i === 0} onClick={() => run({ type: 'ann.move', id: a.id, dir: -1 })}><ArrowUp size={16} /></IconBtn>
                  <IconBtn title="Move down" disabled={!enabled || i === list.length - 1} onClick={() => run({ type: 'ann.move', id: a.id, dir: 1 })}><ArrowDown size={16} /></IconBtn>
                  <IconBtn title={a.priority ? 'Remove priority' : 'Mark high priority'} active={a.priority} disabled={!enabled}
                    onClick={() => run({ type: 'ann.update', id: a.id, patch: { priority: !a.priority } })}><Zap size={16} /></IconBtn>
                  <IconBtn title={a.active ? 'Hide from screen' : 'Publish on screen'} disabled={!enabled}
                    onClick={async () => {
                      if (!a.active && /\[DRAFT|__:__/.test(a.text)) {
                        if (!(await confirm({ title: 'This is an unconfirmed draft', body: 'It still contains placeholder times. Edit it with the official time before publishing.', confirm: 'Publish anyway', danger: true }))) return;
                      }
                      run({ type: 'ann.update', id: a.id, patch: { active: !a.active } }, a.active ? 'Hidden' : 'Published');
                    }}>
                    {a.active ? <EyeOff size={16} /> : <Eye size={16} />}
                  </IconBtn>
                  <IconBtn title="Edit" disabled={!enabled} onClick={() => { setEditing(a.id); setEditText(a.text); }}><Pencil size={16} /></IconBtn>
                  <IconBtn title="Delete" danger disabled={!enabled} onClick={() => del(a)}><Trash2 size={16} /></IconBtn>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function IconBtn({ children, active, danger, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; danger?: boolean }) {
  const { busy } = useUi();
  return (
    <button type="button" {...p} disabled={p.disabled || busy} aria-label={p.title} aria-pressed={active}
      className={`grid h-11 w-11 place-items-center rounded-lg ring-1 transition disabled:opacity-30 sm:h-9 sm:w-9 ${active ? 'bg-maker text-night ring-maker' : danger ? 'text-red-200 ring-red-400/40 hover:bg-red-500/20' : 'text-white/85 ring-white/15 hover:bg-white/10'}`}>
      {children}
    </button>
  );
}
