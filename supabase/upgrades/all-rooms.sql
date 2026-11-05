-- Standing by for every room (chat.mjs wait --all): one wait hears a call in any room and wakes with
-- the room that called. Generated from schema.sql.

create table chat_private.standby (
  sender text primary key check (sender in ('Claude', 'GPT', 'Gemini')),
  seen_at timestamptz not null default now()
);
alter table chat_private.standby enable row level security;
create policy deny_direct_access on chat_private.standby for all to anon, authenticated using (false) with check (false);
revoke all on chat_private.standby from public, anon, authenticated;

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
  v_here text[];
  v_owner_last chat_private.messages;
  v_named text[];
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
  -- An agent standing by for every room listens here too. The smoke tests' verify-* rooms are left
  -- out, so a test run neither wakes real agents nor sees them.
  if p_room !~ '^verify-' then
    select coalesce(array_agg(distinct agent), '{}') into v_listening from (
      select unnest(v_listening) as agent
      union
      select sender from chat_private.standby
        where seen_at > now() - interval '90 seconds' and not sender = any(v_present)
    ) here;
  end if;
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
  -- A message from yeebyor is answered by everyone it is for: with no @agent that is every agent
  -- that is present or listening, with @agents it is each agent named (the draw picks who goes
  -- first, the others follow, so tagging two agents gets two answers, not one). Each answers once,
  -- in the order the draw gives, then the room goes quiet. Who still has to answer is read from
  -- the room itself (the agents with no message after yeebyor's), so nothing is stored. It holds
  -- for ten minutes, so an agent that never answers cannot hold the turn for good, and an @ in an
  -- agent's last message (a handoff) still comes first.
  select * into v_owner_last from chat_private.messages
    where room = p_room and sender = 'yeebyor' order by id desc limit 1;
  select coalesce(array_agg(agent), '{}') into v_named from unnest(v_agents) agent
    where v_owner_last.message ~* ('@' || agent || '\M');
  if v_owner_last.id is not null
    and v_owner_last.message !~* '^\s*conversation\s+over\s*[.!]*\s*$'
    and v_owner_last.created_at > now() - interval '10 minutes'
    and (v_last.id = v_owner_last.id or (v_last.sender <> 'yeebyor' and cardinality(v_called) = 0)) then
    select coalesce(array_agg(sender), '{}') into v_spoke from (
      select distinct sender from chat_private.messages where room = p_room and id > v_owner_last.id
    ) after_owner;
    select coalesce(array_agg(agent), '{}') into v_round from unnest(v_agents) agent
      where agent is distinct from v_last.sender
        and (agent = any(v_present) or agent = any(v_listening))
        and (cardinality(v_named) = 0 or agent = any(v_named))
        and not agent = any(v_spoke);
  end if;
  -- @mentions decide the pool, then an open round for yeebyor's message to everyone.
  -- Otherwise: agents present and not listening. Any two agents are enough for a room, so an agent
  -- that is not here never holds the turn over one that is: of several agents called, those here
  -- go first. One called alone keeps the turn, so it answers if it comes or was only busy.
  if cardinality(v_called) > 0 then
    v_pool := v_called;
    select coalesce(array_agg(agent), '{}') into v_here from unnest(v_called) agent
      where agent = any(v_present) or agent = any(v_listening);
    if cardinality(v_here) > 0 then
      v_pool := v_here;
    end if;
  elsif cardinality(v_round) > 0 then
    v_pool := v_round;
  else
    select coalesce(array_agg(agent), '{}') into v_pool from unnest(v_agents) agent
      where agent is distinct from v_last.sender and agent = any(v_present);
    -- The only agent present may continue, e.g. to call @yeebyor before leaving.
    if cardinality(v_pool) = 0 and v_last.sender = any(v_present) then
      v_pool := array[v_last.sender];
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
    -- Nobody here, or everyone else is listening: nobody speaks until someone is @mentioned or an
    -- agent joins with wait.
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

create or replace function chat_private.read_messages(p_token text, p_room text, p_limit integer, p_after bigint, p_before bigint,
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
    delete from chat_private.standby where sender = v_sender;
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

create or replace function chat_private.calls(p_token text, p_after bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sender text := chat_private.identify(p_token); v_after bigint; v_calls jsonb;
begin
  if v_sender = 'yeebyor' or p_after < 0 then
    raise sqlstate '22023' using message = 'Only agents stand by, from a valid message ID';
  end if;
  insert into chat_private.standby as s (sender, seen_at) values (v_sender, now())
    on conflict (sender) do update set seen_at = excluded.seen_at;
  v_after := coalesce(p_after, (select coalesce(max(id), 0) from chat_private.messages
    where created_at <= now() - interval '10 minutes'));
  select coalesce(jsonb_agg(jsonb_build_object('room', recent.room, 'last_id', recent.last_id::text) order by recent.last_id), '[]'::jsonb)
  into v_calls
  from (
    select room, max(id) as last_id from chat_private.messages
    where id > v_after and room !~ '^verify-' group by room
  ) recent
  -- An agent's own last message is not a call, even when it is the only agent present and may go on.
  where chat_private.compute_turn(recent.room)->>'next' = v_sender
    and (select m.sender from chat_private.messages m where m.id = recent.last_id) <> v_sender;
  return jsonb_build_object('after', v_after::text, 'calls', v_calls);
end;
$$;

create or replace function public.chat_calls(p_token text, p_after bigint default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.calls(p_token, p_after);
$$;
revoke execute on function chat_private.calls(text, bigint) from public, anon, authenticated;
revoke execute on function public.chat_calls(text, bigint) from public, anon, authenticated;
grant execute on function chat_private.calls(text, bigint) to anon, authenticated;
grant execute on function public.chat_calls(text, bigint) to anon, authenticated;
