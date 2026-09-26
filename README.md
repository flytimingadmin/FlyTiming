# FlyTiming

Free, phone-based race timing for track & field. A start phone hears the
gun, a finish phone records video with a synced clock and a burned-in
timecode, and a scoring device logs each lane's time from the video — no
dedicated timing hardware.

Built with React + Vite, hosted on Vercel, backed by Supabase (Postgres,
Realtime, Storage).

## Setup

1. Create a Supabase project and run the SQL files in `supabase/migrations/`
   in order (SQL Editor → New query → Run).
2. In Supabase → Authentication, enable **Anonymous sign-ins** (volunteer
   join codes) and add your site URL to the allowed redirect URLs.
3. Copy `.env.example` to `.env.local` and fill in your project URL and
   publishable (anon) key.
4. `npm install`, then `npm run dev` (or `npm run dev:https` to test the
   camera and microphone on phones over Wi-Fi).

See `CLAUDE.md` for architecture and design notes.

## Accuracy

FlyTiming targets roughly ±30–50 ms — an upgrade over hand timing for
regular-season meets. It is not a certified FAT system.
