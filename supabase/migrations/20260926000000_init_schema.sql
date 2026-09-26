-- FlyTiming — initial schema
-- Meets → Races (heats) → Lane assignments → Start events → Results
--
-- Access model: the coach signs in normally and owns the meet. Volunteers on
-- extra phones sign in anonymously (supabase.auth.signInAnonymously()) and
-- call join_meet('<code>') to become members of that one meet.
--
-- Video chunks live in Supabase Storage (keyed by race ID) and are added in
-- build step 4; nothing here depends on them.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- Race lifecycle. Labels match CLAUDE.md so app code can use them verbatim.
--   needsLanes    → no lanes assigned yet
--   readyToStart  → lanes assigned, waiting for the gun
--   uploaded      → finish video is in Storage (set by the finish phone)
--   scored        → every assigned lane has a result
create type public.race_status as enum (
  'needsLanes',
  'readyToStart',
  'uploaded',
  'scored'
);

-- Outcome per lane. Hy-Tek / Athletic.net both distinguish these on import.
create type public.result_status as enum (
  'finished',
  'dnf',
  'dns',
  'dq'
);

create type public.start_source as enum (
  'manual',   -- v1 default: start phone tap
  'audio'     -- future: mic-threshold gun detection
);

create type public.meet_role as enum (
  'owner',
  'volunteer'
);

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 6 characters from a 32-symbol alphabet with no look-alikes (no I, O, 0, 1).
-- 32 divides 256 evenly, so byte % 32 has no bias.
create function public.generate_join_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(6);
  code text := '';
begin
  for i in 0..5 loop
    code := code || substr(alphabet, 1 + (get_byte(bytes, i) % 32), 1);
  end loop;
  return code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Meets
-- ---------------------------------------------------------------------------

create table public.meets (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  meet_date   date not null,
  location    text,
  join_code   text unique check (join_code ~ '^[A-HJ-NP-Z2-9]{6}$'),  -- null = joining disabled
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index meets_owner_date_idx on public.meets (owner_id, meet_date desc);

create trigger meets_set_updated_at
  before update on public.meets
  for each row execute function public.set_updated_at();

-- Assign a unique join code on creation (security definer so the uniqueness
-- check sees every meet, not just the caller's).
create function public.set_meet_join_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if new.join_code is null then
    loop
      v_code := public.generate_join_code();
      exit when not exists (select 1 from public.meets where join_code = v_code);
    end loop;
    new.join_code := v_code;
  end if;
  return new;
end;
$$;

create trigger meets_set_join_code
  before insert on public.meets
  for each row execute function public.set_meet_join_code();

-- ---------------------------------------------------------------------------
-- Meet members — who can work a meet (owner + volunteers)
-- ---------------------------------------------------------------------------

create table public.meet_members (
  meet_id       uuid not null references public.meets (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          public.meet_role not null default 'volunteer',
  display_name  text,                     -- e.g. 'Start line – Sam'
  joined_at     timestamptz not null default now(),
  primary key (meet_id, user_id)
);

create index meet_members_user_idx on public.meet_members (user_id);

-- The creator is automatically the owner-member.
create function public.add_meet_owner_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.meet_members (meet_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return null;
end;
$$;

create trigger meets_add_owner_member
  after insert on public.meets
  for each row execute function public.add_meet_owner_member();

-- ---------------------------------------------------------------------------
-- Races (heats) — always belong to a meet
-- ---------------------------------------------------------------------------

create table public.races (
  id            uuid primary key default gen_random_uuid(),
  meet_id       uuid not null references public.meets (id) on delete cascade,
  event_name    text not null check (length(trim(event_name)) > 0),  -- e.g. '100m', '110m Hurdles'
  gender        text check (gender in ('F', 'M', 'X')),
  round         text not null default 'final',                       -- 'prelim', 'final', ...
  heat_number   smallint not null default 1 check (heat_number >= 1),
  sort_order    integer not null default 0,                          -- dashboard / schedule order
  scheduled_at  timestamptz,
  status        public.race_status not null default 'needsLanes',
  scored_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index races_meet_order_idx on public.races (meet_id, sort_order, scheduled_at);
create index races_meet_status_idx on public.races (meet_id, status);

create trigger races_set_updated_at
  before update on public.races
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Lane assignments — per race: lane number → athlete
-- ---------------------------------------------------------------------------
-- Athlete fields are stored inline for v1 (no roster table yet). First/last
-- are split because Hy-Tek-style imports expect them separately.

create table public.lane_assignments (
  id                  uuid primary key default gen_random_uuid(),
  race_id             uuid not null references public.races (id) on delete cascade,
  lane                smallint not null check (lane between 1 and 12),
  athlete_first_name  text not null,
  athlete_last_name   text not null,
  team                text,
  bib                 text,
  grade               smallint,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (race_id, lane)
);

create trigger lane_assignments_set_updated_at
  before update on public.lane_assignments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Start events — race ID + gun timestamp on the synced clock
-- ---------------------------------------------------------------------------
-- A race can have several rows (false start / recall), but only one live one:
-- recalling a start sets voided_at, then a new row is inserted.

create table public.start_events (
  id                uuid primary key default gen_random_uuid(),
  race_id           uuid not null references public.races (id) on delete cascade,
  started_at        timestamptz not null,   -- gun time, already corrected to the shared clock
  source            public.start_source not null default 'manual',
  clock_offset_ms   double precision,       -- device offset applied at calibration (for auditing)
  clock_rtt_ms      double precision,       -- round-trip time of that calibration
  device_label      text,
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  voided_at         timestamptz,
  created_at        timestamptz not null default now()
);

create unique index start_events_one_live_per_race
  on public.start_events (race_id)
  where voided_at is null;

-- ---------------------------------------------------------------------------
-- Results — per race, per lane
-- ---------------------------------------------------------------------------
-- The composite FK guarantees a result is only logged for an assigned lane,
-- which is what makes "press the lane number" scoring safe.

create table public.results (
  id             uuid primary key default gen_random_uuid(),
  race_id        uuid not null,
  lane           smallint not null,
  status         public.result_status not null default 'finished',
  elapsed_ms     integer check (elapsed_ms > 0),  -- finish time since the gun
  video_time_ms  integer,                          -- position in the finish video where it was marked
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (race_id, lane),
  foreign key (race_id, lane)
    references public.lane_assignments (race_id, lane)
    on delete cascade on update cascade,
  check ((status = 'finished') = (elapsed_ms is not null))
);

create trigger results_set_updated_at
  before update on public.results
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Race status automation
-- ---------------------------------------------------------------------------
-- Keeps status consistent no matter which device made the change. The
-- finish phone sets 'uploaded' itself; everything else is derived here.

-- needsLanes ⇄ readyToStart as lanes are added/removed (only before the race runs).
create function public.sync_race_status_from_lanes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_race_id uuid := coalesce(new.race_id, old.race_id);
begin
  update public.races r
     set status = case
                    when exists (select 1 from public.lane_assignments la where la.race_id = r.id)
                      then 'readyToStart'::public.race_status
                    else 'needsLanes'::public.race_status
                  end
   where r.id = v_race_id
     and r.status in ('needsLanes', 'readyToStart');
  return null;
end;
$$;

create trigger lane_assignments_sync_race_status
  after insert or delete on public.lane_assignments
  for each row execute function public.sync_race_status_from_lanes();

-- uploaded → scored when every assigned lane has a result; back to uploaded
-- if a result is removed.
create function public.sync_race_status_from_results()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_race_id uuid := coalesce(new.race_id, old.race_id);
  v_complete boolean;
begin
  select not exists (
           select 1
             from public.lane_assignments la
        left join public.results res
               on res.race_id = la.race_id and res.lane = la.lane
            where la.race_id = v_race_id
              and res.id is null
         )
    into v_complete;

  update public.races
     set status    = case when v_complete then 'scored'::public.race_status
                          else 'uploaded'::public.race_status end,
         scored_at = case when v_complete then coalesce(scored_at, now()) else null end
   where id = v_race_id
     and status in ('uploaded', 'scored');
  return null;
end;
$$;

create trigger results_sync_race_status
  after insert or delete on public.results
  for each row execute function public.sync_race_status_from_results();

-- ---------------------------------------------------------------------------
-- Clock sync
-- ---------------------------------------------------------------------------
-- Devices call this via supabase.rpc('server_now') several times, measure
-- round-trip, and compute offset = server_time - (t_send + rtt / 2).
-- clock_timestamp() (not now()) so it reflects the actual moment of the call.

create function public.server_now()
returns timestamptz
language sql
volatile
as $$
  select clock_timestamp();
$$;

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------

create function public.is_meet_member(p_meet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.meet_members mm
     where mm.meet_id = p_meet_id
       and mm.user_id = (select auth.uid())
  );
$$;

create function public.is_meet_owner(p_meet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.meet_members mm
     where mm.meet_id = p_meet_id
       and mm.user_id = (select auth.uid())
       and mm.role = 'owner'
  );
$$;

create function public.is_race_member(p_race_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.races r
      join public.meet_members mm on mm.meet_id = r.meet_id
     where r.id = p_race_id
       and mm.user_id = (select auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- Join codes
-- ---------------------------------------------------------------------------

-- Volunteer phone: signInAnonymously(), then rpc('join_meet', { p_code, p_display_name }).
-- Returns the meet ID. Case- and punctuation-insensitive ("abc-234" works).
create function public.join_meet(p_code text, p_display_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_meet_id uuid;
begin
  if v_uid is null then
    raise exception 'Sign in before joining a meet' using errcode = '28000';
  end if;

  select id into v_meet_id
    from public.meets
   where join_code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));

  if v_meet_id is null then
    raise exception 'Invalid join code' using errcode = 'P0002';
  end if;

  insert into public.meet_members (meet_id, user_id, role, display_name)
  values (v_meet_id, v_uid, 'volunteer', nullif(trim(p_display_name), ''))
  on conflict (meet_id, user_id) do update
    set display_name = coalesce(excluded.display_name, public.meet_members.display_name);

  return v_meet_id;
end;
$$;

-- Owner only: issue a fresh code (old one stops working; existing members stay).
-- To turn joining off entirely, the owner sets meets.join_code = null.
create function public.rotate_join_code(p_meet_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if not public.is_meet_owner(p_meet_id) then
    raise exception 'Only the meet owner can change the join code' using errcode = '42501';
  end if;

  loop
    v_code := public.generate_join_code();
    exit when not exists (select 1 from public.meets where join_code = v_code);
  end loop;

  update public.meets set join_code = v_code where id = p_meet_id;
  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Owners and volunteers can both work every race in their meet. Only the
-- owner can edit/delete the meet itself or remove other members. Anonymous
-- (volunteer) accounts cannot create meets.

alter table public.meets            enable row level security;
alter table public.meet_members     enable row level security;
alter table public.races            enable row level security;
alter table public.lane_assignments enable row level security;
alter table public.start_events     enable row level security;
alter table public.results          enable row level security;

-- owner_id check first: the owner's meet_members row is added by an AFTER
-- trigger, which hasn't run yet when insert().select() reads the new row back.
create policy "members read their meets" on public.meets
  for select to authenticated
  using (owner_id = (select auth.uid()) or public.is_meet_member(id));

create policy "signed-in coaches create meets" on public.meets
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  );

create policy "owners update their meets" on public.meets
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "owners delete their meets" on public.meets
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- Rows are only added by join_meet() / the owner trigger, so no insert policy.
create policy "members see who else is on the meet" on public.meet_members
  for select to authenticated
  using (public.is_meet_member(meet_id));

create policy "owners remove members; anyone can leave" on public.meet_members
  for delete to authenticated
  using (
    (public.is_meet_owner(meet_id) and role <> 'owner')
    or (user_id = (select auth.uid()) and role <> 'owner')
  );

create policy "members manage races" on public.races
  for all to authenticated
  using (public.is_meet_member(meet_id))
  with check (public.is_meet_member(meet_id));

create policy "members manage lane assignments" on public.lane_assignments
  for all to authenticated
  using (public.is_race_member(race_id))
  with check (public.is_race_member(race_id));

create policy "members manage start events" on public.start_events
  for all to authenticated
  using (public.is_race_member(race_id))
  with check (public.is_race_member(race_id));

create policy "members manage results" on public.results
  for all to authenticated
  using (public.is_race_member(race_id))
  with check (public.is_race_member(race_id));

-- Function privileges: internal helpers are not callable from the API.
revoke execute on function public.generate_join_code()          from public, anon, authenticated;
revoke execute on function public.is_meet_member(uuid)          from public, anon;
revoke execute on function public.is_meet_owner(uuid)           from public, anon;
revoke execute on function public.is_race_member(uuid)          from public, anon;
revoke execute on function public.join_meet(text, text)         from public, anon;
revoke execute on function public.rotate_join_code(uuid)        from public, anon;
revoke execute on function public.server_now()                  from public, anon;
grant  execute on function public.is_meet_member(uuid)          to authenticated;
grant  execute on function public.is_meet_owner(uuid)           to authenticated;
grant  execute on function public.is_race_member(uuid)          to authenticated;
grant  execute on function public.join_meet(text, text)         to authenticated;
grant  execute on function public.rotate_join_code(uuid)        to authenticated;
grant  execute on function public.server_now()                  to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- start_events: finish phone reacts to the gun instantly.
-- races / results: meet dashboard and scoring screen stay live.
-- (Realtime respects the RLS above, so volunteers only hear their meet.)

alter publication supabase_realtime
  add table public.start_events, public.races, public.results;
