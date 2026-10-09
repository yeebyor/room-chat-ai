-- Private storage; no table is exposed to the public Data API.
create schema if not exists chat_private;
revoke all on schema chat_private from public, anon, authenticated;

create table chat_private.credentials (
  token_hash text primary key,
  sender text not null check (sender in ('yeebyor', 'Claude', 'GPT', 'Gemini')),
  revoked boolean not null default false
);
create table chat_private.rooms (
  name text primary key check (name ~ '^[A-Za-z0-9_-]{1,50}$'),
  created_at timestamptz not null default now(),
  pinned boolean not null default false
);
create table chat_private.messages (
  id bigint generated always as identity primary key,
  client_id uuid not null,
  sender text not null check (sender in ('yeebyor', 'Claude', 'GPT', 'Gemini')),
  room text not null references chat_private.rooms(name) on update cascade,
  message text not null check (char_length(btrim(message)) between 1 and 4000),
  created_at timestamptz not null default now(),
  unique (room, sender, client_id)
);
create index messages_room_id_idx on chat_private.messages(room, id);
alter table chat_private.credentials enable row level security;
alter table chat_private.rooms enable row level security;
alter table chat_private.messages enable row level security;
create policy deny_direct_access on chat_private.credentials for all to anon, authenticated using (false) with check (false);
create policy deny_direct_access on chat_private.rooms for all to anon, authenticated using (false) with check (false);
create policy deny_direct_access on chat_private.messages for all to anon, authenticated using (false) with check (false);
revoke all on all tables in schema chat_private from public, anon, authenticated;
revoke all on all sequences in schema chat_private from public, anon, authenticated;
insert into chat_private.rooms(name, pinned) values ('general', true);

create table chat_private.presence (
  room text not null check (room ~ '^[A-Za-z0-9_-]{1,50}$'),
  sender text not null check (sender in ('Claude', 'GPT', 'Gemini')),
  seen_at timestamptz not null default now(),
  listening boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (room, sender)
);
alter table chat_private.presence enable row level security;
create policy deny_direct_access on chat_private.presence for all to anon, authenticated using (false) with check (false);
revoke all on chat_private.presence from public, anon, authenticated;

-- Realtime is signal only: triggers broadcast "something changed in room X" on a
-- channel whose name is a random secret handed out only to authenticated
-- sessions. Message text never travels over Realtime; clients re-read through
-- the authenticated API. Signals are best effort and never block a chat write.
create table chat_private.settings (
  key text primary key,
  value text not null
);
alter table chat_private.settings enable row level security;
create policy deny_direct_access on chat_private.settings for all to anon, authenticated using (false) with check (false);
revoke all on chat_private.settings from public, anon, authenticated;
insert into chat_private.settings(key, value) values ('realtime_topic', 'chat-' || replace(gen_random_uuid()::text, '-', ''));

-- Capability authentication for CLI agents. Tokens are random 256-bit values,
-- only SHA-256 hashes are stored. These functions intentionally access private
-- tables after verifying the token, not via a user-editable sender/JWT claim.
create function chat_private.identify(p_token text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_sender text;
begin
  select sender into v_sender from chat_private.credentials
  where token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex')
    and not revoked;
  if v_sender is null then
    raise sqlstate '28000' using message = 'Invalid chat credentials';
  end if;
  return v_sender;
end;
$$;

-- Who speaks next is computed from shared history and agent presence; see the
-- headers of supabase/turn-*.sql and CHAT.md for the rules. The roll comes from
-- sha256(room:last_id), so it is random-looking but identical for everyone.
create function chat_private.compute_turn(p_room text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_agents text[] := array['Claude', 'GPT', 'Gemini'];
  v_weights numeric[] := array[0, 0, 0];
  v_last chat_private.messages;
  v_stop_id bigint;
  v_called text[];
  v_present text[];
  v_listening text[];
  v_pool text[];
  v_first_join timestamptz;
  v_gather_until timestamptz;
  v_gather_seed text;
  v_count integer;
  v_total numeric := 0;
  v_cumulative numeric := 0;
  v_roll numeric;
  v_next text;
  v_probabilities jsonb := '{}'::jsonb;
begin
  select * into v_last from chat_private.messages where room = p_room order by id desc limit 1;
  select coalesce(array_agg(sender), '{}') into v_present from chat_private.presence
    where room = p_room and not listening and seen_at > now() - interval '90 seconds';
  select coalesce(array_agg(sender), '{}') into v_listening from chat_private.presence
    where room = p_room and listening and seen_at > now() - interval '90 seconds';
  -- The stop phrase counts only as the whole message, so quoting or negating it
  -- inside a sentence ("don't call it conversation over yet") does not stop anyone.
  if v_last.sender = 'yeebyor' and v_last.message ~* '^\s*conversation\s+over\s*[.!]*\s*$' then
    return jsonb_build_object('next', null, 'stopped', true, 'probabilities', null, 'roll', null,
      'last_id', v_last.id::text, 'last_sender', v_last.sender, 'open_at', null,
      'called', '[]'::jsonb, 'present', to_jsonb(v_present), 'listening', to_jsonb(v_listening),
      'gather_until', null, 'gather_seed', null, 'owner_called_until', null);
  end if;
  -- An agent calling @yeebyor holds the turn so yeebyor can answer first.
  if v_last.sender <> 'yeebyor' and v_last.message ~* '@yeebyor\M'
    and now() < v_last.created_at + interval '100 seconds' then
    return jsonb_build_object('next', null, 'stopped', false, 'probabilities', null, 'roll', null,
      'last_id', v_last.id::text, 'last_sender', v_last.sender, 'open_at', null,
      'called', '[]'::jsonb, 'present', to_jsonb(v_present), 'listening', to_jsonb(v_listening),
      'gather_until', null, 'gather_seed', null,
      'owner_called_until', v_last.created_at + interval '100 seconds');
  end if;
  -- Empty room: wait 20 seconds after the first agent joins, then draw among
  -- the agents that joined in that window. Later joiners only miss the opener.
  if v_last.id is null then
    select min(joined_at) into v_first_join from chat_private.presence
      where room = p_room and seen_at > now() - interval '90 seconds';
    if v_first_join is not null then
      v_gather_until := v_first_join + interval '20 seconds';
      v_gather_seed := (extract(epoch from v_first_join) * 1000000)::bigint::text;
      if now() < v_gather_until then
        return jsonb_build_object('next', null, 'stopped', false, 'probabilities', null, 'roll', null,
          'last_id', null, 'last_sender', null, 'open_at', null,
          'called', '[]'::jsonb, 'present', to_jsonb(v_present), 'listening', to_jsonb(v_listening),
          'gather_until', v_gather_until, 'gather_seed', v_gather_seed, 'owner_called_until', null);
      end if;
      select coalesce(array_agg(sender), '{}') into v_present from chat_private.presence
        where room = p_room and not listening and seen_at > now() - interval '90 seconds'
          and joined_at <= v_gather_until;
    end if;
  end if;
  select max(id) into v_stop_id from chat_private.messages
    where room = p_room and sender = 'yeebyor' and message ~* '^\s*conversation\s+over\s*[.!]*\s*$';
  select coalesce(array_agg(agent), '{}') into v_called from unnest(v_agents) agent
    where agent is distinct from v_last.sender and v_last.message ~* ('@' || agent || '\M');
  -- @mentions decide the pool. Otherwise: agents present and not listening.
  if cardinality(v_called) > 0 then
    v_pool := v_called;
  else
    select coalesce(array_agg(agent), '{}') into v_pool from unnest(v_agents) agent
      where agent is distinct from v_last.sender and agent = any(v_present);
    if cardinality(v_pool) = 0 then
      if cardinality(v_present) + cardinality(v_listening) = 0 then
        -- Nobody reports presence (e.g. direct API use): every other agent.
        select coalesce(array_agg(agent), '{}') into v_pool from unnest(v_agents) agent
          where agent is distinct from v_last.sender;
      elsif v_last.sender = any(v_present) then
        -- The only agent present may continue, e.g. to call @yeebyor before leaving.
        v_pool := array[v_last.sender];
      end if;
    end if;
  end if;
  for i in 1..3 loop
    continue when not v_agents[i] = any(v_pool);
    if cardinality(v_called) = 1 then
      v_weights[i] := 1;
    else
      select count(*) into v_count from (
        select sender from chat_private.messages
        where room = p_room and id > coalesce(v_stop_id, 0) order by id desc limit 6
      ) recent where recent.sender = v_agents[i];
      v_weights[i] := 1.0 / (1 + v_count);
    end if;
    v_total := v_total + v_weights[i];
  end loop;
  if v_total = 0 then
    -- Everyone else is listening: nobody speaks until someone is @mentioned.
    return jsonb_build_object('next', null, 'stopped', false, 'probabilities', null, 'roll', null,
      'last_id', v_last.id::text, 'last_sender', v_last.sender, 'open_at', null,
      'called', to_jsonb(v_called), 'present', to_jsonb(v_present), 'listening', to_jsonb(v_listening),
      'gather_until', v_gather_until, 'gather_seed', v_gather_seed, 'owner_called_until', null);
  end if;
  v_roll := ('x' || pg_catalog.substr(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    p_room || ':' || coalesce(v_last.id, 0)::text || coalesce(':' || v_gather_seed, ''), 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint / 4294967296.0;
  for i in 1..3 loop
    v_probabilities := v_probabilities || jsonb_build_object(v_agents[i], round(v_weights[i] / v_total, 4));
    continue when v_weights[i] = 0;
    v_cumulative := v_cumulative + v_weights[i] / v_total;
    -- The last eligible agent also absorbs any rounding left below 1.
    if v_next is null and (v_roll < v_cumulative or i = 3 or v_weights[i + 1] + v_weights[3] = 0) then
      v_next := v_agents[i];
    end if;
  end loop;
  return jsonb_build_object('next', v_next, 'stopped', false, 'probabilities', v_probabilities,
    'roll', round(v_roll, 4), 'last_id', v_last.id::text, 'last_sender', v_last.sender,
    'open_at', v_last.created_at + interval '120 seconds',
    'called', to_jsonb(v_called), 'present', to_jsonb(v_present), 'listening', to_jsonb(v_listening),
    'gather_until', v_gather_until, 'gather_seed', v_gather_seed, 'owner_called_until', null);
end;
$$;

create function chat_private.read_messages(p_token text, p_room text, p_limit integer, p_after bigint, p_before bigint,
  p_presence text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sender text; v_messages jsonb;
begin
  v_sender := chat_private.identify(p_token);
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_limit is null or p_limit not between 1 and 200
    or p_after < 0 or p_before < 1 or (p_after is not null and p_before is not null)
    or p_presence not in ('active', 'listening', 'left') then
    raise sqlstate '22023' using message = 'Invalid room or pagination';
  end if;
  -- joined_at restarts when an agent comes back after its presence expired.
  if p_presence = 'left' and v_sender <> 'yeebyor' then
    delete from chat_private.presence where room = p_room and sender = v_sender;
  elsif p_presence is not null and v_sender <> 'yeebyor' then
    insert into chat_private.presence as p (room, sender, seen_at, listening, joined_at)
      values (p_room, v_sender, now(), p_presence = 'listening', now())
      on conflict (room, sender) do update set
        joined_at = case when p.seen_at <= now() - interval '90 seconds' then excluded.joined_at else p.joined_at end,
        seen_at = excluded.seen_at, listening = excluded.listening;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id::text, 'client_id', m.client_id, 'sender', m.sender,
    'room', m.room, 'message', m.message, 'created_at', m.created_at
  ) order by m.id), '[]'::jsonb) into v_messages from (
    select * from chat_private.messages
    where room = p_room and (p_after is null or id > p_after) and (p_before is null or id < p_before)
    order by case when p_after is not null then id end asc,
             case when p_after is null then id end desc
    limit p_limit
  ) m;
  return jsonb_build_object('room', p_room, 'messages', v_messages, 'count', jsonb_array_length(v_messages),
    'turn', chat_private.compute_turn(p_room));
end;
$$;

create function chat_private.send_message(p_token text, p_room text, p_message text, p_client_id uuid,
  p_last_seen bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sender text; v_row chat_private.messages; v_text text := btrim(p_message); v_turn jsonb;
  v_latest bigint;
begin
  v_sender := chat_private.identify(p_token);
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_client_id is null
    or v_text is null or char_length(v_text) not between 1 and 4000 or p_last_seen < 0 then
    raise sqlstate '22023' using message = 'Invalid room or message';
  end if;
  -- Only yeebyor's messages may create a room; agents get "not found" for a
  -- room that does not exist, e.g. one deleted while they were working.
  if v_sender = 'yeebyor' then
    insert into chat_private.rooms(name) values (p_room) on conflict do nothing;
  end if;
  -- Serialize writers in a room BEFORE allocating IDs. Incremental readers
  -- cannot skip a lower ID committed after a higher one in the same room.
  perform 1 from chat_private.rooms where name = p_room for update;
  if not found then
    raise sqlstate 'P0002' using message = 'Room not found';
  end if;
  select * into v_row from chat_private.messages
    where room = p_room and sender = v_sender and client_id = p_client_id;
  if found then
    if v_row.message <> v_text then
      raise sqlstate '23505' using message = 'Request ID already used for different text';
    end if;
  else
    -- yeebyor may always speak. Agents must reply to the latest message and
    -- need the turn, checked under the room lock; after 120 seconds of
    -- silence any agent except the last speaker may, and the last speaker too
    -- when no other agent is present (an @mention of an absent agent would
    -- otherwise hold the room forever).
    if v_sender <> 'yeebyor' then
      if p_last_seen is null then
        raise sqlstate 'CTURN' using message = 'Agents must send the last message ID they read', detail = 'last_seen';
      end if;
      -- last_seen must be exactly the latest message ID (0 for an empty room):
      -- lower means newer messages arrived, higher is not a message they read.
      select max(id) into v_latest from chat_private.messages where room = p_room;
      if p_last_seen > coalesce(v_latest, 0) then
        raise sqlstate 'CTURN' using message = 'Last seen ID is not the latest message', detail = 'last_seen';
      end if;
      if p_last_seen < coalesce(v_latest, 0) then
        raise sqlstate 'CTURN' using message = 'New messages since last read', detail = 'stale';
      end if;
      v_turn := chat_private.compute_turn(p_room);
      if (v_turn->>'stopped')::boolean then
        raise sqlstate 'CTURN' using message = 'Conversation stopped by yeebyor', detail = 'stopped';
      end if;
      if v_turn->>'next' is distinct from v_sender and not (
        v_turn->>'open_at' is not null and now() >= (v_turn->>'open_at')::timestamptz
        and (v_sender is distinct from v_turn->>'last_sender'
          or not exists (select 1 from jsonb_array_elements_text(v_turn->'present') p where p <> v_sender))
      ) then
        raise sqlstate 'CTURN' using message = 'Not your turn',
          detail = case when v_turn->>'owner_called_until' is not null then 'owner'
                        else coalesce(v_turn->>'next', 'none') end;
      end if;
    end if;
    insert into chat_private.messages(client_id, sender, room, message)
      values (p_client_id, v_sender, p_room, v_text) returning * into v_row;
  end if;
  return jsonb_build_object('message', jsonb_build_object(
    'id', v_row.id::text, 'client_id', v_row.client_id, 'sender', v_row.sender,
    'room', v_row.room, 'message', v_row.message, 'created_at', v_row.created_at
  ));
end;
$$;

create function chat_private.list_rooms(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rooms jsonb;
begin
  perform chat_private.identify(p_token);
  select coalesce(jsonb_agg(jsonb_build_object(
    'name', r.name, 'created_at', r.created_at, 'pinned', r.pinned,
    'message_count', s.message_count, 'last_message_at', s.last_message_at
  ) order by r.pinned desc, coalesce(s.last_message_at, r.created_at) desc, r.name), '[]'::jsonb)
  into v_rooms
  from chat_private.rooms r
  cross join lateral (
    select count(*) as message_count, max(m.created_at) as last_message_at
    from chat_private.messages m where m.room = r.name
  ) s;
  return jsonb_build_object('rooms', v_rooms);
end;
$$;

create function chat_private.create_room(p_token text, p_room text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row chat_private.rooms;
begin
  if chat_private.identify(p_token) <> 'yeebyor' then
    raise sqlstate '42501' using message = 'Only yeebyor can create rooms';
  end if;
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' then
    raise sqlstate '22023' using message = 'Invalid room';
  end if;
  insert into chat_private.rooms(name) values (p_room) on conflict do nothing;
  select * into v_row from chat_private.rooms where name = p_room;
  return jsonb_build_object('room', jsonb_build_object(
    'name', v_row.name, 'created_at', v_row.created_at, 'pinned', v_row.pinned,
    'message_count', (select count(*) from chat_private.messages where room = p_room),
    'last_message_at', (select max(created_at) from chat_private.messages where room = p_room)));
end;
$$;

create function chat_private.set_room_pinned(p_token text, p_room text, p_pinned boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if chat_private.identify(p_token) <> 'yeebyor' then
    raise sqlstate '42501' using message = 'Only yeebyor can pin rooms';
  end if;
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_pinned is null
    or (p_room = 'general' and not p_pinned) then
    raise sqlstate '22023' using message = 'Invalid room or pin';
  end if;
  update chat_private.rooms set pinned = p_pinned where name = p_room;
  if not found then
    raise sqlstate 'P0002' using message = 'Room not found';
  end if;
  return jsonb_build_object('room', jsonb_build_object('name', p_room, 'pinned', p_pinned));
end;
$$;

-- Only yeebyor can rename or delete a room, and general is protected. Both are
-- refused while any agent has been present in the room during the last 90
-- seconds, so an agent never writes to a room that vanished or changed name.
-- Deleting a room permanently deletes all of its messages.
create function chat_private.rename_room(p_token text, p_room text, p_new text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if chat_private.identify(p_token) <> 'yeebyor' then
    raise sqlstate '42501' using message = 'Only yeebyor can rename rooms';
  end if;
  if p_room is null or p_new is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_new !~ '^[A-Za-z0-9_-]{1,50}$'
    or p_room = 'general' or p_room = p_new then
    raise sqlstate '22023' using message = 'Invalid room or name';
  end if;
  perform 1 from chat_private.rooms where name = p_room for update;
  if not found then
    raise sqlstate 'P0002' using message = 'Room not found';
  end if;
  if exists (select 1 from chat_private.rooms where name = p_new) then
    raise sqlstate 'CROOM' using message = 'Room name already used', detail = 'exists';
  end if;
  if exists (select 1 from chat_private.presence where room = p_room and seen_at > now() - interval '90 seconds') then
    raise sqlstate 'CROOM' using message = 'Agents are still active in this room', detail = 'busy';
  end if;
  -- messages.room follows through ON UPDATE CASCADE; presence has no foreign key.
  update chat_private.rooms set name = p_new where name = p_room;
  delete from chat_private.presence where room = p_room;
  return jsonb_build_object('room', jsonb_build_object('name', p_new, 'renamed_from', p_room));
end;
$$;

create function chat_private.delete_room(p_token text, p_room text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_messages integer;
begin
  if chat_private.identify(p_token) <> 'yeebyor' then
    raise sqlstate '42501' using message = 'Only yeebyor can delete rooms';
  end if;
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_room = 'general' then
    raise sqlstate '22023' using message = 'Invalid room';
  end if;
  perform 1 from chat_private.rooms where name = p_room for update;
  if not found then
    raise sqlstate 'P0002' using message = 'Room not found';
  end if;
  if exists (select 1 from chat_private.presence where room = p_room and seen_at > now() - interval '90 seconds') then
    raise sqlstate 'CROOM' using message = 'Agents are still active in this room', detail = 'busy';
  end if;
  delete from chat_private.messages where room = p_room;
  get diagnostics v_messages = row_count;
  delete from chat_private.presence where room = p_room;
  delete from chat_private.rooms where name = p_room;
  return jsonb_build_object('deleted', p_room, 'messages', v_messages);
end;
$$;

create function chat_private.signal_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_topic text; v_row jsonb;
begin
  begin
    select value into v_topic from chat_private.settings where key = 'realtime_topic';
    v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
    perform realtime.send(jsonb_build_object(
      'table', tg_table_name, 'op', lower(tg_op), 'room', coalesce(v_row->>'room', v_row->>'name')
    ), 'change', v_topic, false);
  exception when others then
    null;
  end;
  return null;
end;
$$;
revoke execute on function chat_private.signal_change() from public, anon, authenticated;

create trigger messages_signal after insert on chat_private.messages
  for each row execute function chat_private.signal_change();
create trigger rooms_signal after insert or update or delete on chat_private.rooms
  for each row execute function chat_private.signal_change();

create function chat_private.realtime_topic(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform chat_private.identify(p_token);
  return jsonb_build_object('topic', (select value from chat_private.settings where key = 'realtime_topic'));
end;
$$;

-- Exposed wrappers are SECURITY INVOKER. Private implementations enforce
-- capability authentication; clients cannot access tables or token hashes.
create function public.chat_read(p_token text, p_room text default 'general', p_limit integer default 100,
  p_after bigint default null, p_before bigint default null, p_presence text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.read_messages(p_token, p_room, p_limit, p_after, p_before, p_presence);
$$;
create function public.chat_send(p_token text, p_room text, p_message text, p_client_id uuid,
  p_last_seen bigint default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.send_message(p_token, p_room, p_message, p_client_id, p_last_seen);
$$;
create function public.chat_rooms(p_token text)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.list_rooms(p_token);
$$;
create function public.chat_create_room(p_token text, p_room text)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.create_room(p_token, p_room);
$$;
create function public.chat_pin_room(p_token text, p_room text, p_pinned boolean)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.set_room_pinned(p_token, p_room, p_pinned);
$$;
create function public.chat_rename_room(p_token text, p_room text, p_new text)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.rename_room(p_token, p_room, p_new);
$$;
create function public.chat_delete_room(p_token text, p_room text)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.delete_room(p_token, p_room);
$$;
create function public.chat_realtime_topic(p_token text)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.realtime_topic(p_token);
$$;
revoke execute on all functions in schema chat_private from public, anon, authenticated;
revoke execute on function public.chat_read(text,text,integer,bigint,bigint,text),
  public.chat_send(text,text,text,uuid,bigint), public.chat_rooms(text),
  public.chat_create_room(text,text), public.chat_pin_room(text,text,boolean),
  public.chat_rename_room(text,text,text), public.chat_delete_room(text,text),
  public.chat_realtime_topic(text) from public, anon, authenticated;
grant usage on schema chat_private to anon, authenticated;
grant execute on function chat_private.read_messages(text,text,integer,bigint,bigint,text),
  chat_private.send_message(text,text,text,uuid,bigint), chat_private.list_rooms(text),
  chat_private.create_room(text,text), chat_private.set_room_pinned(text,text,boolean),
  chat_private.rename_room(text,text,text), chat_private.delete_room(text,text),
  chat_private.realtime_topic(text) to anon, authenticated;
grant execute on function public.chat_read(text,text,integer,bigint,bigint,text),
  public.chat_send(text,text,text,uuid,bigint), public.chat_rooms(text),
  public.chat_create_room(text,text), public.chat_pin_room(text,text,boolean),
  public.chat_rename_room(text,text,text), public.chat_delete_room(text,text),
  public.chat_realtime_topic(text) to anon, authenticated;

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

-- Decisions (HFMA.md section 21): architecture choices recorded under a topic key, so a
-- contradiction becomes a conflict in the database instead of something noticed (or
-- missed) in chat. At most one active decision per key; a second one on the same key
-- that does not say what it supersedes is a conflict until resolved.
create table chat_private.decisions (
  id bigint generated always as identity primary key,
  room text not null references chat_private.rooms(name) on update cascade on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9 ._/-]{0,79}$'),
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 8000),
  actor text not null,
  status text not null check (status in ('active', 'conflict', 'superseded', 'rejected')),
  supersedes bigint references chat_private.decisions(id),
  conflicts_with bigint references chat_private.decisions(id),
  resolved_by text,
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index decisions_one_active on chat_private.decisions(room, key) where status = 'active';
alter table chat_private.decisions enable row level security;
create policy deny_direct_access on chat_private.decisions for all to anon, authenticated using (false) with check (false);
revoke all on chat_private.decisions from public, anon, authenticated;
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
    perform chat_private.hfma_fail('invalid', format('Argument %s must be text of 1 to %s characters.', p_key, p_max));
  end if;
  return p_args->>p_key;
end;
$$;

create function chat_private.hfma_id(p_args jsonb, p_key text) returns bigint
language plpgsql immutable set search_path = '' as $$
begin
  if coalesce(p_args->>p_key, '') !~ '^[1-9][0-9]{0,17}$' then
    perform chat_private.hfma_fail('invalid', format('Argument %s must be a numeric ID.', p_key));
  end if;
  return (p_args->>p_key)::bigint;
end;
$$;

create function chat_private.hfma_hash(p_args jsonb, p_key text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if coalesce(p_args->>p_key, '') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$' then
    perform chat_private.hfma_fail('invalid', format('Argument %s must be a full git commit hash.', p_key));
  end if;
  return p_args->>p_key;
end;
$$;

create function chat_private.hfma_room(p_args jsonb) returns text
language plpgsql stable set search_path = '' as $$
declare v_room text := p_args->>'room';
begin
  if v_room is null or v_room !~ '^[A-Za-z0-9_-]{1,50}$' then
    perform chat_private.hfma_fail('invalid', 'Invalid room argument.');
  end if;
  if not exists (select 1 from chat_private.rooms where name = v_room) then
    perform chat_private.hfma_fail('missing', format('Room %s not found.', v_room));
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
    perform chat_private.hfma_fail('missing', format('Room %s has no charter from yeebyor yet.', p_room));
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
    perform chat_private.hfma_fail('closed', 'yeebyor has closed this project.');
  end if;
  if p_consistent and v_project.inconsistent then
    perform chat_private.hfma_fail('inconsistent', 'The main branch changed outside integrate. Wait for yeebyor to check it.');
  end if;
end;
$$;

create function chat_private.hfma_task(p_args jsonb) returns chat_private.tasks
language plpgsql set search_path = '' as $$
declare v_row chat_private.tasks;
begin
  select * into v_row from chat_private.tasks where id = chat_private.hfma_id(p_args, 'task') for update;
  if not found then
    perform chat_private.hfma_fail('missing', 'Task not found.');
  end if;
  return v_row;
end;
$$;

-- The claim holder is the team leader, acting under the current generation.
create function chat_private.hfma_holder(p_task chat_private.tasks, p_sender text, p_args jsonb) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_sender <> p_task.team then
    perform chat_private.hfma_fail('forbidden', format('Only team %s works on this task.', p_task.team));
  end if;
  if coalesce(p_args->>'generation', '') is distinct from p_task.generation::text then
    perform chat_private.hfma_fail('generation', format('Stale claim generation; the active generation is %s.', p_task.generation));
  end if;
end;
$$;

create function chat_private.hfma_manager(p_room text, p_sender text) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_sender <> 'yeebyor' and p_sender is distinct from (chat_private.hfma_charter(p_room)).body->>'orchestrator' then
    perform chat_private.hfma_fail('forbidden', 'Only the orchestrator or yeebyor may do this.');
  end if;
end;
$$;

create function chat_private.hfma_owner(p_sender text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_sender <> 'yeebyor' then
    perform chat_private.hfma_fail('forbidden', 'Only yeebyor may do this.');
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
      'Needs passing %s evidence, recorded by you, for commit %s. Run it through scripts/hfma.mjs.', p_kind, p_commit));
  end if;
end;
$$;

create function chat_private.hfma_check_charter(p_body jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare v_item jsonb; v_ids text[] := '{}'; v_key text;
begin
  if jsonb_typeof(p_body) is distinct from 'object' then
    perform chat_private.hfma_fail('invalid', 'The charter must be a JSON object.');
  end if;
  perform chat_private.hfma_text(p_body, 'project_path', 500);
  perform chat_private.hfma_text(p_body, 'goal', 2000);
  perform chat_private.hfma_text(p_body, 'test_command', 500);
  if coalesce(p_body->>'orchestrator', '') not in ('Claude', 'GPT', 'Gemini') then
    perform chat_private.hfma_fail('invalid', 'orchestrator must be one of Claude, GPT or Gemini.');
  end if;
  if jsonb_typeof(p_body->'criteria') is distinct from 'array' or jsonb_array_length(p_body->'criteria') = 0 then
    perform chat_private.hfma_fail('invalid', 'criteria must be a non-empty list.');
  end if;
  for v_item in select * from jsonb_array_elements(p_body->'criteria') loop
    if coalesce(v_item->>'id', '') !~ '^[A-Za-z0-9_-]{1,20}$' or v_item->>'id' = any(v_ids) then
      perform chat_private.hfma_fail('invalid', 'Every criterion needs a unique id (letters, digits, - or _).');
    end if;
    v_ids := v_ids || (v_item->>'id');
    perform chat_private.hfma_text(v_item, 'text', 2000);
    if coalesce(v_item->>'check', '') not in ('command', 'owner') then
      perform chat_private.hfma_fail('invalid', format('Criterion %s: check must be "command" or "owner".', v_item->>'id'));
    end if;
    if (v_item->>'check' = 'command') <> (v_item ? 'command') then
      perform chat_private.hfma_fail('invalid', format('Criterion %s: command is required only when check is "command".', v_item->>'id'));
    end if;
    if v_item->>'check' = 'command' then
      perform chat_private.hfma_text(v_item, 'command', 500);
    end if;
  end loop;
  if jsonb_typeof(p_body->'ownership') is distinct from 'object' then
    perform chat_private.hfma_fail('invalid', 'ownership must be an object: team name to a list of file paths.');
  end if;
  for v_key in select jsonb_object_keys(p_body->'ownership') loop
    if v_key not in ('Claude', 'GPT', 'Gemini') or jsonb_typeof(p_body->'ownership'->v_key) <> 'array'
      or exists (select 1 from jsonb_array_elements(p_body->'ownership'->v_key) p where jsonb_typeof(p) <> 'string') then
      perform chat_private.hfma_fail('invalid', format('ownership.%s must be a list of paths for team Claude, GPT or Gemini.', v_key));
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
  v_key text;
  v_decision chat_private.decisions;
  v_other chat_private.decisions;
begin
  if jsonb_typeof(p_args) is distinct from 'object' then
    perform chat_private.hfma_fail('invalid', 'args must be a JSON object.');
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
      perform chat_private.hfma_fail('missing', 'yeebyor has not recorded the initial main hash yet (hfma.mjs setup).');
    end if;
    -- "dirty" lists tracked files changed or staged in the project folder itself,
    -- which only integrate may touch.
    v_reason := case when p_args ? 'dirty' then chat_private.hfma_text(p_args, 'dirty', 2000) end;
    if (v_project.main_hash <> v_commit or v_reason is not null) and not v_project.inconsistent then
      update chat_private.projects set inconsistent = true where room = v_room;
      perform chat_private.hfma_event(v_room, null, v_sender, 'main_inconsistent', null, v_commit, null,
        case when v_project.main_hash <> v_commit then format('main recorded as %s, found %s', v_project.main_hash, v_commit)
          else 'Uncommitted changes in the project folder: ' || v_reason end);
    end if;
    return jsonb_build_object('room', v_room, 'consistent', v_project.main_hash = v_commit and v_reason is null,
      'main_hash', v_project.main_hash);

  when 'task_create' then
    v_room := chat_private.hfma_room(p_args);
    perform chat_private.hfma_manager(v_room, v_sender);
    perform chat_private.hfma_open(v_room);
    if coalesce(p_args->>'team', '') not in ('Claude', 'GPT', 'Gemini') then
      perform chat_private.hfma_fail('invalid', 'team must be one of Claude, GPT or Gemini.');
    end if;
    if p_args ? 'depends_on' and (jsonb_typeof(p_args->'depends_on') <> 'array'
      or exists (select 1 from jsonb_array_elements_text(p_args->'depends_on') d where d !~ '^[1-9][0-9]{0,17}$'
        or not exists (select 1 from chat_private.tasks t where t.id = d::bigint and t.room = v_room))) then
      perform chat_private.hfma_fail('invalid', 'depends_on must be a list of IDs of tasks that already exist in this room.');
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
      perform chat_private.hfma_fail('forbidden', format('Only team %s may claim this task.', v_task.team));
    end if;
    if v_task.status <> 'TODO' then
      perform chat_private.hfma_fail('status', format('The task status is %s, not TODO.', v_task.status));
    end if;
    if exists (select 1 from chat_private.tasks where id = any(v_task.depends_on) and status <> 'DONE') then
      perform chat_private.hfma_fail('status', 'Some dependencies are not DONE yet.');
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
      perform chat_private.hfma_fail('status', format('The task status is %s, not CLAIMED.', v_task.status));
    end if;
    update chat_private.tasks set heartbeat_at = now() where id = v_task.id;
    return chat_private.hfma_task_json(v_task.id);

  -- Raw test results from scripts/hfma.mjs. Agents never write these by hand.
  when 'evidence_add' then
    v_room := chat_private.hfma_room(p_args);
    v_charter := chat_private.hfma_charter(v_room);
    v_status := coalesce(p_args->>'kind', '');
    if v_status not in ('submit', 'verify', 'integrate', 'close') then
      perform chat_private.hfma_fail('invalid', 'kind must be submit, verify, integrate or close.');
    end if;
    if v_status = 'close' then
      perform chat_private.hfma_owner(v_sender);
      perform chat_private.hfma_text(p_args, 'criterion', 20);
    else
      v_task := chat_private.hfma_task(p_args);
      if v_task.room <> v_room then
        perform chat_private.hfma_fail('invalid', 'That task does not belong to this room.');
      end if;
    end if;
    -- exit_code is null when the command could not start or was killed.
    if not (p_args ? 'exit_code') or (jsonb_typeof(p_args->'exit_code') <> 'null' and coalesce(p_args->>'exit_code', '') !~ '^-?[0-9]{1,9}$')
      or coalesce(jsonb_typeof(p_args->'timed_out'), '') <> 'boolean'
      or coalesce(p_args->>'duration_ms', '') !~ '^[0-9]{1,9}$'
      or coalesce(jsonb_typeof(p_args->'output'), '') <> 'string' or char_length(p_args->>'output') > 16000
      or (p_args ? 'env' and jsonb_typeof(p_args->'env') <> 'object') then
      perform chat_private.hfma_fail('invalid', 'Evidence must include exit_code, timed_out, duration_ms and output (at most 16000 characters).');
    end if;
    insert into chat_private.evidence(room, task_id, kind, criterion, commit, charter_version, command,
      exit_code, timed_out, duration_ms, output, env, actor)
    values (v_room, v_task.id, v_status, p_args->>'criterion', chat_private.hfma_hash(p_args, 'commit'), v_charter.version,
      chat_private.hfma_text(p_args, 'command', 500), (p_args->>'exit_code')::integer, (p_args->>'timed_out')::boolean,
      (p_args->>'duration_ms')::integer, p_args->>'output', coalesce(p_args->'env', '{}'), v_sender)
    returning id into v_id;
    perform chat_private.hfma_event(v_room, v_task.id, v_sender, 'evidence_' || v_status, v_task.generation,
      p_args->>'commit', v_id, case when (p_args->>'exit_code') = '0' and not (p_args->>'timed_out')::boolean then 'passed' else 'failed' end);
    return jsonb_build_object('evidence', v_id, 'passed', (p_args->>'exit_code') = '0' and not (p_args->>'timed_out')::boolean);

  when 'task_submit' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    perform chat_private.hfma_holder(v_task, v_sender, p_args);
    if v_task.status <> 'CLAIMED' then
      perform chat_private.hfma_fail('status', format('The task status is %s, not CLAIMED.', v_task.status));
    end if;
    v_commit := chat_private.hfma_hash(p_args, 'commit');
    perform chat_private.hfma_passing(chat_private.hfma_id(p_args, 'evidence'), v_task.id, 'submit', v_sender, v_commit);
    if exists (select 1 from chat_private.delegations where task_id = v_task.id and status = 'open') then
      perform chat_private.hfma_fail('delegation', 'A sub-agent delegation is still open. Close it first with hfma.mjs child.');
    end if;
    update chat_private.tasks set status = 'REVIEW', candidate = v_commit, heartbeat_at = now() where id = v_task.id;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'submit', v_task.generation, v_commit,
      (p_args->>'evidence')::bigint);
    return chat_private.hfma_task_json(v_task.id);

  when 'task_review' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    if v_sender = v_task.team then
      perform chat_private.hfma_fail('forbidden', 'The authoring team may not review its own task.');
    end if;
    if v_task.status <> 'REVIEW' then
      perform chat_private.hfma_fail('status', format('The task status is %s, not REVIEW.', v_task.status));
    end if;
    v_commit := chat_private.hfma_hash(p_args, 'commit');
    if v_commit <> v_task.candidate then
      perform chat_private.hfma_fail('commit', format('The candidate under review is %s.', v_task.candidate));
    end if;
    v_status := coalesce(p_args->>'verdict', '');
    if v_status not in ('approve', 'reject') then
      perform chat_private.hfma_fail('invalid', 'verdict must be approve or reject.');
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
      perform chat_private.hfma_block(v_task, 'substrate', 'Rejected 3 times; waiting for a decision by yeebyor.');
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
      perform chat_private.hfma_fail('status', format('The task status is %s, not APPROVED.', v_task.status));
    end if;
    if chat_private.hfma_hash(p_args, 'commit') <> v_task.approved_hash then
      perform chat_private.hfma_fail('commit', format('The approved hash is %s.', v_task.approved_hash));
    end if;
    v_status := coalesce(p_args->>'outcome', '');
    if v_status = 'merged' then
      v_commit := chat_private.hfma_hash(p_args, 'merge_hash');
      perform chat_private.hfma_passing(chat_private.hfma_id(p_args, 'evidence'), v_task.id, 'integrate', v_sender, v_commit);
      if not v_task.exception and coalesce(p_args->>'ownership_ok', '') <> 'true' then
        perform chat_private.hfma_fail('invalid', 'merged must include ownership_ok true from the file path check.');
      end if;
      -- Two integrates at once: the merge must sit on the main recorded now, under the
      -- project lock, or a later one would record a merge that leaves the other out.
      select * into v_project from chat_private.projects where room = v_task.room for update;
      if v_project.main_hash is not null and coalesce(p_args->>'base', '') <> v_project.main_hash then
        perform chat_private.hfma_fail('moved', format('main moved to %s while you integrated; run integrate again (the task stays APPROVED).',
          v_project.main_hash));
      end if;
      update chat_private.tasks set status = 'DONE', merge_hash = v_commit, integrate_failures = 0 where id = v_task.id;
      update chat_private.projects set main_hash = v_commit where room = v_task.room;
      perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'integrate', v_task.generation, v_commit,
        (p_args->>'evidence')::bigint);
    elsif v_status = 'moved' then
      update chat_private.tasks set status = 'CLAIMED', candidate = null, approved_hash = null, heartbeat_at = now()
        where id = v_task.id;
      perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'integrate_moved', v_task.generation,
        v_task.approved_hash, null, 'The team branch moved after approval; submit again.');
    elsif v_status = 'ownership' then
      v_reason := 'Files outside the team paths: ' || chat_private.hfma_text(p_args, 'files', 4000);
      perform chat_private.hfma_block(v_task, v_sender, v_reason);
    elsif v_status = 'failed' then
      v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
      v_commit := v_task.approved_hash;
      update chat_private.tasks set status = 'CLAIMED', candidate = null, approved_hash = null, heartbeat_at = now(),
        integrate_failures = integrate_failures + 1 where id = v_task.id returning * into v_task;
      perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'integrate_failed', v_task.generation,
        v_commit, case when p_args ? 'evidence' then chat_private.hfma_id(p_args, 'evidence') end, v_reason);
      if v_task.integrate_failures >= 2 then
        perform chat_private.hfma_block(v_task, 'substrate', 'Integration failed 2 times in a row; waiting for a decision by yeebyor.');
      end if;
    else
      perform chat_private.hfma_fail('invalid', 'outcome must be merged, moved, ownership or failed.');
    end if;
    return chat_private.hfma_task_json(v_task.id);

  when 'task_cancel', 'task_reassign' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    perform chat_private.hfma_manager(v_task.room, v_sender);
    v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
    if v_task.status in ('DONE', 'CANCELLED') then
      perform chat_private.hfma_fail('status', format('The task status is %s.', v_task.status));
    end if;
    if p_op = 'task_reassign' and p_args ? 'team' and coalesce(p_args->>'team', '') not in ('Claude', 'GPT', 'Gemini') then
      perform chat_private.hfma_fail('invalid', 'team must be one of Claude, GPT or Gemini.');
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
      perform chat_private.hfma_fail('status', format('A task with status %s cannot be blocked.', v_task.status));
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
      perform chat_private.hfma_fail('status', format('The task status is %s, not BLOCKED.', v_task.status));
    end if;
    update chat_private.tasks set exception = exception or p_op = 'task_exception',
      status = case when status = 'BLOCKED' then blocked_from else status end,
      blocked_from = null, block_reason = null, rejections = 0, integrate_failures = 0
      where id = v_task.id;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, replace(p_op, 'task_', ''), v_task.generation,
      null, null, v_reason);
    return chat_private.hfma_task_json(v_task.id);

  -- A review finding that does not fit a reject, e.g. a second reviewer whose task was
  -- already returned or approved. next shows notes on an open task to the team holding
  -- it, and notes on a DONE task to the orchestrator as a follow-up.
  when 'task_note' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    if v_sender <> 'yeebyor' and not ((chat_private.hfma_charter(v_task.room)).body->'ownership') ? v_sender then
      perform chat_private.hfma_fail('forbidden', 'Only agents in this project or yeebyor can add notes.');
    end if;
    if v_task.status = 'CANCELLED' then
      perform chat_private.hfma_fail('status', 'The task is CANCELLED; notes are for open or DONE tasks.');
    end if;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'note', v_task.generation, v_task.candidate, null,
      chat_private.hfma_text(p_args, 'note', 8000));
    return chat_private.hfma_task_json(v_task.id);

  when 'delegate' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    perform chat_private.hfma_holder(v_task, v_sender, p_args);
    if v_task.status <> 'CLAIMED' then
      perform chat_private.hfma_fail('status', format('The task status is %s, not CLAIMED.', v_task.status));
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
      perform chat_private.hfma_fail('missing', 'Delegation not found.');
    end if;
    if v_sender <> v_task.team then
      perform chat_private.hfma_fail('forbidden', format('Only team %s closes this delegation.', v_task.team));
    end if;
    v_status := coalesce(p_args->>'status', '');
    if v_status not in ('accepted', 'rejected', 'failed', 'cancelled') then
      perform chat_private.hfma_fail('invalid', 'status must be accepted, rejected, failed or cancelled.');
    end if;
    if v_status <> 'cancelled' then
      v_reason := chat_private.hfma_text(p_args, 'result', 16000);
      select array_agg(h) into v_ok from unnest(array['Findings', 'Assumptions', 'Evidence', 'Objections']) h
        where v_reason !~* ('(^|\n)#+\s*' || h);
      if v_ok is not null then
        perform chat_private.hfma_fail('invalid', 'The result must have the section headings: ' || array_to_string(v_ok, ', ') || '.');
      end if;
    end if;
    update chat_private.delegations set status = v_status, result = v_reason, closed_at = now()
      where id = (p_args->>'delegation')::bigint and status = 'open';
    if not found then
      perform chat_private.hfma_fail('status', 'The delegation is already closed.');
    end if;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'child_' || v_status, v_task.generation);
    return jsonb_build_object('delegation', (p_args->>'delegation')::bigint, 'status', v_status);

  -- Record a decision. A decision on a key that already has an active one either names
  -- it in "supersedes" (a deliberate change) or becomes a conflict.
  when 'decision_add' then
    v_room := chat_private.hfma_room(p_args);
    perform chat_private.hfma_open(v_room);
    v_charter := chat_private.hfma_charter(v_room);
    if v_sender <> 'yeebyor' and not (v_charter.body->'ownership') ? v_sender then
      perform chat_private.hfma_fail('forbidden', 'Only agents in this project or yeebyor can record decisions.');
    end if;
    v_key := lower(btrim(chat_private.hfma_text(p_args, 'key', 80)));
    if v_key !~ '^[a-z0-9][a-z0-9 ._/-]{0,79}$' then
      perform chat_private.hfma_fail('invalid', 'key must be a short topic: letters, digits, spaces, . _ / -');
    end if;
    select * into v_other from chat_private.decisions where room = v_room and key = v_key and status = 'active' for update;
    if p_args ? 'supersedes' then
      if v_other.id is null or v_other.id <> chat_private.hfma_id(p_args, 'supersedes') then
        perform chat_private.hfma_fail('status', format('supersedes must name the active decision on "%s"%s.', v_key,
          case when v_other.id is null then ' (there is none)' else format(' (#%s)', v_other.id) end));
      end if;
      update chat_private.decisions set status = 'superseded', resolved_at = now() where id = v_other.id;
    end if;
    insert into chat_private.decisions(room, key, title, body, actor, status, supersedes, conflicts_with)
      values (v_room, v_key, chat_private.hfma_text(p_args, 'title', 200), chat_private.hfma_text(p_args, 'body', 8000), v_sender,
        case when v_other.id is not null and not p_args ? 'supersedes' then 'conflict' else 'active' end,
        case when p_args ? 'supersedes' then v_other.id end,
        case when v_other.id is not null and not p_args ? 'supersedes' then v_other.id end)
      returning * into v_decision;
    perform chat_private.hfma_event(v_room, null, v_sender,
      case when v_decision.status = 'conflict' then 'decision_conflict' else 'decision' end, null, null, null,
      format('#%s %s: %s', v_decision.id, v_key, v_decision.title));
    return to_jsonb(v_decision);

  -- Settle a conflict: keep the active decision (the new one is rejected) or replace it.
  -- The orchestrator may decide only when neither side is its own; otherwise yeebyor.
  when 'decision_resolve' then
    select * into v_decision from chat_private.decisions where id = chat_private.hfma_id(p_args, 'decision') for update;
    if v_decision.id is null then
      perform chat_private.hfma_fail('missing', 'Decision not found.');
    end if;
    perform chat_private.hfma_open(v_decision.room);
    if v_decision.status <> 'conflict' then
      perform chat_private.hfma_fail('status', format('Decision #%s is %s, not a conflict.', v_decision.id, v_decision.status));
    end if;
    select * into v_other from chat_private.decisions where id = v_decision.conflicts_with for update;
    if v_sender <> 'yeebyor' and (v_sender is distinct from (chat_private.hfma_charter(v_decision.room)).body->>'orchestrator'
        or v_sender in (v_decision.actor, v_other.actor)) then
      perform chat_private.hfma_fail('forbidden', 'Only yeebyor, or the orchestrator when neither decision is its own, can resolve this conflict.');
    end if;
    v_status := coalesce(p_args->>'choice', '');
    if v_status not in ('keep', 'replace') then
      perform chat_private.hfma_fail('invalid', 'choice must be keep (the active decision stays) or replace (the conflicting one wins).');
    end if;
    v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
    if v_status = 'keep' then
      update chat_private.decisions set status = 'rejected', resolved_by = v_sender, resolution = v_reason, resolved_at = now()
        where id = v_decision.id;
    else
      if v_other.status <> 'active' then
        perform chat_private.hfma_fail('status', format('Decision #%s is no longer active; record the new decision again.', v_other.id));
      end if;
      update chat_private.decisions set status = 'superseded', resolved_by = v_sender, resolution = v_reason, resolved_at = now()
        where id = v_other.id;
      update chat_private.decisions set status = 'active', supersedes = v_other.id, resolved_by = v_sender, resolution = v_reason,
        resolved_at = now() where id = v_decision.id;
    end if;
    perform chat_private.hfma_event(v_decision.room, null, v_sender, 'decision_resolve', null, null, null,
      format('#%s on %s: %s. %s', v_decision.id, v_decision.key, case when v_status = 'keep' then format('kept #%s', v_other.id)
        else format('#%s replaces #%s', v_decision.id, v_other.id) end, v_reason));
    return (select to_jsonb(d) from chat_private.decisions d where d.id = v_decision.id);

  when 'task_get' then
    v_id := chat_private.hfma_id(p_args, 'task');
    if not exists (select 1 from chat_private.tasks where id = v_id) then
      perform chat_private.hfma_fail('missing', 'Task not found.');
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
        from chat_private.tasks t where t.room = v_room), '[]'),
      'decisions', coalesce((select jsonb_agg(to_jsonb(d) order by d.id)
        from chat_private.decisions d where d.room = v_room), '[]'));

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
      perform chat_private.hfma_fail('missing', 'The main hash has not been recorded yet.');
    end if;
    if exists (select 1 from chat_private.tasks where room = v_room and status not in ('DONE', 'CANCELLED')) then
      perform chat_private.hfma_fail('status', 'Some tasks are not DONE or CANCELLED yet.');
    end if;
    if exists (select 1 from chat_private.decisions where room = v_room and status = 'conflict') then
      perform chat_private.hfma_fail('conflict', 'A decision conflict is still open; resolve it before closing.');
    end if;
    if p_args ? 'owner_criteria' and jsonb_typeof(p_args->'owner_criteria') <> 'array' then
      perform chat_private.hfma_fail('invalid', 'owner_criteria must be a list of criterion IDs.');
    end if;
    for v_item in select * from jsonb_array_elements(v_charter.body->'criteria') loop
      if v_item->>'check' = 'owner' and not coalesce(p_args->'owner_criteria', '[]') ? (v_item->>'id') then
        perform chat_private.hfma_fail('criteria', format('You have not marked criterion %s as met.', v_item->>'id'));
      end if;
      if v_item->>'check' = 'command' and not exists (select 1 from chat_private.evidence e where e.room = v_room
          and e.kind = 'close' and e.criterion = v_item->>'id' and e.commit = v_project.main_hash
          and e.charter_version = v_charter.version and e.command = v_item->>'command'
          and e.exit_code = 0 and not e.timed_out) then
        perform chat_private.hfma_fail('criteria', format('Criterion %s has no passing evidence on main for charter version %s.',
          v_item->>'id', v_charter.version));
      end if;
    end loop;
    update chat_private.projects set closed_at = now() where room = v_room;
    perform chat_private.hfma_event(v_room, null, v_sender, 'close', null, v_project.main_hash);
    return jsonb_build_object('room', v_room, 'closed', true, 'main_hash', v_project.main_hash, 'charter_version', v_charter.version);

  else
    perform chat_private.hfma_fail('invalid', format('Unknown operation %s.', p_op));
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

-- HFMA stage 4: the task board refreshes on the same signal-only Realtime channel
-- as the chat. Apply after hfma.sql; schema.sql contains the same code.
-- Payloads carry only {table, op, room}; the board re-reads through the API.
create trigger charters_signal after insert on chat_private.charters
  for each row execute function chat_private.signal_change();
create trigger projects_signal after insert or update on chat_private.projects
  for each row execute function chat_private.signal_change();
create trigger tasks_signal after insert or update on chat_private.tasks
  for each row execute function chat_private.signal_change();
create trigger decisions_signal after insert or update on chat_private.decisions
  for each row execute function chat_private.signal_change();

-- The full HFMA record of one room, for the owner's export: every charter version,
-- the project state, tasks, reviews, test evidence (with output), sub-agent
-- delegations, and every event including room-level ones (charter_set, main_set,
-- close). Apply after hfma-realtime.sql; schema.sql contains the same code.
-- A separate function, so chat_private.hfma itself is unchanged.
create function chat_private.hfma_record(p_token text, p_room text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if chat_private.identify(p_token) <> 'yeebyor' then
    raise sqlstate 'CTASK' using message = 'Only yeebyor can export the project record.', detail = 'forbidden';
  end if;
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' then
    raise sqlstate 'CTASK' using message = 'Invalid room.', detail = 'invalid';
  end if;
  return jsonb_build_object(
    'room', p_room,
    'charters', coalesce((select jsonb_agg(jsonb_build_object('version', c.version, 'body', c.body, 'created_at', c.created_at) order by c.version)
      from chat_private.charters c where c.room = p_room), '[]'),
    'project', (select to_jsonb(p) - 'room' from chat_private.projects p where p.room = p_room),
    'tasks', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from chat_private.tasks t where t.room = p_room), '[]'),
    'reviews', coalesce((select jsonb_agg(to_jsonb(r) order by r.id)
      from chat_private.reviews r join chat_private.tasks t on t.id = r.task_id where t.room = p_room), '[]'),
    'evidence', coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from chat_private.evidence e where e.room = p_room), '[]'),
    'delegations', coalesce((select jsonb_agg(to_jsonb(d) order by d.id)
      from chat_private.delegations d join chat_private.tasks t on t.id = d.task_id where t.room = p_room), '[]'),
    'decisions', coalesce((select jsonb_agg(to_jsonb(d) order by d.id) from chat_private.decisions d where d.room = p_room), '[]'),
    'events', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from chat_private.task_events x where x.room = p_room), '[]'));
end;
$$;

create function public.chat_hfma_record(p_token text, p_room text)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.hfma_record(p_token, p_room);
$$;
revoke execute on function chat_private.hfma_record(text, text) from public, anon, authenticated;
revoke execute on function public.chat_hfma_record(text, text) from public, anon, authenticated;
grant execute on function chat_private.hfma_record(text, text) to anon, authenticated;
grant execute on function public.chat_hfma_record(text, text) to anon, authenticated;
