-- Weighted, seeded turn-taking for agents. Upgrades existing installations
-- without modifying chat history; schema.sql already contains the same code.

-- Who speaks next is computed from shared history only, so every reader gets
-- the same answer. Weight per agent: 1 / (1 + messages in the last 6), times 3
-- if the last message names it (times 10 if yeebyor named it), and 0 for the
-- last speaker. The roll comes from sha256(room:last_id), so it is random-looking
-- but identical for everyone. "percakapan selesai" from yeebyor stops all agents.
create or replace function chat_private.compute_turn(p_room text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_agents text[] := array['Claude', 'GPT', 'Gemini'];
  v_weights numeric[] := array[0, 0, 0];
  v_last chat_private.messages;
  v_count integer;
  v_total numeric := 0;
  v_cumulative numeric := 0;
  v_roll numeric;
  v_next text;
  v_probabilities jsonb := '{}'::jsonb;
begin
  select * into v_last from chat_private.messages where room = p_room order by id desc limit 1;
  if v_last.sender = 'yeebyor' and v_last.message ~* '(percakapan|diskusi) selesai' then
    return jsonb_build_object('next', null, 'stopped', true, 'probabilities', null, 'roll', null,
      'last_id', v_last.id::text, 'last_sender', v_last.sender, 'open_at', null);
  end if;
  for i in 1..3 loop
    continue when v_agents[i] = v_last.sender;
    select count(*) into v_count from (
      select sender from chat_private.messages where room = p_room order by id desc limit 6
    ) recent where recent.sender = v_agents[i];
    v_weights[i] := 1.0 / (1 + v_count);
    if v_last.message ~* ('\m' || v_agents[i] || '\M') then
      v_weights[i] := v_weights[i] * case when v_last.sender = 'yeebyor' then 10 else 3 end;
    end if;
    v_total := v_total + v_weights[i];
  end loop;
  v_roll := ('x' || pg_catalog.substr(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    p_room || ':' || coalesce(v_last.id, 0)::text, 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint / 4294967296.0;
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
    'open_at', v_last.created_at + interval '120 seconds');
end;
$$;
revoke execute on function chat_private.compute_turn(text) from public, anon, authenticated;

create or replace function chat_private.read_messages(p_token text, p_room text, p_limit integer, p_after bigint, p_before bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_messages jsonb;
begin
  perform chat_private.identify(p_token);
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_limit is null or p_limit not between 1 and 200
    or p_after < 0 or p_before < 1 or (p_after is not null and p_before is not null) then
    raise sqlstate '22023' using message = 'Invalid room or pagination';
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

create or replace function chat_private.send_message(p_token text, p_room text, p_message text, p_client_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sender text; v_row chat_private.messages; v_text text := btrim(p_message); v_turn jsonb;
begin
  v_sender := chat_private.identify(p_token);
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_client_id is null
    or v_text is null or char_length(v_text) not between 1 and 4000 then
    raise sqlstate '22023' using message = 'Invalid room or message';
  end if;
  insert into chat_private.rooms(name) values (p_room) on conflict do nothing;
  -- Serialize writers in a room BEFORE allocating IDs. Incremental readers
  -- cannot skip a lower ID committed after a higher one in the same room.
  perform 1 from chat_private.rooms where name = p_room for update;
  select * into v_row from chat_private.messages
    where room = p_room and sender = v_sender and client_id = p_client_id;
  if found then
    if v_row.message <> v_text then
      raise sqlstate '23505' using message = 'Request ID already used for different text';
    end if;
  else
    -- yeebyor may always speak. Agents need the turn, checked under the room
    -- lock; after 120 seconds of silence any agent except the last speaker may.
    if v_sender <> 'yeebyor' then
      v_turn := chat_private.compute_turn(p_room);
      if (v_turn->>'stopped')::boolean then
        raise sqlstate 'CTURN' using message = 'Conversation stopped by yeebyor', detail = 'stopped';
      end if;
      if v_turn->>'next' is distinct from v_sender and not (
        v_sender is distinct from v_turn->>'last_sender' and v_turn->>'open_at' is not null
        and now() >= (v_turn->>'open_at')::timestamptz
      ) then
        raise sqlstate 'CTURN' using message = 'Not your turn', detail = v_turn->>'next';
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
