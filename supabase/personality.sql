-- Apply after the existing schema.sql. This is an additive, user-owned schema;
-- it does not modify memories or replace their RLS policies.
create table if not exists public.freya_personality_revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  revision bigint not null check (revision > 0),
  profile jsonb not null check (
    jsonb_typeof(profile) = 'object'
    and profile ? 'preferences'
    and jsonb_typeof(profile->'preferences') = 'array'
    and jsonb_array_length(profile->'preferences') <= 20
  ),
  summary text not null default '' check (char_length(summary) <= 500),
  rollback_from bigint,
  created_at timestamptz not null default now(),
  unique (user_id, revision)
);

create index if not exists freya_personality_revisions_user_idx
  on public.freya_personality_revisions (user_id, revision desc);

alter table public.freya_personality_revisions enable row level security;
drop policy if exists "Users can read own FREYA personality revisions" on public.freya_personality_revisions;
create policy "Users can read own FREYA personality revisions"
  on public.freya_personality_revisions for select to authenticated
  using (auth.uid() = user_id);
drop policy if exists "Users can append own FREYA personality revisions" on public.freya_personality_revisions;
create policy "Users can append own FREYA personality revisions"
  on public.freya_personality_revisions for insert to authenticated
  with check (auth.uid() = user_id);
grant select, insert on public.freya_personality_revisions to authenticated;

-- Append-only transaction gives concurrent clients one stable revision sequence.
create or replace function public.append_freya_personality_revision(
  p_profile jsonb,
  p_summary text default '',
  p_rollback_from bigint default null
) returns bigint
language plpgsql
set search_path = public, pg_temp
as $$
declare
  next_revision bigint;
  stamped_preferences jsonb;
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_profile) is distinct from 'object'
     or jsonb_typeof(p_profile->'preferences') is distinct from 'array'
     or jsonb_array_length(p_profile->'preferences') > 20
     or char_length(coalesce(p_summary, '')) > 500 then
    raise exception 'Invalid profile revision';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_profile->'preferences') pref
    where coalesce(pref->>'text', '') ~* '(sk-|gsk_|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)'
       or coalesce(pref->>'text', '') ~* '(password|passcode|api[_ -]?key|secret|access[_ -]?token)\s*[:=]\s*\S{8,}'
       or exists (
         select 1 from jsonb_array_elements(coalesce(pref->'evidence', '[]'::jsonb)) ev
         where ev #>> '{}' ~* '(sk-|gsk_|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|password|passcode|api[_ -]?key|secret|access[_ -]?token)'
       )
  ) then raise exception 'Credentials cannot be stored in a character profile'; end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  if (select count(*) from public.freya_personality_revisions where user_id = caller) >= 500 then
    raise exception 'Personality revision storage limit reached';
  end if;
  select coalesce(max(revision), 0) + 1 into next_revision
    from public.freya_personality_revisions where user_id = caller;
  select coalesce(jsonb_agg(jsonb_set(item.value, '{revision}', to_jsonb(next_revision), true) order by item.ordinality), '[]'::jsonb)
    into stamped_preferences
    from jsonb_array_elements(p_profile->'preferences') with ordinality as item(value, ordinality);
  insert into public.freya_personality_revisions(user_id, revision, profile, summary, rollback_from)
    values (caller, next_revision, jsonb_set(p_profile, '{preferences}', stamped_preferences), coalesce(p_summary, ''), p_rollback_from);
  return next_revision;
end;
$$;
revoke all on function public.append_freya_personality_revision(jsonb, text, bigint) from public;
grant execute on function public.append_freya_personality_revision(jsonb, text, bigint) to authenticated;

create table if not exists public.freya_personality_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('taste', 'dislike', 'opinion', 'interest')),
  description text not null check (char_length(trim(description)) between 1 and 240),
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 10),
  origin text not null check (origin in ('explicit', 'inferred', 'explored')),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'disputed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists freya_personality_proposals_user_idx
  on public.freya_personality_proposals (user_id, created_at desc);
alter table public.freya_personality_proposals enable row level security;
drop policy if exists "Users can read own FREYA personality proposals" on public.freya_personality_proposals;
create policy "Users can read own FREYA personality proposals"
  on public.freya_personality_proposals for select to authenticated
  using (auth.uid() = user_id);
drop policy if exists "Users can create own FREYA personality proposals" on public.freya_personality_proposals;
create policy "Users can create own FREYA personality proposals"
  on public.freya_personality_proposals for insert to authenticated
  with check (auth.uid() = user_id);
drop policy if exists "Users can review own FREYA personality proposals" on public.freya_personality_proposals;
create policy "Users can review own FREYA personality proposals"
  on public.freya_personality_proposals for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
drop policy if exists "Users can delete own FREYA personality proposals" on public.freya_personality_proposals;
create policy "Users can delete own FREYA personality proposals"
  on public.freya_personality_proposals for delete to authenticated
  using (auth.uid() = user_id);
grant select, insert, update, delete on public.freya_personality_proposals to authenticated;

-- Approval and history append are atomic, so simultaneous reviews cannot create
-- duplicate active preferences or overwrite one another's revisions.
create or replace function public.approve_freya_personality_proposal(
  p_proposal_id uuid,
  p_default_profile jsonb
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  proposal public.freya_personality_proposals%rowtype;
  current_profile jsonb;
  next_revision bigint;
  preference_kind text;
  stamp text := now()::text;
begin
  if caller is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  select * into proposal from public.freya_personality_proposals
    where id = p_proposal_id and user_id = caller and status = 'proposed' for update;
  if not found then raise exception 'Proposal is unavailable'; end if;
  if proposal.category <> 'interest'
     or proposal.origin <> 'inferred'
     or proposal.description not in (
       'A recurring curiosity about music', 'A recurring curiosity about visual art',
       'A recurring curiosity about design', 'A recurring curiosity about mythology',
       'A recurring curiosity about language', 'A recurring curiosity about history',
       'A recurring curiosity about philosophy', 'A recurring curiosity about astronomy',
       'A recurring curiosity about literature', 'A recurring curiosity about architecture',
       'A recurring curiosity about nature', 'A recurring curiosity about science',
       'A recurring curiosity about games', 'A recurring curiosity about film'
     ) then raise exception 'Proposal is outside the low-risk reflection allowlist'; end if;
  if exists (
    select 1 from jsonb_array_elements(proposal.evidence) ev
    where ev #>> '{}' ~* '(sk-|gsk_|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|password|passcode|api[_ -]?key|secret|access[_ -]?token)'
  ) then raise exception 'Credentials cannot be stored in a character profile'; end if;
  if jsonb_typeof(p_default_profile) is distinct from 'object'
     or jsonb_typeof(p_default_profile->'preferences') is distinct from 'array'
     or jsonb_array_length(p_default_profile->'preferences') > 20 then
    raise exception 'Invalid default profile';
  end if;
  select profile into current_profile from public.freya_personality_revisions
    where user_id = caller order by revision desc limit 1;
  current_profile := coalesce(current_profile, p_default_profile);
  select coalesce(max(revision), 0) + 1 into next_revision
    from public.freya_personality_revisions where user_id = caller;
  if (select count(*) from public.freya_personality_revisions where user_id = caller) >= 500 then
    raise exception 'Personality revision storage limit reached';
  end if;
  preference_kind := case when proposal.category = 'interest' then 'opinion' else proposal.category end;
  current_profile := jsonb_set(current_profile, '{preferences}',
    (current_profile->'preferences') || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text,
      'kind', preference_kind,
      'text', proposal.description,
      'confidence', proposal.confidence,
      'status', 'tentative',
      'origin', 'Approved ' || proposal.origin || ' reflection',
      'evidence', proposal.evidence,
      'createdAt', stamp,
      'updatedAt', stamp,
      'revision', next_revision
    )));
  if jsonb_array_length(current_profile->'preferences') > 20 then
    raise exception 'Character profile entry limit reached';
  end if;
  insert into public.freya_personality_revisions(user_id, revision, profile, summary)
    values (caller, next_revision, current_profile, 'User approved a proposed character preference.');
  update public.freya_personality_proposals set status = 'approved', updated_at = now()
    where id = proposal.id and user_id = caller;
  return jsonb_build_object('revision', next_revision, 'profile', current_profile, 'status', 'approved');
end;
$$;
revoke all on function public.approve_freya_personality_proposal(uuid, jsonb) from public;
grant execute on function public.approve_freya_personality_proposal(uuid, jsonb) to authenticated;

create or replace function public.create_freya_personality_proposal(
  p_category text,
  p_description text,
  p_confidence double precision,
  p_evidence jsonb,
  p_origin text,
  p_daily_limit integer default 1
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  proposal public.freya_personality_proposals%rowtype;
  day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  used_today integer;
begin
  if caller is null then raise exception 'Authentication required'; end if;
  if p_daily_limit < 1 or p_daily_limit > 10 then raise exception 'Reflection budget unavailable'; end if;
  if p_category <> 'interest' or p_origin <> 'inferred'
     or p_description not in (
       'A recurring curiosity about music', 'A recurring curiosity about visual art',
       'A recurring curiosity about design', 'A recurring curiosity about mythology',
       'A recurring curiosity about language', 'A recurring curiosity about history',
       'A recurring curiosity about philosophy', 'A recurring curiosity about astronomy',
       'A recurring curiosity about literature', 'A recurring curiosity about architecture',
       'A recurring curiosity about nature', 'A recurring curiosity about science',
       'A recurring curiosity about games', 'A recurring curiosity about film'
     ) then raise exception 'Proposal is outside the low-risk reflection allowlist'; end if;
  if jsonb_typeof(p_evidence) is distinct from 'array'
     or jsonb_array_length(p_evidence) > 10
     or exists (
       select 1 from jsonb_array_elements_text(p_evidence) ev
       where ev ~* '(sk-|gsk_|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|password|passcode|api[_ -]?key|secret|access[_ -]?token)'
     ) then raise exception 'Invalid or sensitive reflection evidence'; end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 1));
  select count(*) into used_today from public.freya_personality_proposals
    where user_id = caller and created_at >= day_start;
  if used_today >= p_daily_limit then raise exception 'Daily reflection budget used'; end if;
  if (select count(*) from public.freya_personality_proposals where user_id = caller) >= 200 then
    raise exception 'Personality proposal storage limit reached';
  end if;
  insert into public.freya_personality_proposals(user_id, category, description, confidence, evidence, origin)
    values (caller, p_category, p_description, p_confidence, p_evidence, p_origin)
    returning * into proposal;
  return to_jsonb(proposal) - 'user_id';
end;
$$;
revoke all on function public.create_freya_personality_proposal(text, text, double precision, jsonb, text, integer) from public;
grant execute on function public.create_freya_personality_proposal(text, text, double precision, jsonb, text, integer) to authenticated;
