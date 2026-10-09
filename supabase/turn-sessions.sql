-- Upgrade after turn-taking.sql, without modifying chat history; schema.sql
-- already contains the same code.
-- 1. Balance only counts messages after the last "percakapan selesai", so every
--    discussion starts with equal odds.
-- 2. yeebyor naming exactly one agent hands that agent the turn outright.
-- 3. Agents must send the last message ID they read (p_last_seen); a reply
--    written from stale context is rejected.

create or replace function chat_private.compute_turn(p_room text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_agents text[] := array['Claude', 'GPT', 'Gemini'];
  v_weights numeric[] := array[0, 0, 0];
  v_last chat_private.messages;
  v_stop_id bigint;
  v_named text[];
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
  select max(id) into v_stop_id from chat_private.messages
    where room = p_room and sender = 'yeebyor' and message ~* '(percakapan|diskusi) selesai';
  select array_agg(agent) into v_named from unnest(v_agents) agent
    where v_last.message ~* ('\m' || agent || '\M');
  for i in 1..3 loop
    continue when v_agents[i] = v_last.sender;
    if v_last.sender = 'yeebyor' and cardinality(v_named) = 1 then
      v_weights[i] := case when v_agents[i] = v_named[1] then 1 else 0 end;
    else
      select count(*) into v_count from (
        select sender from chat_private.messages
        where room = p_room and id > coalesce(v_stop_id, 0) order by id desc limit 6
      ) recent where recent.sender = v_agents[i];
      v_weights[i] := 1.0 / (1 + v_count);
      if v_agents[i] = any(v_named) then
        v_weights[i] := v_weights[i] * case when v_last.sender = 'yeebyor' then 10 else 3 end;
      end if;
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

drop function public.chat_send(text, text, text, uuid);
drop function chat_private.send_message(text, text, text, uuid);

create function chat_private.send_message(p_token text, p_room text, p_message text, p_client_id uuid,
  p_last_seen bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sender text; v_row chat_private.messages; v_text text := btrim(p_message); v_turn jsonb;
begin
  v_sender := chat_private.identify(p_token);
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_client_id is null
    or v_text is null or char_length(v_text) not between 1 and 4000 or p_last_seen < 0 then
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
    -- yeebyor may always speak. Agents must reply to the latest message and
    -- need the turn, checked under the room lock; after 120 seconds of
    -- silence any agent except the last speaker may.
    if v_sender <> 'yeebyor' then
      if p_last_seen is null then
        raise sqlstate 'CTURN' using message = 'Agents must send the last message ID they read', detail = 'last_seen';
      end if;
      if exists (select 1 from chat_private.messages where room = p_room and id > p_last_seen) then
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

create function public.chat_send(p_token text, p_room text, p_message text, p_client_id uuid,
  p_last_seen bigint default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.send_message(p_token, p_room, p_message, p_client_id, p_last_seen);
$$;

revoke execute on function chat_private.send_message(text,text,text,uuid,bigint),
  public.chat_send(text,text,text,uuid,bigint) from public, anon, authenticated;
grant execute on function chat_private.send_message(text,text,text,uuid,bigint),
  public.chat_send(text,text,text,uuid,bigint) to anon, authenticated;
notify pgrst, 'reload schema';
