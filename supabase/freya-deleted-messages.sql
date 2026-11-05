-- Run this SQL in Supabase Dashboard > SQL Editor (after freya-messages.sql).
--
-- 1. freya_deleted_messages: messages deleted "for me", and every message of a cleared chat
--    (lib/one-chat). They leave the chat on every device, but FREYA still reads them. A message
--    deleted "for everyone" is removed outright and never lands here.
-- 2. The freya-files storage bucket: pictures (at full quality) and other files from the chat,
--    so they follow the account to any device (lib/attachment-store). Private: each account
--    reaches only its own folder.
-- Never disable RLS.
create table if not exists public.freya_deleted_messages (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 80),
  at timestamptz not null default now(),
  deleted_at timestamptz not null default now(),
  message jsonb not null,
  primary key (user_id, id),
  constraint freya_deleted_messages_size_check check (pg_column_size(message) < 65536)
);

create index if not exists freya_deleted_messages_user_at_idx on public.freya_deleted_messages (user_id, at);

alter table public.freya_deleted_messages enable row level security;

drop policy if exists "Users can read own deleted FREYA messages" on public.freya_deleted_messages;
create policy "Users can read own deleted FREYA messages"
  on public.freya_deleted_messages for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can write own deleted FREYA messages" on public.freya_deleted_messages;
create policy "Users can write own deleted FREYA messages"
  on public.freya_deleted_messages for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can change own deleted FREYA messages" on public.freya_deleted_messages;
create policy "Users can change own deleted FREYA messages"
  on public.freya_deleted_messages for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own deleted FREYA messages" on public.freya_deleted_messages;
create policy "Users can delete own deleted FREYA messages"
  on public.freya_deleted_messages for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.freya_deleted_messages to authenticated;

-- Files: one private bucket, a folder per account (<user id>/<file id>.json).
insert into storage.buckets (id, name, public)
values ('freya-files', 'freya-files', false)
on conflict (id) do nothing;

drop policy if exists "Users can read own FREYA files" on storage.objects;
create policy "Users can read own FREYA files"
  on storage.objects for select to authenticated
  using (bucket_id = 'freya-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can add own FREYA files" on storage.objects;
create policy "Users can add own FREYA files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'freya-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can replace own FREYA files" on storage.objects;
create policy "Users can replace own FREYA files"
  on storage.objects for update to authenticated
  using (bucket_id = 'freya-files' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'freya-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can delete own FREYA files" on storage.objects;
create policy "Users can delete own FREYA files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'freya-files' and (storage.foldername(name))[1] = auth.uid()::text);
