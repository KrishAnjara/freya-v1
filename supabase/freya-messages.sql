-- Run this SQL in Supabase Dashboard > SQL Editor.
-- The one long chat with FREYA (lib/one-chat), kept with the account so it follows you to any
-- browser and the whole history is there for her. One row per message. Each user can only reach
-- their own rows. Never disable RLS.
create table if not exists public.freya_messages (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 80),
  at timestamptz not null default now(),
  message jsonb not null,
  primary key (user_id, id),
  -- Messages, not files: attachments stay in the browser, only their names travel.
  constraint freya_messages_size_check check (pg_column_size(message) < 65536)
);

create index if not exists freya_messages_user_at_idx on public.freya_messages (user_id, at);

alter table public.freya_messages enable row level security;

drop policy if exists "Users can read own FREYA messages" on public.freya_messages;
create policy "Users can read own FREYA messages"
  on public.freya_messages for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can write own FREYA messages" on public.freya_messages;
create policy "Users can write own FREYA messages"
  on public.freya_messages for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can change own FREYA messages" on public.freya_messages;
create policy "Users can change own FREYA messages"
  on public.freya_messages for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own FREYA messages" on public.freya_messages;
create policy "Users can delete own FREYA messages"
  on public.freya_messages for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.freya_messages to authenticated;
