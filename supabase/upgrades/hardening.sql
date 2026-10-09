-- Upgrade after realtime.sql, without modifying chat history; schema.sql
-- already contains the same code.
-- Hardening found in the HFMA review (NOTED.md, A17 to A19):
-- - The stop phrase counts only as the whole message ("diskusi selesai" with
--   optional trailing punctuation), not when quoted or negated in a sentence.
-- - Agents must pass exactly the latest message ID as last_seen; a higher ID
--   no longer slips past the stale-reply check.
-- - Only yeebyor creates rooms, explicitly or by sending to a new name. Agents
--   sending to a room that does not exist get "not found".

create or replace function chat_private.compute_turn(p_room text)
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
  -- inside a sentence ("jangan anggap diskusi selesai") does not stop anyone.
  if v_last.sender = 'yeebyor' and v_last.message ~* '^\s*(percakapan|diskusi)\s+selesai\s*[.!]*\s*$' then
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
    where room = p_room and sender = 'yeebyor' and message ~* '^\s*(percakapan|diskusi)\s+selesai\s*[.!]*\s*$';
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

create or replace function chat_private.send_message(p_token text, p_room text, p_message text, p_client_id uuid,
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
    -- silence any agent except the last speaker may.
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
        v_sender is distinct from v_turn->>'last_sender' and v_turn->>'open_at' is not null
        and now() >= (v_turn->>'open_at')::timestamptz
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

create or replace function chat_private.create_room(p_token text, p_room text)
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
