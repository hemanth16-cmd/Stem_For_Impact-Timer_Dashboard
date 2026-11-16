# STEM FOR IMPACT 2026 — Live Countdown Dashboard (v1.1)

Projector countdown (`/`) plus an organizer control panel (`/admin`), kept in sync by a small Node
server on the organizer laptop. No internet or cloud account is needed on event day: every device
only has to be on the **same Wi-Fi / LAN** as the laptop.

```
 Organizer laptop (runs the server: authoritative clock + saved state in data\)
   ├── Projector window  →  http://localhost:8080/          (fullscreen, extended display)
   ├── Laptop browser    →  http://localhost:8080/admin
   └── Phone on Wi-Fi    →  http://<laptop-IP>:8080/admin    (PIN protected)
```

---

## 1. Preparation — once, BEFORE the event (needs internet)

1. Install **Node.js 20 LTS or newer** from https://nodejs.org (default options).
2. Copy this `stem-countdown` folder to the event laptop (e.g. `C:\SFI\stem-countdown`).
3. Double-click **`PREPARE-EVENT.bat`**. It:
   1. installs the exact dependency versions from `package-lock.json` (`npm ci`),
   2. type-checks the code,
   3. runs the automated tests (in temporary folders — never touches `data\`),
   4. builds the dashboard and writes `dist\build-info.json` (build identifier + source hash),
   5. verifies the build matches the source.

   It **stops with a clear message on the first failure**. Only use the folder if it ends with `PREPARED`.
4. Do **not** edit files afterwards. If you do, run `PREPARE-EVENT.bat` again — the server refuses to
   start with a build that does not match the source (prevents an old frontend running with new code).

> Smart App Control: `package.json` pins Rollup's WebAssembly build via `overrides` because Windows
> blocked the native binary on this machine. Don't remove it.

## 2. Event-day startup (no internet needed)

1. Plug in power. Windows: **Settings → System → Power → Screen and sleep → Never**; pause Windows
   Update; turn on Focus assist / Do Not Disturb.
2. Connect the projector, press **Win + P → Extend**.
3. Double-click **`START-EVENT.bat`**. Keep that window open all event. It prints:
   - the build identifier (also shown in the admin panel and the display dock),
   - the **Admin PIN** (6 digits, stored in `data\admin-pin.txt`; override with `set ADMIN_PIN=...`),
   - the LAN addresses for phones, e.g. `http://192.168.1.23:8080/admin`,
   - whether saved state was restored.
4. Chrome/Edge → `http://localhost:8080/` → drag the window onto the projector.
   **Click once on the display page, then press `F`.** The click arms the finish sound (browsers block
   sound until a click on that page). The dock shows **"Sound armed on this screen"**.
5. On the laptop screen open `http://localhost:8080/admin`, enter the PIN.
   In **Event server** check: *Saved to disk ✓*, the display listed as *showing latest*, *sound armed*,
   *fullscreen*.
6. **Schedule the start** (Timer → Automatic start) with the **officially confirmed** start time.
   No default time is assumed; the confirmation shows the exact IST start and end.
7. Optional: Presentation → **Test on projector speakers** (plays the sound out loud on the projector).

Windows Firewall asks about Node.js the first time → allow on **Private networks** (needed for phones).

## 3. Phones

Same Wi-Fi as the laptop → `http://<laptop-IP>:8080/admin` → PIN. Campus Wi-Fi often isolates
clients; if the phone can't load the page, use a phone hotspot or a travel router that the laptop and
phones both join. If the connection drops, the panel stays visible but **all controls are disabled**
until it reconnects and signs in again automatically.

## 4. Organizer panel

| Section | What it does |
|---|---|
| **Timer** | Real remaining time (never a simulation) · Start / Pause / Resume · **Reset** (typing `RESET` required while live) · Automatic start in IST with start→end confirmation · **±1 / ±5 min** (applied to the exact remaining time on the server; pressing twice changes it twice) · **Set exact remaining time** (setting `00:00:00` ends the event and needs typing `END`) |
| **Event server** | Persistence health: *saved to disk* with revision and time, failures in red · build identifier and mismatch warnings · every connected display: the revision it **confirmed rendering**, sound armed/blocked, fullscreen, hidden tab |
| **Announcements** | Publish (confirmed) / save as draft · draft preview is labelled *not sent* · delivery line shows whether the projector **confirmed** the new revision (server acceptance is not treated as proof) · edit, hide, priority, reorder · scrolling ticker or **static pages** (full text, up to 3 lines, timed for reading) |
| **Presentation** | **Performance mode** · background effects · scanlines · reduced glow · milestones · finish sound · progress bar · tagline · **Test on THIS device** vs **Test on projector speakers** (with per-display result) |
| **Rehearsal & preview** | **Preview here**: any milestone / final minute / last 10 s in a private window on this device — safe even during the live event. **Rehearsal mode** (projector): only before the event (ready/scheduled); refused while running, paused or finished; ends immediately when the real event starts |

Commands are protected against double-clicks (buttons disable while one is in flight), retried safely
after a dropped connection (the server de-duplicates by command id), and timer commands from a stale
screen are rejected (*"changed by another organizer"*). If no reply arrives you'll see
*"outcome unknown — check the live state"* instead of a false success or failure.

## 5. Saving, backups and recovery

- Every command is saved **before** it is acknowledged: write to a temp file → flush to disk → keep the
  previous good file as `state.json.bak` → atomic rename. Shutdown uses the same path.
- Rolling snapshots: `data\backups\state-*.json` every 10 min (newest 30 kept).
- If a save fails (disk full, folder not writable…) the live event continues from memory, the admin
  panel shows **"Changes are NOT being saved"** with the error, and saving retries every 5 s.
- At startup a **missing** file (first run) and a **damaged** file are treated differently:
  - damaged → copied to `state.json.damaged-<time>` (never deleted), the newest **valid** backup is used,
    and the panel shows *RECOVERED FROM BACKUP*;
  - nothing valid → **Recovery mode**: nothing is overwritten, projectors keep counting from their own
    copy and offer it to the server; the admin panel offers *Restore from a display's cached copy*,
    manual restore instructions, or *Start fresh* (typing `START FRESH`).
- Manual backup at any time: copy the whole `data` folder to a USB stick.
  Manual restore: stop the server, copy a backup file to `data\state.json`, start again.

## 6. Performance

The projector page was measured with the same scripted workload before and after (production build,
1920×1080, headless Chromium, **software GPU** in a 4-core cloud container — a pessimistic proxy;
a laptop GPU will do better, and the real projector has **not** been tested).

| Scenario | v1.0 fps | v1.1 fps | v1.1 Performance mode |
|---|---|---|---|
| Normal countdown, scrolling ticker | 4.8 | 37 (37–45 across runs) | 60 |
| Static announcements | 4.3 | 39 (39–47) | 60 |
| 12 h milestone overlay | 2.9 | 35 (35–39) | 51 |
| Final minute | 4.3 | 32 (32–37) | 52 |
| Last 10 s + TIME'S UP | 4.4 | 32 (32–39) | 46 |
| TIME'S UP screen | 4.1 | 52 (52–59) | 60 |

Only Performance mode reaches a steady 60 fps on this software-rendered test machine. A 30-minute
endurance run (935 announcement edits, 9 final-minute/finish cycles, 7 milestones) showed bounded DOM
(193–463 nodes), constant event listeners (187), heap levelling off at ~4.7 MB, and no page errors.
A full 24-hour run has **not** been performed — do a 1–2 h dry run on the event laptop.

Main causes found (by removing one layer at a time) and fixes:
1. **Animated `filter: blur(110px)` glows** (largest) → soft radial gradients moved only by transform.
2. **`backdrop-filter` glass panels** re-blurring the animated background behind the huge digits every
   frame → same look with a denser fill, no backdrop filter.
3. **Two 3840-px-wide masked 3D grid layers** (`perspective + rotateX + mask`, background-position
   animation = repaint) → drawn on one flat canvas with the identical projection, 30 fps, together with
   the particles; particles bounded (60 ambient, ≤ 320 burst), DPR 1, stopped when the tab is hidden.
4. Repaint animations (`box-shadow` pulse, `filter` on digit/overlay transitions, `letter-spacing`
   animation) → transform/opacity only.
5. The whole display re-rendered every second → only digits and the IST clock re-render per second
   (shared timestamp-based clock with selectors); the progress bar every ~7 s.
6. Final minute: stepped brightening layer and paused glow drift while the final digits are on screen.

Timer accuracy never depends on frame rate: every value is computed from the server deadline.

**Performance mode** (Presentation) keeps the branding, digits, announcements and the full final
countdown, and stops background motion, particles and heavy glow. OS **reduced motion** is honoured:
no particles, no digit/scroll/pulse animation, announcements shown as static pages.

## 7. Testing (development machine)

```bash
npm run test:unit      # 41 model/validation checks
npm run test:server    # 46 server regression checks (throwaway servers, temp folders)
npm run test:e2e       # 34 browser checks (needs Playwright: npx playwright install chromium)
npm run smoke -- --isolated ws://localhost:<test-port>/ws   # 26 protocol checks against a TEST server
```
`smoke` resets the timer and refuses to run without `--isolated`. Start a test server with
`set DATA_DIR=C:\temp\sfi-test` and `set PORT=8099` before `npm start`. **Never point tests at the event server.**

## 8. Troubleshooting

| Problem | What happens / what to do |
|---|---|
| Wi-Fi drops | Displays keep counting from the last synced deadline with a large *Reconnecting* banner (red after 1 min). Stale connections are detected within ~12 s and reconnect automatically. The laptop's own projector window uses `localhost` and is unaffected. |
| Server window closed / laptop rebooted | Run `START-EVENT.bat` again — state is restored from `data\`. Displays reconnect by themselves. |
| Server says build mismatch | Someone changed files after preparation. Run `PREPARE-EVENT.bat` (needs internet for `npm ci`). Emergency only: `set ALLOW_STALE_BUILD=1` before starting. |
| "Changes are NOT being saved" | Check disk space / that `data\` is writable / antivirus. The event continues; saving retries every 5 s. |
| Recovery needed at startup | Follow the Recovery panel in `/admin` (restore from a display's copy is usually best). |
| Projector stutters | Presentation → **Performance mode** (also try turning off Scanline texture). |
| No sound at the end | The projector page needs one click. Event server panel shows *sound NOT armed*; use **Test on projector speakers**. If the browser blocked the finish sound, the projector shows a *click to play* button. |
| Phone can't reach laptop | Control from the laptop's `/admin`, or use a hotspot (§3). |
| No server at all | Open `http://localhost:8080/admin?local=1` only by explicit choice: **Local mode** stores state in that one browser, syncs only its tabs, and cannot control any other device. It never merges with server state. |
| Laptop clock wrong | The laptop clock is the reference — sync Windows time before the event. |

## Project layout

```
server/index.ts          WebSocket + HTTP server: validation, auth & rate limits, acks, recovery
server/persistence.ts    Atomic saves, backups, damaged-file preservation, validated recovery
server/sourceHash.ts     Build/source verification
src/shared/model.ts      State machine, reducer, strict validation (commands, envelopes, saved state)
src/lib/store.ts         Sync client: reconnection, stale detection, retries/dedup, acks, local mode
src/lib/clock.ts         Shared timestamp clock with selector subscriptions
src/display/*            Projector page
src/admin/*              Organizer panel
scripts/*                Tests and build verification
PREPARE-EVENT.bat / START-EVENT.bat   (prepare-event.sh / start-event.sh on macOS/Linux)
```
