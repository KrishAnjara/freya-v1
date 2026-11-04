-- Run this SQL in Supabase Dashboard > SQL Editor (after schema.sql).
-- FREYA's state with each account, so it follows them to any browser: her mood, her read on how
-- they seem, and where the two of them are (lib/relationship). Her memories and personality are
-- in schema.sql and personality.sql. Each user can only reach their own row. Never disable RLS.
create table if not exists public.freya_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mood jsonb,
  user_mood jsonb,
  bond jsonb,
  updated_at timestamptz not null default now(),
  -- Small documents only: anything bigger isn't what the app writes.
  constraint freya_state_size_check check (
    pg_column_size(mood) < 16384 and pg_column_size(user_mood) < 4096 and pg_column_size(bond) < 16384
  )
);

alter table public.freya_state enable row level security;

drop policy if exists "Users can read own FREYA state" on public.freya_state;
create policy "Users can read own FREYA state"
  on public.freya_state for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create own FREYA state" on public.freya_state;
create policy "Users can create own FREYA state"
  on public.freya_state for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own FREYA state" on public.freya_state;
create policy "Users can update own FREYA state"
  on public.freya_state for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own FREYA state" on public.freya_state;
create policy "Users can delete own FREYA state"
  on public.freya_state for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.freya_state to authenticated;
