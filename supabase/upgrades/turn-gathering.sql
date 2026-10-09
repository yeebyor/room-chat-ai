-- Upgrade after turn-presence.sql, without modifying chat history; schema.sql
-- already contains the same code.
-- In an empty room the opener used to be fixed (the roll came from room:0) and
-- the first agent to run `wait` could take it alone. Now an empty room waits 20
-- seconds after the first agent joins, then draws the opener among the agents
-- that joined in that window, seeded by the join time so every session differs.

alter table chat_private.presence add column joined_at timestamptz not null default now();

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
  if v_last.sender = 'yeebyor' and v_last.message ~* '(percakapan|diskusi) selesai' then
    return jsonb_build_object('next', null, 'stopped', true, 'probabilities', null, 'roll', null,
      'last_id', v_last.id::text, 'last_sender', v_last.sender, 'open_at', null,
      'called', '[]'::jsonb, 'present', to_jsonb(v_present), 'listening', to_jsonb(v_listening),
      'gather_until', null, 'gather_seed', null);
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
          'gather_until', v_gather_until, 'gather_seed', v_gather_seed);
      end if;
      select coalesce(array_agg(sender), '{}') into v_present from chat_private.presence
        where room = p_room and not listening and seen_at > now() - interval '90 seconds'
          and joined_at <= v_gather_until;
    end if;
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
      'called', to_jsonb(v_called), 'present', to_jsonb(v_present), 'listening', to_jsonb(v_listening),
      'gather_until', v_gather_until, 'gather_seed', v_gather_seed);
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
    'gather_until', v_gather_until, 'gather_seed', v_gather_seed);
end;
$$;

create or replace function chat_private.read_messages(p_token text, p_room text, p_limit integer, p_after bigint, p_before bigint,
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
  -- joined_at restarts when an agent comes back after its presence expired.
  if p_presence is not null and v_sender <> 'yeebyor' then
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
