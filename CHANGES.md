# Changes in v1.1 (16 Nov 2026)

Same poster branding, colours, layout, large countdown and announcements. Changes are about
reliability, correctness and smooth rendering.

## Rendering / frame drops
- Removed animated `blur(110px)` glows and `backdrop-filter` glass (largest costs); same look via gradients.
- Perspective grids redrawn on one flat canvas (identical projection) instead of two 3840-px masked 3D layers.
- All continuous animations are transform/opacity only; digit/overlay transitions no longer animate `filter`/`letter-spacing`.
- Only the digits and the IST clock re-render each second (was: the whole display).
- Particles bounded, DPR 1, 30 fps ambient, stopped when hidden; decoration paused while the tab is hidden.
- New **Performance mode**; OS **reduced motion** honoured everywhere (particles, digits, ticker, pulses).
- Ticker: seamless loop for short lists, restarts only when content changes; static mode shows the full text.

## Server safety
- Every WebSocket message is fully validated before use (the `null` crash is fixed); per-socket error handling;
  malformed/oversized/binary/flooding clients are rejected without affecting others.
- PIN attempts limited per address across connections (bounded, expiring); global burst protection that never
  locks out the organizer laptop; Origin/Host validation (blocks cross-site and DNS-rebinding pages);
  connection and message-rate limits; command de-duplication; stale-timer conflict detection.

## Persistence & recovery
- Atomic save (temp → fsync → keep previous `.bak` → rename) for every command and on shutdown.
- Missing vs damaged state distinguished; damaged files preserved; validated backup recovery; recovery mode
  (restore from a display's cached copy, manual restore, or typed "START FRESH") instead of a silent reset.
- Admin shows persistence health, last save time and saved revision; commands report *applied* vs *saved*.

## Timer, simulations, end of event
- Admin always shows the REAL timer (fixes 24 h shown when 23 h remained).
- Isolated "Preview here"; projector rehearsals need Rehearsal mode and are refused while the event is
  running/paused/finished; real start/finish always overrides a rehearsal; stopping removes overlays at once.
- `completedAt` + session identity: finish sound once per live finish, never on reload, honest when blocked
  (click-to-play prompt), replay after a genuine extension; projector sound readiness visible in admin;
  separate "Test on THIS device" and "Test on projector speakers".
- Scheduling after a finished event creates a new session; no default start time; IST start/end confirmation;
  ±1/±5 min are server-side relative adjustments (cumulative, predictable).

## Connectivity & organizer UX
- Always reconnects to the server; local mode only by explicit choice, clearly labelled, never merged.
- Stale-connection detection (~12 s), auth cleared on disconnect and restored only after re-authentication,
  controls disabled while offline, display acknowledgements ("confirmed by the screen itself").
- Masked PIN, double-submit protection, "outcome unknown" on lost replies, typed confirmation for live reset.
- Larger/higher-contrast secondary labels, bigger connection warnings, scanline/glow toggles, phone layout with
  44 px touch targets, labelled inputs, focus-trapped dialogs.
- Sample timetable announcements are now inactive drafts with placeholder times.

## Startup
- `PREPARE-EVENT.bat` (lockfile install, typecheck, tests, build, verification) separated from
  `START-EVENT.bat` (offline; refuses a build that doesn't match the source). Build identifier everywhere.
