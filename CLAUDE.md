# FlyTiming

A free, phone-based race-timing system for track & cross country. Two phones
share a synced clock; a start phone logs the gun, a finish phone records
video against that clock, and a scoring device reviews the footage to log
times — no dedicated FAT timing hardware required.

Companion project to Coach's Clock (same stack: Vercel + Supabase).

## The four devices

1. **Heat & Lane Setup** — before a race, assigns athletes to lanes for a
   given heat. Pushes a lane-assignment record to Supabase keyed by race ID.
2. **Start Phone** — listens for the gun (manual tap for v1; mic-threshold
   auto-detect as a stretch goal) and posts the race-start timestamp.
3. **Finish Phone** — records video continuously, chunk-uploading to
   Supabase Storage as the race happens (via `MediaRecorder`'s
   `ondataavailable`), with a running clock overlay derived from a
   synced offset to the start timestamp.
4. **Scoring Device** — pulls the uploaded video (near-instantly, since
   it's chunk-uploaded), scrubs to each finisher, and presses the lane
   number to log that athlete's time — no name look-up needed, because
   lanes were already assigned pre-race.

## Clock sync approach

Not frame-by-frame video sync — a shared authoritative clock. At race
start, the finish phone does a round-trip timestamp exchange with the
Supabase backend to calibrate a clock offset (accounts for network
latency). All timestamps (gun, lane marks) are computed against this
shared clock, not each device's raw local clock.

Realistic precision target: **±30–50ms** — fine for regular-season/dual
meets and distance events, not for championship-level sprint finishes
requiring certified FAT (photo-finish hardware runs ~5–17ms and up).
Not a replacement for FAT-certified meets; positioned as an upgrade over
hand-timing for everyday use.

## Data model (Supabase / Postgres)

- **Meets** — a meet has many races. (New concept — build this first;
  don't let races float independently, or the dashboard/export below
  becomes a retrofit.)
- **Races** (heats) — belongs to a meet; has a status:
  `needsLanes` → `readyToStart` → `uploaded` → `scored`.
- **Lane assignments** — per race: lane number → athlete. Cheap on
  Supabase's free tier (small JSON/rows, not video).
- **Start events** — race ID + start timestamp (synced clock).
- **Video chunks / files** — Supabase Storage, keyed by race ID.
  Plan for auto-deletion/retention policy — video eats free-tier
  storage fast.
- **Results** — per race, per lane: logged finish time.

## Planned v1 features (build these in from the start, not bolted on later)

- **Meet dashboard** — single view of every scheduled heat in a meet with
  status (needs lanes / ready / uploaded / awaiting scoring / scored),
  so the scorer always knows what's next. Lives at the Meet level.
- **CSV / Hy-Tek-compatible export** — one button once a meet's heats are
  scored, exporting results in a format Hy-Tek Meet Manager / Athletic.net
  can import. Check their actual import spec/column format before building
  — don't guess. Lives at the meet-dashboard level ("export this meet's
  results"), not per-race.

## Scope note on lane-based scoring

Lane-key scoring (press the lane number to log a time) works cleanly for
**sprints and hurdles** where lanes are fixed for the whole race. It does
**not** apply to distance track (waterfall starts) or cross country (no
lanes at all) — those need visual/roster-based finisher marking instead.
Build lane-based scoring first (most mechanical, highest value), treat
distance/XC marking as a separate later problem.

## Stack

- **Supabase** — Postgres, Realtime (push start events to the finish
  phone instantly), Storage (video chunks). Free tier target for v1.
- **Vercel** — hosting.
- **Browser APIs only, no native app** — `getUserMedia`, `MediaRecorder`,
  Web Audio API (future auto gun-detection). Tested on Safari iOS and
  Chrome Android — iOS Safari has known quirks with background recording,
  test that early.

### Implementation choices (decided)

- **Frontend**: Vite + React + TypeScript SPA, `react-router-dom`,
  `@supabase/supabase-js`. Plain CSS with brand tokens in `src/styles.css`.
  `vercel.json` rewrites all routes to `index.html`.
- **Schema**: `supabase/migrations/`. TS row types are hand-mirrored in
  `src/lib/types.ts` (swap for `supabase gen types` later).
- **Access**: coach signs in by email magic link and owns the meet.
  Volunteer phones use Supabase anonymous sign-in + `join_meet(code)`
  (6-char code on `meets.join_code`; invite link `/join?code=XXXXXX`).
  Requires *Anonymous sign-ins* enabled in the Supabase dashboard.
- **Env**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (see `.env.example`).
- **Clock sync** (`src/lib/clock.ts`): raw `fetch` to `rpc/server_now`
  (not `supabase.rpc`, which awaits the session inside the timed window),
  1 warm-up + 7 samples, keep lowest RTT; error bound ≈ RTT/2. Re-syncs on
  page load and when the screen wakes; flagged stale after 5 min. Reuse
  `useClockSync()` / `syncedNow()` on the finish phone.
- **Gun detection** (default start trigger; "Tap only" toggle): mic with
  echoCancellation/noiseSuppression/autoGainControl OFF →
  `public/gun-detector.worklet.js` (AudioWorklet, v2). Signal is high-passed
  at 1.5 kHz (2nd-order Butterworth) and measured as RMS over a sliding
  3 ms window, so screen taps / strap rub / bumps (low-frequency) and
  single clicks can't trigger; voices sit low too. Triggers when that RMS ≥
  the trigger level (slider −40…0 dB, default −12; 0 dB = mic full scale,
  so it can't go higher) AND it jumped ≥ riseDb (slider 6–30, default 15)
  vs the same 3 ms window 5 ms earlier — guns are near-instant; crowd roar,
  cheers, horns and whistles build over tens of ms. Only while Set is armed; the first 400 ms after arming are
  ignored (the Set tap's thump) without starting the 1 s cooldown. Reported
  frame = first sample of the blast; the message waits 20 ms only to include
  the true peak level ("loudest recent" readout uses the same scale, for
  calibrating with a test shot). Frame → performance.now via the *minimum*
  (arrival − frame time) over recent level messages; minus starter distance
  (÷343 m/s) and a per-device latency setting. Settings key
  `flytiming.gunDetect.v2`. Synthetic-audio results: thump that clips the
  mic ≈ −22 dB, gun ≈ −4 dB, rub/shout/tick < −40 dB; over a −24 dB crowd
  roar the cheer / air horn / whistle never trigger even at −40 dB with a
  6 dB jump, the gun always does; two guns one loop apart measured
  6000 ms. Needs https (mic).
- **Meet-day setup** (decided): start phone strapped to the starter's
  forearm next to the gun (defaults: trigger −12 dB, distance 0.5 m); starter still taps Set before each gun. Finish phone on a tripod,
  manned. Lane device at the heating benches; scoring laptop in the press box.
- **Auto recall**: a gun-level sound 1–6 s after a start voids it (start
  phone returns to Set with a banner; it does NOT re-arm). The finish phone
  sees the start voided over Realtime, stops and marks that take `failed`
  (never scored), and auto-records the restart gun.
- **Heat screens remount per heat** (`PerHeat` in App.tsx) except the Start
  screen, which resets per-heat state itself so the mic stays on.
- **Start phone** (`/races/:id/start`): Set → Gun two-step to prevent
  pocket taps; gun time is taken from the `pointerdown` event timestamp.
  Unsent starts persist in localStorage and retry every 2s. Recall =
  set `voided_at`. Screen wake lock while open.
- **Stations**: meet page has a per-phone station picker (Lanes / Start /
  Finish; add Score in step 5) in `src/lib/stations.ts`.
- **Finish phone** (`/races/:id/finish`): camera → `<canvas>` each frame
  (`requestVideoFrameCallback`, using `captureTime` when available) with a
  burned-in clock overlay + **timecode strip** (`src/lib/timecode.ts`,
  `recordings.timecode_version = 1`: 40 cells along the bottom encoding
  the frame's synced epoch ms, low 32 bits + checksum). The canvas stream is
  what MediaRecorder records (mp4/avc1 preferred, 2.5 Mbps, keyframe + chunk
  every 1 s). Chunks upload to Storage `race-video/<race>/<recording>/00000.<ext>`
  via `ChunkUploader` (ordered, retry w/ backoff). Concatenating chunks in
  order gives a playable file. A `recordings` row tracks each take; marking
  it `complete` moves the race to `uploaded` (trigger). Auto-records when a
  new gun arrives over Realtime (toggle).
- **Scoring (step 5) should** read finish times from the timecode strip
  (`decodeTimecode` + `unwrapTimecode` against `recordings.started_at`),
  not from `video.currentTime`. Verified end-to-end in headless Chrome:
  9/9 frames decoded after compression, timeline agrees ±1 ms.
- **Scoring** (`/races/:id/score`): downloads the newest complete take's
  chunks (`src/lib/videoLoader.ts`), joins them into one Blob, and reads
  the timecode strip of the displayed frame on every
  `requestVideoFrameCallback` / `seeked` (copies only the strip rows).
  Race time = frame time − live start. Lane tap / number key upserts
  `results` (`elapsed_ms` exact, `video_time_ms` for jump-back). Frame
  step seeks to the *middle* of the next frame from the shown frame's
  `mediaTime` (stepping 1/fps from a boundary can land on the same frame).
- **Finish-line guide** (`src/lib/finishLine.ts`): operator drags top and
  bottom handles on the finish preview (tiltable line, stored per phone in
  localStorage, locked while recording). Drawn into every frame before the
  overlay/timecode, so it's burned into the video for the scorer.
- **Meet dashboard** (meet page, `src/lib/dashboard.ts`): derived heat
  states (needsLanes / ready / running / awaiting / scoring / scored) from
  races + lanes + starts + recordings + results; progress bar, status
  filter chips, "Next to start" / "Next to score" links, heats grouped by
  event. Reloads (debounced) on Realtime changes to any of those tables.
- **Rounding**: results display rounded UP to the hundredth
  (`formatResult`); ties at the displayed hundredth share a place. The
  export (step 7) must use the same rule.
- **Export** (`src/lib/export/`, card on the meet dashboard; scored heats only):
  - *Hy-Tek*: FinishLynx `.lif` per heat, zipped (`zip.ts`, stored/no
    compression). Header `Event,Round,Heat,Name,Wind,WindUnit,Template,
    CaptureTime,CaptureDuration,Distance,StartTime`; rows `Place,ID(bib),
    Lane,Last,First,Affiliation,Time,License,Delta,ReacTime,Splits,TTStart`.
    Raw thousandths (`12.345`, `4:32.345`); DNS/DNF/DQ in Place. Prelim +
    final share an event number (rounds 1/2). File name `EEE-R-HH.lif`.
    Imported in MM via Run → "Get Results From Lynx File".
  - *Athletic.net*: "Custom Format Track and Field" with headings
    (`Type,Gender,Event,Round,Heat,HeatPlace,Place,Result,Team,FirstName1,
    LastName1,Grade1`); Place is across heats (timed finals); Result rounded
    up to hundredths; CSV download or TSV copy for the Paste box. Relays are
    skipped there (needs leg names — not collected yet).
  - Timing method: manual-tap start + video finish is *not* FAT by the
    usual definition (automatic start). Coach picks on Athletic.net.
- **HTTPS for camera**: phones block the camera on plain http over Wi-Fi.
  `npm run dev:https` serves a self-signed cert on port 5174.

## Branding

Source: `docs/brand/FlyTiming_Branding_Package.pdf`, logo in
`docs/brand/ft-mark-original.png`. Personality: precise, fast, professional,
modern, athlete-focused.

- **Colors**: Carbon Black `#1B1C1D` (sampled from the logo), White,
  Electric Blue accent `#2E8BFF`. Tokens live on `:root` in `src/styles.css`.
- **Type**: geometric sans (Outfit via Google Fonts). Headings, labels and
  buttons uppercase with generous tracking (`--tracking: 0.12em`).
- **Logo assets**: `public/brand/ft-mark-white.png` (transparent white FT
  mark for use on dark backgrounds); app icons `public/icon-*.png`,
  `apple-touch-icon.png`, `favicon-32.png` (mark on carbon).
- Keep UI minimal; large tabular numerals for lanes and times.

## Known follow-up work (not v1, but keep in mind)

- Clock drift over a long meet — recalibrate offset per heat, not just once
  a day.
- Chunk upload retry/local buffering for flaky venue WiFi.
- Field usability: screen glare, battery drain, weatherproof mounting.
- Gun-detection false positives from crowd noise / different starting
  devices — manual tap should stay the default trigger, audio-detect as
  an optional enhancement layered in later.

## Suggested build order

1. Supabase schema: Meets → Races → Lane assignments → Start events →
   Results.
2. Heat & Lane Setup screen (device 1).
3. Start Phone screen + clock-sync calibration (device 2).
4. Finish Phone: video recording + chunked upload (device 3).
5. Scoring screen: video playback + lane-tap logging (device 4).
6. Meet dashboard (status overview, ties races to a meet).
7. CSV/Hy-Tek export.
