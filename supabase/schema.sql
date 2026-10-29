-- Run this SQL in Supabase Dashboard > SQL Editor.
-- Each user can only access their own memory rows. Never disable RLS.
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(trim(content)) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upgrade older installations that stored the memory in a `text` column.
-- Keep that legacy column intact so this migration never deletes user data.
alter table public.memories add column if not exists content text;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'memories' and column_name = 'text'
  ) then
    execute 'update public.memories set content = coalesce(content, text::text) where content is null';
    execute 'alter table public.memories alter column text drop not null';
  end if;
end $$;

alter table public.memories alter column content set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.memories'::regclass and conname = 'memories_content_length_check'
  ) then
    alter table public.memories
      add constraint memories_content_length_check
      check (char_length(trim(content)) between 1 and 2000);
  end if;
end $$;

create index if not exists memories_user_created_idx
  on public.memories (user_id, created_at desc);

alter table public.memories enable row level security;

drop policy if exists "Users can read own memories" on public.memories;
create policy "Users can read own memories"
  on public.memories for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create own memories" on public.memories;
create policy "Users can create own memories"
  on public.memories for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own memories" on public.memories;
create policy "Users can update own memories"
  on public.memories for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own memories" on public.memories;
create policy "Users can delete own memories"
  on public.memories for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.memories to authenticated;
