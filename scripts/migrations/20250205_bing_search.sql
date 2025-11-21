-- Create search_queue to track Bing discovery jobs
create table if not exists public.search_queue (
  id bigserial primary key,
  jurisdiction_geoid text not null,
  jurisdiction_name text not null,
  jurisdiction_type text not null, -- 'county' or 'place'
  query text not null,
  status text not null default 'pending', -- 'pending' | 'running' | 'done' | 'error'
  attempt_count int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint search_queue_type_check check (jurisdiction_type in ('county','place')),
  constraint search_queue_status_check check (status in ('pending','running','done','error')),
  constraint search_queue_unique_geoid_query unique (jurisdiction_geoid, query)
);

create index if not exists idx_search_queue_status_created_at
  on public.search_queue (status, created_at);

-- Create portal_candidates to store raw Bing results
create table if not exists public.portal_candidates (
  id bigserial primary key,
  jurisdiction_geoid text not null,
  query_used text not null,
  url_found text not null,
  vendor_type text not null default 'unknown',
  confidence numeric not null default 0.0,
  source text not null default 'bing',
  created_at timestamptz not null default now()
);

create index if not exists idx_portal_candidates_geoid
  on public.portal_candidates (jurisdiction_geoid);

create index if not exists idx_portal_candidates_vendor
  on public.portal_candidates (vendor_type);

create unique index if not exists idx_portal_candidates_geoid_url
  on public.portal_candidates (jurisdiction_geoid, url_found);

-- Seed search_queue from Census counties
insert into public.search_queue (jurisdiction_geoid, jurisdiction_name, jurisdiction_type, query)
select
  c.geoid,
  c.name,
  'county' as jurisdiction_type,
  c.name || ' County ' || c.statefp || ' building permits' as query
from public.county_2025 c
where c.geoid is not null
  and c.name is not null
on conflict (jurisdiction_geoid, query) do nothing;

-- Seed search_queue from Census places
insert into public.search_queue (jurisdiction_geoid, jurisdiction_name, jurisdiction_type, query)
select
  p.geoid,
  p.name,
  'place' as jurisdiction_type,
  p.name || ' ' || p.statefp || ' building permits' as query
from public.place_2025 p
where p.geoid is not null
  and p.name is not null
on conflict (jurisdiction_geoid, query) do nothing;
