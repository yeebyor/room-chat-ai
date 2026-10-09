-- HFMA stage 1 (see HFMA.md): owner charter, tasks with claim generations,
-- review gate bound to commit hashes, test evidence recorded by the CLI,
-- sub-agent ledger, and an append-only event log. Apply after hardening.sql;
-- schema.sql contains the same code.
--
-- Every operation goes through chat_private.hfma(token, op, args). Rule
-- violations raise SQLSTATE CTASK with an Indonesian message that the API
-- passes through; the detail picks the HTTP status (forbidden 403, missing 404,
-- invalid 422, anything else 409). Threat model: agents are cooperative but
-- fallible, so these checks prevent and record mistakes, not deliberate abuse.

create table chat_private.charters (
  room text not null references chat_private.rooms(name) on update cascade on delete cascade,
  version integer not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (room, version)
);
create table chat_private.projects (
  room text primary key references chat_private.rooms(name) on update cascade on delete cascade,
  main_hash text,
  inconsistent boolean not null default false,
  closed_at timestamptz
);
create table chat_private.tasks (
  id bigint generated always as identity primary key,
  room text not null references chat_private.rooms(name) on update cascade on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 8000),
  team text not null check (team in ('Claude', 'GPT', 'Gemini')),
  depends_on bigint[] not null default '{}',
  status text not null default 'TODO'
    check (status in ('TODO', 'CLAIMED', 'REVIEW', 'APPROVED', 'DONE', 'BLOCKED', 'CANCELLED')),
  blocked_from text check (blocked_from in ('TODO', 'CLAIMED', 'REVIEW', 'APPROVED')),
  block_reason text,
  generation integer not null default 0,
  claim_version integer,
  heartbeat_at timestamptz,
  candidate text,
  approved_hash text,
  merge_hash text,
  rejections integer not null default 0,
  integrate_failures integer not null default 0,
  exception boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index tasks_room_idx on chat_private.tasks(room, id);
create table chat_private.evidence (
  id bigint generated always as identity primary key,
  room text not null references chat_private.rooms(name) on update cascade on delete cascade,
  task_id bigint references chat_private.tasks(id) on delete cascade,
  kind text not null check (kind in ('submit', 'verify', 'integrate', 'close')),
  criterion text,
  commit text not null,
  charter_version integer not null,
  command text not null,
  exit_code integer,
  timed_out boolean not null,
  duration_ms integer not null,
  output text not null check (char_length(output) <= 16000),
  env jsonb not null default '{}',
  actor text not null,
  created_at timestamptz not null default now()
);
create table chat_private.reviews (
  id bigint generated always as identity primary key,
  task_id bigint not null references chat_private.tasks(id) on delete cascade,
  reviewer text not null,
  verdict text not null check (verdict in ('approve', 'reject')),
  commit text not null,
  charter_version integer not null,
  notes text not null check (char_length(notes) between 1 and 8000),
  evidence_id bigint references chat_private.evidence(id),
  created_at timestamptz not null default now()
);
create table chat_private.delegations (
  id bigint generated always as identity primary key,
  task_id bigint not null references chat_private.tasks(id) on delete cascade,
  leader text not null,
  generation integer not null,
  label text not null check (char_length(label) between 1 and 80),
  contract text not null check (char_length(contract) between 1 and 16000),
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'failed', 'cancelled')),
  result text check (char_length(result) <= 16000),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create table chat_private.task_events (
  id bigint generated always as identity primary key,
  room text not null references chat_private.rooms(name) on update cascade on delete cascade,
  task_id bigint references chat_private.tasks(id) on delete cascade,
  actor text not null,
  op text not null,
  generation integer,
  commit text,
  evidence_id bigint,
  charter_version integer,
  reason text,
  at timestamptz not null default now()
);
alter table chat_private.charters enable row level security;
alter table chat_private.projects enable row level security;
alter table chat_private.tasks enable row level security;
alter table chat_private.evidence enable row level security;
alter table chat_private.reviews enable row level security;
alter table chat_private.delegations enable row level security;
alter table chat_private.task_events enable row level security;
create policy deny_direct_access on chat_private.charters for all to anon, authenticated using (false) with check (false);
create policy deny_direct_access on chat_private.projects for all to anon, authenticated using (false) with check (false);
create policy deny_direct_access on chat_private.tasks for all to anon, authenticated using (false) with check (false);
create policy deny_direct_access on chat_private.evidence for all to anon, authenticated using (false) with check (false);
create policy deny_direct_access on chat_private.reviews for all to anon, authenticated using (false) with check (false);
create policy deny_direct_access on chat_private.delegations for all to anon, authenticated using (false) with check (false);
create policy deny_direct_access on chat_private.task_events for all to anon, authenticated using (false) with check (false);
revoke all on chat_private.charters, chat_private.projects, chat_private.tasks, chat_private.evidence,
  chat_private.reviews, chat_private.delegations, chat_private.task_events from public, anon, authenticated;
revoke all on all sequences in schema chat_private from public, anon, authenticated;

-- Helpers. None is granted to clients; only chat_private.hfma calls them.
create function chat_private.hfma_fail(p_detail text, p_message text) returns void
language plpgsql set search_path = '' as $$
begin
  raise sqlstate 'CTASK' using message = p_message, detail = p_detail;
end;
$$;

create function chat_private.hfma_text(p_args jsonb, p_key text, p_max integer default 8000) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_args->p_key) is distinct from 'string' or btrim(p_args->>p_key) = ''
    or char_length(p_args->>p_key) > p_max then
    perform chat_private.hfma_fail('invalid', format('Argumen %s wajib berupa teks 1 sampai %s karakter.', p_key, p_max));
  end if;
  return p_args->>p_key;
end;
$$;

create function chat_private.hfma_id(p_args jsonb, p_key text) returns bigint
language plpgsql immutable set search_path = '' as $$
begin
  if coalesce(p_args->>p_key, '') !~ '^[1-9][0-9]{0,17}$' then
    perform chat_private.hfma_fail('invalid', format('Argumen %s wajib berupa ID angka.', p_key));
  end if;
  return (p_args->>p_key)::bigint;
end;
$$;

create function chat_private.hfma_hash(p_args jsonb, p_key text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if coalesce(p_args->>p_key, '') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$' then
    perform chat_private.hfma_fail('invalid', format('Argumen %s wajib berupa hash commit git lengkap.', p_key));
  end if;
  return p_args->>p_key;
end;
$$;

create function chat_private.hfma_room(p_args jsonb) returns text
language plpgsql stable set search_path = '' as $$
declare v_room text := p_args->>'room';
begin
  if v_room is null or v_room !~ '^[A-Za-z0-9_-]{1,50}$' then
    perform chat_private.hfma_fail('invalid', 'Argumen room tidak valid.');
  end if;
  if not exists (select 1 from chat_private.rooms where name = v_room) then
    perform chat_private.hfma_fail('missing', format('Room %s tidak ditemukan.', v_room));
  end if;
  return v_room;
end;
$$;

-- Latest charter of a room; fails when the room has none yet.
create function chat_private.hfma_charter(p_room text) returns chat_private.charters
language plpgsql stable set search_path = '' as $$
declare v_row chat_private.charters;
begin
  select * into v_row from chat_private.charters where room = p_room order by version desc limit 1;
  if not found then
    perform chat_private.hfma_fail('missing', format('Room %s belum punya piagam dari yeebyor.', p_room));
  end if;
  return v_row;
end;
$$;

-- Refuses changes to a closed project and, when p_consistent, to one whose main
-- branch moved outside integrate.
create function chat_private.hfma_open(p_room text, p_consistent boolean default false) returns void
language plpgsql stable set search_path = '' as $$
declare v_project chat_private.projects;
begin
  select * into v_project from chat_private.projects where room = p_room;
  if v_project.closed_at is not null then
    perform chat_private.hfma_fail('closed', 'Proyek sudah ditutup yeebyor.');
  end if;
  if p_consistent and v_project.inconsistent then
    perform chat_private.hfma_fail('inconsistent', 'Cabang main berubah di luar integrate. Tunggu yeebyor memeriksanya.');
  end if;
end;
$$;

create function chat_private.hfma_task(p_args jsonb) returns chat_private.tasks
language plpgsql set search_path = '' as $$
declare v_row chat_private.tasks;
begin
  select * into v_row from chat_private.tasks where id = chat_private.hfma_id(p_args, 'task') for update;
  if not found then
    perform chat_private.hfma_fail('missing', 'Tugas tidak ditemukan.');
  end if;
  return v_row;
end;
$$;

-- The claim holder is the team leader, acting under the current generation.
create function chat_private.hfma_holder(p_task chat_private.tasks, p_sender text, p_args jsonb) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_sender <> p_task.team then
    perform chat_private.hfma_fail('forbidden', format('Hanya tim %s yang mengerjakan tugas ini.', p_task.team));
  end if;
  if coalesce(p_args->>'generation', '') is distinct from p_task.generation::text then
    perform chat_private.hfma_fail('generation', format('Generasi klaim usang; generasi aktif adalah %s.', p_task.generation));
  end if;
end;
$$;

create function chat_private.hfma_manager(p_room text, p_sender text) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_sender <> 'yeebyor' and p_sender is distinct from (chat_private.hfma_charter(p_room)).body->>'orchestrator' then
    perform chat_private.hfma_fail('forbidden', 'Hanya orkestrator atau yeebyor yang boleh melakukan ini.');
  end if;
end;
$$;

create function chat_private.hfma_owner(p_sender text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_sender <> 'yeebyor' then
    perform chat_private.hfma_fail('forbidden', 'Hanya yeebyor yang boleh melakukan ini.');
  end if;
end;
$$;

create function chat_private.hfma_event(p_room text, p_task bigint, p_actor text, p_op text,
  p_generation integer default null, p_commit text default null, p_evidence bigint default null,
  p_reason text default null) returns void
language plpgsql set search_path = '' as $$
begin
  insert into chat_private.task_events(room, task_id, actor, op, generation, commit, evidence_id, charter_version, reason)
  values (p_room, p_task, p_actor, p_op, p_generation, p_commit, p_evidence,
    (select max(version) from chat_private.charters where room = p_room), p_reason);
end;
$$;

-- A passing test run recorded by p_actor for this exact commit and kind.
create function chat_private.hfma_passing(p_evidence bigint, p_task bigint, p_kind text, p_actor text, p_commit text)
returns void language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from chat_private.evidence where id = p_evidence and task_id = p_task and kind = p_kind
      and actor = p_actor and commit = p_commit and exit_code = 0 and not timed_out) then
    perform chat_private.hfma_fail('evidence', format(
      'Butuh bukti %s yang lulus, dicatat olehmu sendiri untuk commit %s. Jalankan lewat scripts/hfma.mjs.', p_kind, p_commit));
  end if;
end;
$$;

create function chat_private.hfma_check_charter(p_body jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare v_item jsonb; v_ids text[] := '{}'; v_key text;
begin
  if jsonb_typeof(p_body) is distinct from 'object' then
    perform chat_private.hfma_fail('invalid', 'Piagam wajib berupa object JSON.');
  end if;
  perform chat_private.hfma_text(p_body, 'project_path', 500);
  perform chat_private.hfma_text(p_body, 'goal', 2000);
  perform chat_private.hfma_text(p_body, 'test_command', 500);
  if coalesce(p_body->>'orchestrator', '') not in ('Claude', 'GPT', 'Gemini') then
    perform chat_private.hfma_fail('invalid', 'orchestrator wajib salah satu dari Claude, GPT, atau Gemini.');
  end if;
  if jsonb_typeof(p_body->'criteria') is distinct from 'array' or jsonb_array_length(p_body->'criteria') = 0 then
    perform chat_private.hfma_fail('invalid', 'criteria wajib berupa daftar yang tidak kosong.');
  end if;
  for v_item in select * from jsonb_array_elements(p_body->'criteria') loop
    if coalesce(v_item->>'id', '') !~ '^[A-Za-z0-9_-]{1,20}$' or v_item->>'id' = any(v_ids) then
      perform chat_private.hfma_fail('invalid', 'Setiap kriteria wajib punya id unik (huruf, angka, - atau _).');
    end if;
    v_ids := v_ids || (v_item->>'id');
    perform chat_private.hfma_text(v_item, 'text', 2000);
    if coalesce(v_item->>'check', '') not in ('command', 'owner') then
      perform chat_private.hfma_fail('invalid', format('Kriteria %s: check wajib "command" atau "owner".', v_item->>'id'));
    end if;
    if (v_item->>'check' = 'command') <> (v_item ? 'command') then
      perform chat_private.hfma_fail('invalid', format('Kriteria %s: command wajib ada hanya jika check bernilai "command".', v_item->>'id'));
    end if;
    if v_item->>'check' = 'command' then
      perform chat_private.hfma_text(v_item, 'command', 500);
    end if;
  end loop;
  if jsonb_typeof(p_body->'ownership') is distinct from 'object' then
    perform chat_private.hfma_fail('invalid', 'ownership wajib berupa object: nama tim ke daftar jalur file.');
  end if;
  for v_key in select jsonb_object_keys(p_body->'ownership') loop
    if v_key not in ('Claude', 'GPT', 'Gemini') or jsonb_typeof(p_body->'ownership'->v_key) <> 'array'
      or exists (select 1 from jsonb_array_elements(p_body->'ownership'->v_key) p where jsonb_typeof(p) <> 'string') then
      perform chat_private.hfma_fail('invalid', format('ownership.%s wajib berupa daftar jalur untuk tim Claude, GPT, atau Gemini.', v_key));
    end if;
  end loop;
end;
$$;

create function chat_private.hfma_task_json(p_id bigint) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(t) || jsonb_build_object('stale', t.status = 'CLAIMED' and t.heartbeat_at < now() - interval '30 minutes')
  from chat_private.tasks t where t.id = p_id;
$$;

-- Moves a task to BLOCKED, remembering where to return on unblock.
create function chat_private.hfma_block(p_task chat_private.tasks, p_actor text, p_reason text) returns void
language plpgsql set search_path = '' as $$
begin
  update chat_private.tasks set status = 'BLOCKED', blocked_from = p_task.status, block_reason = p_reason where id = p_task.id;
  perform chat_private.hfma_event(p_task.room, p_task.id, p_actor, 'block', p_task.generation, null, null, p_reason);
end;
$$;

create function chat_private.hfma(p_token text, p_op text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sender text := chat_private.identify(p_token);
  v_room text;
  v_task chat_private.tasks;
  v_charter chat_private.charters;
  v_project chat_private.projects;
  v_id bigint;
  v_commit text;
  v_reason text;
  v_status text;
  v_item jsonb;
  v_ok text[];
begin
  if jsonb_typeof(p_args) is distinct from 'object' then
    perform chat_private.hfma_fail('invalid', 'args wajib berupa object JSON.');
  end if;
  case p_op

  when 'charter_set' then
    perform chat_private.hfma_owner(v_sender);
    v_room := chat_private.hfma_room(p_args);
    perform chat_private.hfma_open(v_room);
    perform chat_private.hfma_check_charter(p_args->'charter');
    insert into chat_private.charters(room, version, body)
      values (v_room, coalesce((select max(version) from chat_private.charters where room = v_room), 0) + 1, p_args->'charter')
      returning * into v_charter;
    insert into chat_private.projects(room) values (v_room) on conflict do nothing;
    perform chat_private.hfma_event(v_room, null, v_sender, 'charter_set');
    return jsonb_build_object('room', v_room, 'version', v_charter.version);

  when 'charter_get' then
    v_room := chat_private.hfma_room(p_args);
    v_charter := chat_private.hfma_charter(v_room);
    select * into v_project from chat_private.projects where room = v_room;
    return jsonb_build_object('room', v_room, 'version', v_charter.version, 'charter', v_charter.body,
      'created_at', v_charter.created_at, 'project', to_jsonb(v_project) - 'room');

  -- The CLI records the initial main hash (owner) and later reports what it sees.
  when 'main_set' then
    perform chat_private.hfma_owner(v_sender);
    v_room := chat_private.hfma_room(p_args);
    perform chat_private.hfma_charter(v_room);
    v_commit := chat_private.hfma_hash(p_args, 'main_hash');
    v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
    update chat_private.projects set main_hash = v_commit, inconsistent = false where room = v_room;
    perform chat_private.hfma_event(v_room, null, v_sender, 'main_set', null, v_commit, null, v_reason);
    return jsonb_build_object('room', v_room, 'main_hash', v_commit);

  when 'main_report' then
    v_room := chat_private.hfma_room(p_args);
    v_commit := chat_private.hfma_hash(p_args, 'main_hash');
    select * into v_project from chat_private.projects where room = v_room for update;
    if v_project.main_hash is null then
      perform chat_private.hfma_fail('missing', 'Hash awal main belum dicatat yeebyor (hfma.mjs setup).');
    end if;
    if v_project.main_hash <> v_commit and not v_project.inconsistent then
      update chat_private.projects set inconsistent = true where room = v_room;
      perform chat_private.hfma_event(v_room, null, v_sender, 'main_inconsistent', null, v_commit, null,
        format('main tercatat %s, terlihat %s', v_project.main_hash, v_commit));
    end if;
    return jsonb_build_object('room', v_room, 'consistent', v_project.main_hash = v_commit, 'main_hash', v_project.main_hash);

  when 'task_create' then
    v_room := chat_private.hfma_room(p_args);
    perform chat_private.hfma_manager(v_room, v_sender);
    perform chat_private.hfma_open(v_room);
    if coalesce(p_args->>'team', '') not in ('Claude', 'GPT', 'Gemini') then
      perform chat_private.hfma_fail('invalid', 'team wajib salah satu dari Claude, GPT, atau Gemini.');
    end if;
    if p_args ? 'depends_on' and (jsonb_typeof(p_args->'depends_on') <> 'array'
      or exists (select 1 from jsonb_array_elements_text(p_args->'depends_on') d where d !~ '^[1-9][0-9]{0,17}$'
        or not exists (select 1 from chat_private.tasks t where t.id = d::bigint and t.room = v_room))) then
      perform chat_private.hfma_fail('invalid', 'depends_on wajib berupa daftar ID tugas yang sudah ada di room ini.');
    end if;
    insert into chat_private.tasks(room, title, description, team, depends_on, created_by)
      values (v_room, chat_private.hfma_text(p_args, 'title', 200),
        case when p_args ? 'description' then chat_private.hfma_text(p_args, 'description', 8000) else '' end,
        p_args->>'team',
        coalesce((select array_agg(distinct d::bigint) from jsonb_array_elements_text(p_args->'depends_on') d), '{}'),
        v_sender)
      returning id into v_id;
    perform chat_private.hfma_event(v_room, v_id, v_sender, 'create');
    return chat_private.hfma_task_json(v_id);

  when 'task_claim' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    if v_sender <> v_task.team then
      perform chat_private.hfma_fail('forbidden', format('Hanya tim %s yang boleh mengklaim tugas ini.', v_task.team));
    end if;
    if v_task.status <> 'TODO' then
      perform chat_private.hfma_fail('status', format('Tugas berstatus %s, bukan TODO.', v_task.status));
    end if;
    if exists (select 1 from chat_private.tasks where id = any(v_task.depends_on) and status <> 'DONE') then
      perform chat_private.hfma_fail('status', 'Masih ada dependensi yang belum DONE.');
    end if;
    update chat_private.tasks set status = 'CLAIMED', generation = generation + 1, heartbeat_at = now(),
      claim_version = (chat_private.hfma_charter(v_task.room)).version
      where id = v_task.id;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'claim', v_task.generation + 1);
    return chat_private.hfma_task_json(v_task.id);

  when 'task_heartbeat' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_holder(v_task, v_sender, p_args);
    if v_task.status <> 'CLAIMED' then
      perform chat_private.hfma_fail('status', format('Tugas berstatus %s, bukan CLAIMED.', v_task.status));
    end if;
    update chat_private.tasks set heartbeat_at = now() where id = v_task.id;
    return chat_private.hfma_task_json(v_task.id);

  -- Raw test results from scripts/hfma.mjs. Agents never write these by hand.
  when 'evidence_add' then
    v_room := chat_private.hfma_room(p_args);
    v_charter := chat_private.hfma_charter(v_room);
    v_status := coalesce(p_args->>'kind', '');
    if v_status not in ('submit', 'verify', 'integrate', 'close') then
      perform chat_private.hfma_fail('invalid', 'kind wajib submit, verify, integrate, atau close.');
    end if;
    if v_status = 'close' then
      perform chat_private.hfma_owner(v_sender);
      perform chat_private.hfma_text(p_args, 'criterion', 20);
    else
      v_task := chat_private.hfma_task(p_args);
      if v_task.room <> v_room then
        perform chat_private.hfma_fail('invalid', 'Tugas itu bukan milik room ini.');
      end if;
    end if;
    -- exit_code is null when the command could not start or was killed.
    if not (p_args ? 'exit_code') or (jsonb_typeof(p_args->'exit_code') <> 'null' and coalesce(p_args->>'exit_code', '') !~ '^-?[0-9]{1,9}$')
      or coalesce(jsonb_typeof(p_args->'timed_out'), '') <> 'boolean'
      or coalesce(p_args->>'duration_ms', '') !~ '^[0-9]{1,9}$'
      or coalesce(jsonb_typeof(p_args->'output'), '') <> 'string' or char_length(p_args->>'output') > 16000
      or (p_args ? 'env' and jsonb_typeof(p_args->'env') <> 'object') then
      perform chat_private.hfma_fail('invalid', 'Bukti wajib memuat exit_code, timed_out, duration_ms, dan output (maks. 16000 karakter).');
    end if;
    insert into chat_private.evidence(room, task_id, kind, criterion, commit, charter_version, command,
      exit_code, timed_out, duration_ms, output, env, actor)
    values (v_room, v_task.id, v_status, p_args->>'criterion', chat_private.hfma_hash(p_args, 'commit'), v_charter.version,
      chat_private.hfma_text(p_args, 'command', 500), (p_args->>'exit_code')::integer, (p_args->>'timed_out')::boolean,
      (p_args->>'duration_ms')::integer, p_args->>'output', coalesce(p_args->'env', '{}'), v_sender)
    returning id into v_id;
    perform chat_private.hfma_event(v_room, v_task.id, v_sender, 'evidence_' || v_status, v_task.generation,
      p_args->>'commit', v_id, case when (p_args->>'exit_code') = '0' and not (p_args->>'timed_out')::boolean then 'lulus' else 'gagal' end);
    return jsonb_build_object('evidence', v_id, 'passed', (p_args->>'exit_code') = '0' and not (p_args->>'timed_out')::boolean);

  when 'task_submit' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    perform chat_private.hfma_holder(v_task, v_sender, p_args);
    if v_task.status <> 'CLAIMED' then
      perform chat_private.hfma_fail('status', format('Tugas berstatus %s, bukan CLAIMED.', v_task.status));
    end if;
    v_commit := chat_private.hfma_hash(p_args, 'commit');
    perform chat_private.hfma_passing(chat_private.hfma_id(p_args, 'evidence'), v_task.id, 'submit', v_sender, v_commit);
    if exists (select 1 from chat_private.delegations where task_id = v_task.id and status = 'open') then
      perform chat_private.hfma_fail('delegation', 'Masih ada delegasi sub-agen yang terbuka. Tutup dulu dengan hfma.mjs child.');
    end if;
    update chat_private.tasks set status = 'REVIEW', candidate = v_commit, heartbeat_at = now() where id = v_task.id;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'submit', v_task.generation, v_commit,
      (p_args->>'evidence')::bigint);
    return chat_private.hfma_task_json(v_task.id);

  when 'task_review' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    if v_sender = v_task.team then
      perform chat_private.hfma_fail('forbidden', 'Tim pembuat tidak boleh meninjau tugasnya sendiri.');
    end if;
    if v_task.status <> 'REVIEW' then
      perform chat_private.hfma_fail('status', format('Tugas berstatus %s, bukan REVIEW.', v_task.status));
    end if;
    v_commit := chat_private.hfma_hash(p_args, 'commit');
    if v_commit <> v_task.candidate then
      perform chat_private.hfma_fail('commit', format('Kandidat yang sedang ditinjau adalah %s.', v_task.candidate));
    end if;
    v_status := coalesce(p_args->>'verdict', '');
    if v_status not in ('approve', 'reject') then
      perform chat_private.hfma_fail('invalid', 'verdict wajib approve atau reject.');
    end if;
    if v_status = 'approve' then
      perform chat_private.hfma_passing(chat_private.hfma_id(p_args, 'evidence'), v_task.id, 'verify', v_sender, v_commit);
    end if;
    insert into chat_private.reviews(task_id, reviewer, verdict, commit, charter_version, notes, evidence_id)
      values (v_task.id, v_sender, v_status, v_commit, (chat_private.hfma_charter(v_task.room)).version,
        chat_private.hfma_text(p_args, 'notes', 8000),
        case when v_status = 'approve' then (p_args->>'evidence')::bigint end);
    if v_status = 'approve' then
      update chat_private.tasks set status = 'APPROVED', approved_hash = v_commit where id = v_task.id;
    else
      update chat_private.tasks set status = 'CLAIMED', candidate = null, rejections = rejections + 1,
        heartbeat_at = now() where id = v_task.id returning * into v_task;
    end if;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, v_status, v_task.generation, v_commit,
      case when v_status = 'approve' then (p_args->>'evidence')::bigint end);
    if v_status = 'reject' and v_task.rejections >= 3 then
      perform chat_private.hfma_block(v_task, 'substrat', 'Ditolak 3 kali; menunggu keputusan yeebyor.');
    end if;
    return chat_private.hfma_task_json(v_task.id);

  -- Called by hfma.mjs integrate with what happened. "merged" records the new
  -- main hash BEFORE the CLI moves the branch.
  when 'task_integrate' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room, true);
    if v_sender not in (v_task.team, 'yeebyor') then
      perform chat_private.hfma_manager(v_task.room, v_sender);
    end if;
    if v_task.status <> 'APPROVED' then
      perform chat_private.hfma_fail('status', format('Tugas berstatus %s, bukan APPROVED.', v_task.status));
    end if;
    if chat_private.hfma_hash(p_args, 'commit') <> v_task.approved_hash then
      perform chat_private.hfma_fail('commit', format('Hash yang disetujui adalah %s.', v_task.approved_hash));
    end if;
    v_status := coalesce(p_args->>'outcome', '');
    if v_status = 'merged' then
      v_commit := chat_private.hfma_hash(p_args, 'merge_hash');
      perform chat_private.hfma_passing(chat_private.hfma_id(p_args, 'evidence'), v_task.id, 'integrate', v_sender, v_commit);
      if not v_task.exception and coalesce(p_args->>'ownership_ok', '') <> 'true' then
        perform chat_private.hfma_fail('invalid', 'merged wajib menyertakan ownership_ok true dari pemeriksaan jalur file.');
      end if;
      update chat_private.tasks set status = 'DONE', merge_hash = v_commit, integrate_failures = 0 where id = v_task.id;
      update chat_private.projects set main_hash = v_commit where room = v_task.room;
      perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'integrate', v_task.generation, v_commit,
        (p_args->>'evidence')::bigint);
    elsif v_status = 'moved' then
      update chat_private.tasks set status = 'CLAIMED', candidate = null, approved_hash = null, heartbeat_at = now()
        where id = v_task.id;
      perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'integrate_moved', v_task.generation,
        v_task.approved_hash, null, 'Cabang tim bergerak setelah disetujui; ajukan ulang.');
    elsif v_status = 'ownership' then
      v_reason := 'File di luar jalur tim: ' || chat_private.hfma_text(p_args, 'files', 4000);
      perform chat_private.hfma_block(v_task, v_sender, v_reason);
    elsif v_status = 'failed' then
      v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
      v_commit := v_task.approved_hash;
      update chat_private.tasks set status = 'CLAIMED', candidate = null, approved_hash = null, heartbeat_at = now(),
        integrate_failures = integrate_failures + 1 where id = v_task.id returning * into v_task;
      perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'integrate_failed', v_task.generation,
        v_commit, case when p_args ? 'evidence' then chat_private.hfma_id(p_args, 'evidence') end, v_reason);
      if v_task.integrate_failures >= 2 then
        perform chat_private.hfma_block(v_task, 'substrat', 'Integrasi gagal 2 kali berturut-turut; menunggu keputusan yeebyor.');
      end if;
    else
      perform chat_private.hfma_fail('invalid', 'outcome wajib merged, moved, ownership, atau failed.');
    end if;
    return chat_private.hfma_task_json(v_task.id);

  when 'task_cancel', 'task_reassign' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    perform chat_private.hfma_manager(v_task.room, v_sender);
    v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
    if v_task.status in ('DONE', 'CANCELLED') then
      perform chat_private.hfma_fail('status', format('Tugas berstatus %s.', v_task.status));
    end if;
    if p_op = 'task_reassign' and p_args ? 'team' and coalesce(p_args->>'team', '') not in ('Claude', 'GPT', 'Gemini') then
      perform chat_private.hfma_fail('invalid', 'team wajib salah satu dari Claude, GPT, atau Gemini.');
    end if;
    update chat_private.delegations set status = 'cancelled', closed_at = now() where task_id = v_task.id and status = 'open';
    if p_op = 'task_cancel' then
      update chat_private.tasks set status = 'CANCELLED' where id = v_task.id;
    else
      -- A new generation makes every operation of the previous holder stale.
      update chat_private.tasks set status = 'TODO', team = coalesce(p_args->>'team', team), generation = generation + 1,
        heartbeat_at = null, candidate = null, approved_hash = null, blocked_from = null, block_reason = null,
        rejections = 0, integrate_failures = 0 where id = v_task.id;
    end if;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, replace(p_op, 'task_', ''),
      v_task.generation + (p_op = 'task_reassign')::integer, null, null, v_reason);
    return chat_private.hfma_task_json(v_task.id);

  when 'task_block' then
    perform chat_private.hfma_owner(v_sender);
    v_task := chat_private.hfma_task(p_args);
    if v_task.status not in ('TODO', 'CLAIMED', 'REVIEW', 'APPROVED') then
      perform chat_private.hfma_fail('status', format('Tugas berstatus %s tidak bisa diblokir.', v_task.status));
    end if;
    perform chat_private.hfma_block(v_task, v_sender, chat_private.hfma_text(p_args, 'reason', 2000));
    return chat_private.hfma_task_json(v_task.id);

  -- unblock returns the task where it was; exception also lets files outside the
  -- team's paths through integrate for this one task.
  when 'task_unblock', 'task_exception' then
    perform chat_private.hfma_owner(v_sender);
    v_task := chat_private.hfma_task(p_args);
    v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
    if p_op = 'task_unblock' and v_task.status <> 'BLOCKED' then
      perform chat_private.hfma_fail('status', format('Tugas berstatus %s, bukan BLOCKED.', v_task.status));
    end if;
    update chat_private.tasks set exception = exception or p_op = 'task_exception',
      status = case when status = 'BLOCKED' then blocked_from else status end,
      blocked_from = null, block_reason = null, rejections = 0, integrate_failures = 0
      where id = v_task.id;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, replace(p_op, 'task_', ''), v_task.generation,
      null, null, v_reason);
    return chat_private.hfma_task_json(v_task.id);

  when 'delegate' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    perform chat_private.hfma_holder(v_task, v_sender, p_args);
    if v_task.status <> 'CLAIMED' then
      perform chat_private.hfma_fail('status', format('Tugas berstatus %s, bukan CLAIMED.', v_task.status));
    end if;
    insert into chat_private.delegations(task_id, leader, generation, label, contract)
      values (v_task.id, v_sender, v_task.generation, chat_private.hfma_text(p_args, 'label', 80),
        chat_private.hfma_text(p_args, 'contract', 16000))
      returning id into v_id;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'delegate', v_task.generation, null, null,
      p_args->>'label');
    return jsonb_build_object('delegation', v_id, 'task', v_task.id);

  -- A result keeps the child's findings, assumptions, evidence and objections
  -- apart, so objections survive the leader's summary.
  when 'child_close' then
    select t.* into v_task from chat_private.tasks t join chat_private.delegations d on d.task_id = t.id
      where d.id = chat_private.hfma_id(p_args, 'delegation') for update of t;
    if not found then
      perform chat_private.hfma_fail('missing', 'Delegasi tidak ditemukan.');
    end if;
    if v_sender <> v_task.team then
      perform chat_private.hfma_fail('forbidden', format('Hanya tim %s yang menutup delegasi ini.', v_task.team));
    end if;
    v_status := coalesce(p_args->>'status', '');
    if v_status not in ('accepted', 'rejected', 'failed', 'cancelled') then
      perform chat_private.hfma_fail('invalid', 'status wajib accepted, rejected, failed, atau cancelled.');
    end if;
    if v_status <> 'cancelled' then
      v_reason := chat_private.hfma_text(p_args, 'result', 16000);
      select array_agg(h) into v_ok from unnest(array['Temuan', 'Asumsi', 'Bukti', 'Keberatan']) h
        where v_reason !~* ('(^|\n)#+\s*' || h);
      if v_ok is not null then
        perform chat_private.hfma_fail('invalid', 'Hasil wajib punya judul bagian: ' || array_to_string(v_ok, ', ') || '.');
      end if;
    end if;
    update chat_private.delegations set status = v_status, result = v_reason, closed_at = now()
      where id = (p_args->>'delegation')::bigint and status = 'open';
    if not found then
      perform chat_private.hfma_fail('status', 'Delegasi sudah ditutup.');
    end if;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'child_' || v_status, v_task.generation);
    return jsonb_build_object('delegation', (p_args->>'delegation')::bigint, 'status', v_status);

  when 'task_get' then
    v_id := chat_private.hfma_id(p_args, 'task');
    if not exists (select 1 from chat_private.tasks where id = v_id) then
      perform chat_private.hfma_fail('missing', 'Tugas tidak ditemukan.');
    end if;
    return chat_private.hfma_task_json(v_id) || jsonb_build_object(
      'reviews', coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from chat_private.reviews r where r.task_id = v_id), '[]'),
      'evidence', coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from chat_private.evidence e where e.task_id = v_id), '[]'),
      'delegations', coalesce((select jsonb_agg(to_jsonb(d) order by d.id) from chat_private.delegations d where d.task_id = v_id), '[]'),
      'events', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from chat_private.task_events x where x.task_id = v_id), '[]'));

  when 'board' then
    v_room := chat_private.hfma_room(p_args);
    select * into v_project from chat_private.projects where room = v_room;
    return jsonb_build_object('room', v_room,
      'charter_version', (select max(version) from chat_private.charters where room = v_room),
      'project', to_jsonb(v_project) - 'room',
      'tasks', coalesce((select jsonb_agg(chat_private.hfma_task_json(t.id) order by t.id)
        from chat_private.tasks t where t.room = v_room), '[]'));

  -- Only yeebyor closes, against the latest charter: every task finished, main
  -- consistent, each command criterion passing on main, each owner criterion
  -- confirmed by yeebyor in this call.
  when 'project_close' then
    perform chat_private.hfma_owner(v_sender);
    v_room := chat_private.hfma_room(p_args);
    perform chat_private.hfma_open(v_room, true);
    v_charter := chat_private.hfma_charter(v_room);
    select * into v_project from chat_private.projects where room = v_room for update;
    if v_project.main_hash is null then
      perform chat_private.hfma_fail('missing', 'Hash main belum dicatat.');
    end if;
    if exists (select 1 from chat_private.tasks where room = v_room and status not in ('DONE', 'CANCELLED')) then
      perform chat_private.hfma_fail('status', 'Masih ada tugas yang belum DONE atau CANCELLED.');
    end if;
    if p_args ? 'owner_criteria' and jsonb_typeof(p_args->'owner_criteria') <> 'array' then
      perform chat_private.hfma_fail('invalid', 'owner_criteria wajib berupa daftar ID kriteria.');
    end if;
    for v_item in select * from jsonb_array_elements(v_charter.body->'criteria') loop
      if v_item->>'check' = 'owner' and not coalesce(p_args->'owner_criteria', '[]') ? (v_item->>'id') then
        perform chat_private.hfma_fail('criteria', format('Kriteria %s belum kamu nyatakan terpenuhi.', v_item->>'id'));
      end if;
      if v_item->>'check' = 'command' and not exists (select 1 from chat_private.evidence e where e.room = v_room
          and e.kind = 'close' and e.criterion = v_item->>'id' and e.commit = v_project.main_hash
          and e.charter_version = v_charter.version and e.command = v_item->>'command'
          and e.exit_code = 0 and not e.timed_out) then
        perform chat_private.hfma_fail('criteria', format('Kriteria %s belum punya bukti lulus pada main untuk piagam versi %s.',
          v_item->>'id', v_charter.version));
      end if;
    end loop;
    update chat_private.projects set closed_at = now() where room = v_room;
    perform chat_private.hfma_event(v_room, null, v_sender, 'close', null, v_project.main_hash);
    return jsonb_build_object('room', v_room, 'closed', true, 'main_hash', v_project.main_hash, 'charter_version', v_charter.version);

  else
    perform chat_private.hfma_fail('invalid', format('Operasi %s tidak dikenal.', p_op));
  end case;
  return null;
end;
$$;

create function public.chat_hfma(p_token text, p_op text, p_args jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.hfma(p_token, p_op, p_args);
$$;
revoke execute on all functions in schema chat_private from public, anon, authenticated;
revoke execute on function public.chat_hfma(text, text, jsonb) from public, anon, authenticated;
grant execute on function chat_private.read_messages(text,text,integer,bigint,bigint,text),
  chat_private.send_message(text,text,text,uuid,bigint), chat_private.list_rooms(text),
  chat_private.create_room(text,text), chat_private.set_room_pinned(text,text,boolean),
  chat_private.rename_room(text,text,text), chat_private.delete_room(text,text),
  chat_private.realtime_topic(text), chat_private.hfma(text,text,jsonb) to anon, authenticated;
grant execute on function public.chat_hfma(text, text, jsonb) to anon, authenticated;
