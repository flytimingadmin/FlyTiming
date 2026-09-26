-- FlyTiming — finish video (build step 4)
-- Finish phone records a canvas (camera + burned-in clock + timecode strip)
-- and uploads it in ~1 s chunks to Storage:
--   race-video/<race_id>/<recording_id>/<00000>.<ext>
-- Chunks concatenated in order form one playable file.

crxeate table public.recordings (
  id                uuid primary key default gen_random_uuid(),
  race_id           uuid not null references public.races (id) on delete cascade,
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  status            text not null default 'recording'
                      check (status in ('recording', 'complete', 'failed')),
  mime_type         text not null,          -- full recorder type incl. codecs
  file_ext          text not null check (file_ext in ('mp4', 'webm')),
  chunk_count       integer not null default 0,
  started_at        timestamptz not null,   -- synced clock when the recorder started
  ended_at          timestamptz,
  width             integer,
  height            integer,
  fps               real,
  timecode_version  smallint not null default 1,  -- layout of the burned-in strip
  clock_offset_ms   double precision,
  clock_rtt_ms      double precision,
  device_label      text,
  expires_at        timestamptz not null default now() + interval '30 days',  -- retention target
  created_at        timestamptz not null default now()
);

create index recordings_race_idx on public.recordings (race_id, created_at desc);

alter table public.recordings enable row level security;

create policy "members manage recordings" on public.recordings
  for all to authenticated
  using (public.is_race_member(race_id))
  with check (public.is_race_member(race_id));

-- A completed recording moves the heat to 'uploaded' (awaiting scoring).
create function public.sync_race_status_from_recording()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'complete' and (tg_op = 'INSERT' or old.status is distinct from 'complete') then
    update public.races
       set status = 'uploaded'
     where id = new.race_id
       and status in ('needsLanes', 'readyToStart');
  end if;
  return null;
end;
$$;

create trigger recordings_sync_race_status
  after insert or update of status on public.recordings
  for each row execute function public.sync_race_status_from_recording();

alter publication supabase_realtime add table public.recordings;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('race-video', 'race-video', false, 52428800, array['video/mp4', 'video/webm'])
on conflict (id) do nothing;

-- First path segment is the race ID; members of that race's meet get access.
create function public.can_access_race_video(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_race_id uuid;
begin
  begin
    v_race_id := split_part(p_name, '/', 1)::uuid;
  exception when others then
    return false;
  end;
  return public.is_race_member(v_race_id);
end;
$$;

revoke execute on function public.can_access_race_video(text) from public, anon;
grant  execute on function public.can_access_race_video(text) to authenticated;

create policy "members upload race video" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'race-video' and public.can_access_race_video(name));

create policy "members read race video" on storage.objects
  for select to authenticated
  using (bucket_id = 'race-video' and public.can_access_race_video(name));

create policy "members delete race video" on storage.objects
  for delete to authenticated
  using (bucket_id = 'race-video' and public.can_access_race_video(name));
