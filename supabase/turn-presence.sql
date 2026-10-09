-- Upgrade after turn-sessions.sql, without modifying chat history; schema.sql
-- already contains the same code.
-- 1. Presence: agents running `wait` report themselves each poll. Agents not
--    seen for 90 seconds leave the draw, so a stopped agent no longer stalls it.
-- 2. Only @mentions route the turn. One @name hands that agent the turn; several
--    restrict the draw to them. Plain names are ordinary text.
-- 3. Listening: an agent that reports `listening` reads along but is drawn only
--    when someone @mentions it.

create table chat_private.presence (
  room text not null check (room ~ '^[A-Za-z0-9_-]{1,50}$'),
  sender text not null check (sender in ('Claude', 'GPT', 'Gemini')),
  seen_at timestamptz not null default now(),
  listening boolean not null default false,
  primary key (room, sender)
);
alter table chat_private.presence enable row level security;
create policy deny_direct_access on chat_private.presence for all to anon, authenticated using (false) with check (false);
revoke all on chat_private.presence from public, anon, authenticated;

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
  if v_last.sender = 'yeebyor' and v_last.message ~* '(percakapan|diskusi) selesai' then
    return jsonb_build_object('next', null, 'stopped', true, 'probabilities', null, 'roll', null,
      'last_id', v_last.id::text, 'last_sender', v_last.sender, 'open_at', null,
      'called', '[]'::jsonb, 'present', to_jsonb(v_present), 'listening', to_jsonb(v_listening));
  end if;
  select max(id) into v_stop_id from chat_private.messages
    where room = p_room and sender = 'yeebyor' and message ~* '(percakapan|diskusi) selesai';
  select coalesce(array_agg(agent), '{}') into v_called from unnest(v_agents) agent
    where agent is distinct from v_last.sender and v_last.message ~* ('@' || agent || '\M');
  -- @mentions decide the pool. Otherwise: agents present and not listening;
  -- if nobody reports presence (e.g. direct API use), every non-listener.
  if cardinality(v_called) > 0 then
    v_pool := v_called;
  else
    select coalesce(array_agg(agent), '{}') into v_pool from unnest(v_agents) agent
      where agent is distinct from v_last.sender and agent = any(v_present);
    if cardinality(v_pool) = 0 then
      select coalesce(array_agg(agent), '{}') into v_pool from unnest(v_agents) agent
        where agent is distinct from v_last.sender and not agent = any(v_listening);
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
      'called', to_jsonb(v_called), 'present', to_jsonb(v_present), 'listening', to_jsonb(v_listening));
  end if;
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
    'open_at', v_last.created_at + interval '120 seconds',
    'called', to_jsonb(v_called), 'present', to_jsonb(v_present), 'listening', to_jsonb(v_listening));
end;
$$;

drop function public.chat_read(text, text, integer, bigint, bigint);
drop function chat_private.read_messages(text, text, integer, bigint, bigint);

create function chat_private.read_messages(p_token text, p_room text, p_limit integer, p_after bigint, p_before bigint,
  p_presence text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sender text; v_messages jsonb;
begin
  v_sender := chat_private.identify(p_token);
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_limit is null or p_limit not between 1 and 200
    or p_after < 0 or p_before < 1 or (p_after is not null and p_before is not null)
    or p_presence not in ('active', 'listening') then
    raise sqlstate '22023' using message = 'Invalid room or pagination';
  end if;
  if p_presence is not null and v_sender <> 'yeebyor' then
    insert into chat_private.presence(room, sender, seen_at, listening)
      values (p_room, v_sender, now(), p_presence = 'listening')
      on conflict (room, sender) do update set seen_at = excluded.seen_at, listening = excluded.listening;
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

create function public.chat_read(p_token text, p_room text default 'general', p_limit integer default 100,
  p_after bigint default null, p_before bigint default null, p_presence text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.read_messages(p_token, p_room, p_limit, p_after, p_before, p_presence);
$$;

revoke execute on function chat_private.read_messages(text,text,integer,bigint,bigint,text),
  public.chat_read(text,text,integer,bigint,bigint,text) from public, anon, authenticated;
grant execute on function chat_private.read_messages(text,text,integer,bigint,bigint,text),
  public.chat_read(text,text,integer,bigint,bigint,text) to anon, authenticated;
notify pgrst, 'reload schema';

-- RAISE rejects a null detail, so an idle room (everyone listening) reports
-- 'none' instead of failing.
create or replace function chat_private.send_message(p_token text, p_room text, p_message text, p_client_id uuid,
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
        raise sqlstate 'CTURN' using message = 'Not your turn', detail = coalesce(v_turn->>'next', 'none');
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
