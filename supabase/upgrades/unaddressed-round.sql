-- A message from yeebyor that names no agent is for everyone.
--
-- compute_turn now also reads yeebyor's latest message: when it has no @agent, every agent that
-- is present or listening and has not spoken since it enters a round. The draw (the same weights
-- as before) picks one at a time, each answers once, and when all have answered nobody speaks
-- until yeebyor writes again. Nothing is stored: who is left is read from the room. A round
-- lasts ten minutes, skips agents that are not present, and an @ in the last message (a
-- handoff between agents) still comes first. A message with @agent works as before.
-- The turn object gains "round": the agents that still have to answer.

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
  v_owner_last chat_private.messages;
  v_spoke text[];
  v_round text[] := '{}';
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
  -- A message from yeebyor that names no agent is for everyone: each agent that is present or
  -- listening answers once, in the order the draw gives, then the room goes quiet. Who still has
  -- to answer is read from the room itself (the agents with no message after yeebyor's), so
  -- nothing is stored. It holds for ten minutes, so an agent that never answers cannot hold
  -- the turn for good, and an @ in the last message (a handoff) still comes first.
  select * into v_owner_last from chat_private.messages
    where room = p_room and sender = 'yeebyor' order by id desc limit 1;
  if v_owner_last.id is not null
    and v_owner_last.message !~* '@(Claude|GPT|Gemini)\M'
    and v_owner_last.message !~* '^\s*conversation\s+over\s*[.!]*\s*$'
    and v_owner_last.created_at > now() - interval '10 minutes'
    and (v_last.id = v_owner_last.id or (v_last.sender <> 'yeebyor' and cardinality(v_called) = 0)) then
    select coalesce(array_agg(sender), '{}') into v_spoke from (
      select distinct sender from chat_private.messages where room = p_room and id > v_owner_last.id
    ) after_owner;
    select coalesce(array_agg(agent), '{}') into v_round from unnest(v_agents) agent
      where agent is distinct from v_last.sender
        and (agent = any(v_present) or agent = any(v_listening))
        and not agent = any(v_spoke);
  end if;
  -- @mentions decide the pool, then an open round for yeebyor's message to everyone.
  -- Otherwise: agents present and not listening.
  if cardinality(v_called) > 0 then
    v_pool := v_called;
  elsif cardinality(v_round) > 0 then
    v_pool := v_round;
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
    'called', to_jsonb(v_called), 'round', to_jsonb(v_round),
    'present', to_jsonb(v_present), 'listening', to_jsonb(v_listening),
    'gather_until', v_gather_until, 'gather_seed', v_gather_seed, 'owner_called_until', null);
end;
$$;
