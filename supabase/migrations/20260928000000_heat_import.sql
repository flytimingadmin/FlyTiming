-- FlyTiming — heat import (preheated meets)
-- Division (Varsity / JV / Frosh-Soph …) makes "JV Girls 100m" and
-- "Varsity Girls 100m" separate events. The ext_* columns keep Hy-Tek Meet
-- Manager's own event and round numbers from an imported lynx.evt, so
-- exported .lif results line up with Meet Manager exactly.

alter table public.races
  add column division         text,
  add column ext_event_number integer check (ext_event_number > 0),
  add column ext_round        smallint check (ext_round > 0);

create index races_meet_ext_idx
  on public.races (meet_id, ext_event_number, ext_round, heat_number)
  where ext_event_number is not null;
