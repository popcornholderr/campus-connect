-- ============================================================================
-- schema.sql — run this once in Supabase → SQL Editor → New query → Run
-- ----------------------------------------------------------------------------
-- Creates the three tables the app needs, and locks them down with Row Level
-- Security so access control is enforced by Postgres itself — not just by
-- the app's JS, which anyone could edit or bypass with the browser console.
-- ============================================================================

-- ---------- users ----------
create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  enrollment text unique not null,
  email text unique not null,
  name text default '',
  username text default '',
  username_lower text default '',
  photo text,
  age int,
  branch text,
  semester int default 1,
  place_type text default 'hostel',
  place text default '',
  relationship text default '',
  phone text default '',
  social text default '',
  pos jsonb default '{"x":0.35,"y":0.55}'::jsonb,
  active boolean default true,
  onboarded boolean default false,
  last_seen bigint,
  friends uuid[] default '{}',
  blocked uuid[] default '{}'
);

-- Case-insensitive username uniqueness (only enforced once a username is set)
create unique index if not exists users_username_lower_idx
  on public.users (username_lower) where username_lower <> '';

-- ---------- comments ----------
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  from_id uuid references public.users (id) on delete cascade not null,
  to_id uuid references public.users (id) on delete cascade not null,
  text text not null check (char_length(text) <= 500),
  ts bigint not null
);
create index if not exists comments_to_id_ts_idx on public.comments (to_id, ts desc);
create index if not exists comments_from_id_ts_idx on public.comments (from_id, ts desc);

-- ---------- likes ----------
create table if not exists public.likes (
  id uuid primary key default gen_random_uuid(),
  from_id uuid references public.users (id) on delete cascade not null,
  to_id uuid references public.users (id) on delete cascade not null,
  ts bigint not null
);
create index if not exists likes_to_id_ts_idx on public.likes (to_id, ts desc);
create index if not exists likes_from_id_ts_idx on public.likes (from_id, ts desc);

-- ============================================================================
-- Row Level Security — this is what actually enforces "only real
-- darshan.ac.in students, and only the two people in a conversation can
-- read it," no matter what the client-side JS does.
-- ============================================================================
alter table public.users enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;

-- users: any signed-in darshan.ac.in student can read the directory (needed
-- for the map, search, and friends list). A user can only create/edit their
-- OWN row, and only while their auth email really is a darshan.ac.in address.
create policy "users readable by authenticated darshan students"
  on public.users for select
  using (auth.role() = 'authenticated' and (auth.jwt() ->> 'email') like '%@darshan.ac.in');

create policy "users insert own row only"
  on public.users for insert
  with check (auth.uid() = id and (auth.jwt() ->> 'email') like '%@darshan.ac.in');

create policy "users update own row only"
  on public.users for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- comments: only the two people in a comment can ever read it. A comment can
-- only be created by the signed-in user as its from_id, and is immutable
-- afterward (no edit/delete — you can't retroactively rewrite what someone
-- already saw).
create policy "comments readable by participants only"
  on public.comments for select
  using (auth.uid() = from_id or auth.uid() = to_id);

create policy "comments insert as self only"
  on public.comments for insert
  with check (auth.uid() = from_id and (auth.jwt() ->> 'email') like '%@darshan.ac.in');

-- likes: same shape as comments.
create policy "likes readable by participants only"
  on public.likes for select
  using (auth.uid() = from_id or auth.uid() = to_id);

create policy "likes insert as self only"
  on public.likes for insert
  with check (auth.uid() = from_id and (auth.jwt() ->> 'email') like '%@darshan.ac.in');

-- ============================================================================
-- Realtime — without this, subscribeUsers()/subscribeMyActivity() in
-- js/store.supabase.js have nothing to attach to: the map's live pin
-- updates and the comment/like notification dots silently fail right
-- after login.
-- ============================================================================
alter publication supabase_realtime add table public.users;
alter publication supabase_realtime add table public.comments;
alter publication supabase_realtime add table public.likes;

-- ============================================================================
-- Storage: profile photo bucket + policies
-- Run this too — creates a public-read bucket where each student can only
-- write a file named after their own user id (their photo), nobody else's.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('profile-photos', 'profile-photos', true)
on conflict (id) do nothing;

create policy "profile photos are publicly readable"
  on storage.objects for select
  using (bucket_id = 'profile-photos');

create policy "students can only upload their own photo"
  on storage.objects for insert
  with check (bucket_id = 'profile-photos' and name = auth.uid()::text || '.jpg');

create policy "students can only overwrite their own photo"
  on storage.objects for update
  using (bucket_id = 'profile-photos' and name = auth.uid()::text || '.jpg');
