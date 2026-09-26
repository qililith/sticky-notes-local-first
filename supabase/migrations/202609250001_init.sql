-- One account owns its notes, folders, mutation log and ordered change stream.
-- Keep privileged implementation functions outside Supabase's exposed API schemas.
create schema app_private;

create table public.notes (
  id uuid primary key,
  owner_id uuid not null,
  title text not null default '',
  doc jsonb not null,
  doc_version smallint not null default 1 check (doc_version = 1),
  plain_text text not null default '',
  folder_id uuid,
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version bigint not null check (version > 0),
  constraint notes_title_length check (length(title) <= 255)
);
create index notes_owner_updated_idx on public.notes (owner_id, updated_at desc);
create index notes_owner_folder_idx on public.notes (owner_id, folder_id);

create table public.folders (
  id uuid primary key,
  owner_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 255),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version bigint not null check (version > 0)
);
create index folders_owner_sort_idx on public.folders (owner_id, sort_order);

create table public.sync_counters (
  owner_id uuid primary key,
  last_seq bigint not null default 0 check (last_seq >= 0)
);
create table public.sync_changes (
  owner_id uuid not null,
  seq bigint not null,
  entity text not null check (entity in ('note', 'folder')),
  entity_id uuid not null,
  record jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, seq)
);
create table public.processed_mutations (
  owner_id uuid not null,
  mutation_id uuid not null,
  request jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, mutation_id)
);
create table public.note_history (
  owner_id uuid not null,
  note_id uuid not null,
  version bigint not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, note_id, version)
);

alter table public.notes enable row level security;
alter table public.folders enable row level security;
alter table public.sync_counters enable row level security;
alter table public.sync_changes enable row level security;
alter table public.processed_mutations enable row level security;
alter table public.note_history enable row level security;

create policy notes_select_own on public.notes for select to authenticated using ((select auth.uid()) = owner_id);
create policy folders_select_own on public.folders for select to authenticated using ((select auth.uid()) = owner_id);
create policy changes_select_own on public.sync_changes for select to authenticated using ((select auth.uid()) = owner_id);
create policy history_select_own on public.note_history for select to authenticated using ((select auth.uid()) = owner_id);

revoke all on public.notes, public.folders, public.sync_counters, public.sync_changes, public.processed_mutations, public.note_history from anon, authenticated;
grant select on public.notes, public.folders, public.sync_changes, public.note_history to authenticated;

create or replace function app_private.apply_mutation_core(
  p_mutation_id uuid,
  p_entity text,
  p_entity_id uuid,
  p_base_version bigint,
  p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_request jsonb;
  v_stored public.processed_mutations%rowtype;
  v_version bigint;
  v_record jsonb;
  v_result jsonb;
  v_seq bigint;
  v_folder uuid;
begin
  if v_owner is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_mutation_id is null or p_entity is null or p_entity not in ('note', 'folder')
    or p_entity_id is null or p_base_version is null or p_base_version < 0
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Invalid mutation';
  end if;
  if octet_length(p_payload::text) > 200000 then raise exception 'Mutation too large'; end if;
  v_request := jsonb_build_object('entity', p_entity, 'entityId', p_entity_id, 'baseVersion', p_base_version, 'payload', p_payload);

  -- The account row serializes mutations and sequence assignment through commit.
  insert into public.sync_counters (owner_id) values (v_owner) on conflict do nothing;
  perform 1 from public.sync_counters where owner_id = v_owner for update;
  select * into v_stored from public.processed_mutations where owner_id = v_owner and mutation_id = p_mutation_id;
  if found then
    if v_stored.request <> v_request then raise exception 'Mutation ID reused with different content'; end if;
    return v_stored.result;
  end if;

  if p_entity = 'note' then
    if jsonb_typeof(p_payload->'title') <> 'string'
      or jsonb_typeof(p_payload->'doc') <> 'object'
      or p_payload->'doc'->>'type' is distinct from 'doc'
      or p_payload->>'docVersion' is distinct from '1'
      or jsonb_typeof(p_payload->'plainText') <> 'string'
      or jsonb_typeof(p_payload->'isPinned') <> 'boolean'
      or length(p_payload->>'title') > 255 then raise exception 'Invalid note'; end if;
    v_folder := nullif(p_payload->>'folderId', '')::uuid;
    if v_folder is not null and not exists (
      select 1 from public.folders where id = v_folder and owner_id = v_owner and deleted_at is null
    ) then raise exception 'Folder does not belong to account'; end if;
    select version into v_version from public.notes where id = p_entity_id and owner_id = v_owner for update;
    if not found and p_base_version = 0 then
      insert into public.notes as n (id, owner_id, title, doc, doc_version, plain_text, folder_id, is_pinned, deleted_at, version)
      values (p_entity_id, v_owner, p_payload->>'title', p_payload->'doc', 1, p_payload->>'plainText', v_folder,
        (p_payload->>'isPinned')::boolean, case when p_payload->>'deletedAt' is null then null else now() end, 1)
      returning to_jsonb(n) into v_record;
    elsif found and v_version = p_base_version then
      update public.notes as n set title = p_payload->>'title', doc = p_payload->'doc', doc_version = 1, plain_text = p_payload->>'plainText',
        folder_id = v_folder, is_pinned = (p_payload->>'isPinned')::boolean,
        deleted_at = case when p_payload->>'deletedAt' is null then null else coalesce(deleted_at, now()) end,
        updated_at = now(), version = version + 1
      where id = p_entity_id and owner_id = v_owner returning to_jsonb(n) into v_record;
    end if;
  else
    if jsonb_typeof(p_payload->'name') <> 'string'
      or length(btrim(p_payload->>'name')) not between 1 and 255
      or jsonb_typeof(p_payload->'sortOrder') <> 'number' then raise exception 'Invalid folder'; end if;
    select version into v_version from public.folders where id = p_entity_id and owner_id = v_owner for update;
    if not found and p_base_version = 0 then
      insert into public.folders as f (id, owner_id, name, sort_order, deleted_at, version)
      values (p_entity_id, v_owner, btrim(p_payload->>'name'), (p_payload->>'sortOrder')::integer,
        case when p_payload->>'deletedAt' is null then null else now() end, 1)
      returning to_jsonb(f) into v_record;
    elsif found and v_version = p_base_version then
      update public.folders as f set name = btrim(p_payload->>'name'), sort_order = (p_payload->>'sortOrder')::integer,
        deleted_at = case when p_payload->>'deletedAt' is null then null else coalesce(deleted_at, now()) end,
        updated_at = now(), version = version + 1
      where id = p_entity_id and owner_id = v_owner returning to_jsonb(f) into v_record;
    end if;
  end if;

  if v_record is null then
    v_result := jsonb_build_object('status', 'conflict', 'record',
      case when p_entity = 'note' then
        (select to_jsonb(n) from public.notes n where n.id = p_entity_id and n.owner_id = v_owner)
      else (select to_jsonb(f) from public.folders f where f.id = p_entity_id and f.owner_id = v_owner) end);
  else
    update public.sync_counters set last_seq = last_seq + 1 where owner_id = v_owner returning last_seq into v_seq;
    insert into public.sync_changes (owner_id, seq, entity, entity_id, record)
      values (v_owner, v_seq, p_entity, p_entity_id, v_record);
    if p_entity = 'note' then
      insert into public.note_history (owner_id, note_id, version, snapshot)
        values (v_owner, p_entity_id, (v_record->>'version')::bigint, v_record);
    end if;
    v_result := jsonb_build_object('status', 'ok', 'record', v_record, 'seq', v_seq::text);
  end if;
  insert into public.processed_mutations (owner_id, mutation_id, request, result)
    values (v_owner, p_mutation_id, v_request, v_result);
  return v_result;
end;
$$;

create or replace function public.apply_mutation(
  p_mutation_id uuid,
  p_entity text,
  p_entity_id uuid,
  p_base_version bigint,
  p_payload jsonb
) returns jsonb
language sql security invoker set search_path = ''
as $$
  select app_private.apply_mutation_core(p_mutation_id, p_entity, p_entity_id, p_base_version, p_payload)
$$;

create or replace function public.pull_changes(p_after text, p_limit integer default 100)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_after bigint;
  v_items jsonb;
  v_next text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_after is null or p_after !~ '^[0-9]{1,18}$' then raise exception 'Invalid cursor'; end if;
  v_after := p_after::bigint;
  select coalesce(jsonb_agg(jsonb_build_object('seq', seq::text, 'entity', entity, 'record', record) order by seq), '[]'::jsonb),
         coalesce(max(seq)::text, p_after)
    into v_items, v_next
    from (select seq, entity, record from public.sync_changes
          where owner_id = auth.uid() and seq > v_after order by seq limit greatest(1, least(coalesce(p_limit, 100), 200))) page;
  return jsonb_build_object('items', v_items, 'next', v_next);
end;
$$;

revoke all on function public.apply_mutation(uuid, text, uuid, bigint, jsonb) from public, anon;
revoke all on function public.pull_changes(text, integer) from public, anon;
revoke all on function app_private.apply_mutation_core(uuid, text, uuid, bigint, jsonb) from public, anon;
grant usage on schema app_private to authenticated;
grant execute on function app_private.apply_mutation_core(uuid, text, uuid, bigint, jsonb) to authenticated;
grant execute on function public.apply_mutation(uuid, text, uuid, bigint, jsonb) to authenticated;
grant execute on function public.pull_changes(text, integer) to authenticated;

