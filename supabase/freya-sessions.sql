-- Run this SQL in Supabase Dashboard > SQL Editor.
-- One browser session per account (freya.config.json "oneSession"): each sign-in writes a new
-- random session id here, and the app refuses requests from any other browser of that account.
-- Each user can only reach their own row. Never disable RLS.
create table if not exists public.freya_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id text not null check (char_length(session_id) between 16 and 80),
  updated_at timestamptz not null default now()
);

alter table public.freya_sessions enable row level security;

drop policy if exists "Users can read own FREYA session" on public.freya_sessions;
create policy "Users can read own FREYA session"
  on public.freya_sessions for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can claim own FREYA session" on public.freya_sessions;
create policy "Users can claim own FREYA session"
  on public.freya_sessions for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can replace own FREYA session" on public.freya_sessions;
create policy "Users can replace own FREYA session"
  on public.freya_sessions for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update on public.freya_sessions to authenticated;

-- Sign-ups: turn them off in Supabase too (Authentication > Sign In / Providers > "Allow new users
-- to sign up" off), so nobody can create an account even outside the app.
