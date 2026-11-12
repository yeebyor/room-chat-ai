-- The yeebyor.org preview shows the agents of a room: who is in it or standing by, and how many
-- messages and finished tasks each has there. Generated from schema.sql.

create or replace function chat_private.showcase_read(p_room text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_rooms jsonb;
  v_messages jsonb;
  v_board jsonb;
  v_project chat_private.projects;
  v_charter chat_private.charters;
  v_turn jsonb;
begin
  if p_room is null or not exists (select 1 from chat_private.showcase_rooms where name = p_room) then
    raise sqlstate 'P0002' using message = 'Room not found';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', r.name, 'pinned', r.pinned, 'last_message_at', s.last_message_at)
    order by r.pinned desc, coalesce(s.last_message_at, r.created_at) desc, r.name), '[]'::jsonb)
  into v_rooms
  from chat_private.rooms r
  join chat_private.showcase_rooms w on w.name = r.name
  cross join lateral (select max(m.created_at) as last_message_at from chat_private.messages m where m.room = r.name) s;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id::text, 'sender', m.sender, 'message', m.message,
    'created_at', m.created_at) order by m.id), '[]'::jsonb)
  into v_messages
  from (select * from chat_private.messages where room = p_room order by id desc limit 200) m;
  select * into v_project from chat_private.projects where room = p_room;
  select * into v_charter from chat_private.charters where room = p_room order by version desc limit 1;
  v_board := jsonb_build_object(
    'room', p_room,
    'charter_version', v_charter.version,
    'project', jsonb_build_object('main_hash', v_project.main_hash, 'inconsistent', v_project.inconsistent,
      'closed_at', v_project.closed_at),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'title', t.title, 'team', t.team, 'status', t.status, 'generation', t.generation,
        'depends_on', t.depends_on, 'candidate', t.candidate, 'approved_hash', t.approved_hash,
        'merge_hash', t.merge_hash, 'block_reason', t.block_reason, 'exception', t.exception,
        'stale', t.status = 'CLAIMED' and t.heartbeat_at < now() - interval '30 minutes') order by t.id)
      from chat_private.tasks t where t.room = p_room), '[]'::jsonb),
    'decisions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'key', d.key, 'title', d.title, 'body', d.body, 'actor', d.actor, 'status', d.status,
        'resolved_by', d.resolved_by, 'resolution', d.resolution) order by d.id)
      from chat_private.decisions d where d.room = p_room), '[]'::jsonb));
  if v_charter.version is not null then
    v_board := v_board || jsonb_build_object('orchestrator', v_charter.body->>'orchestrator',
      'agents', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(v_charter.body->'ownership') as k));
  end if;
  v_turn := chat_private.compute_turn(p_room);
  return jsonb_build_object('rooms', v_rooms, 'room', p_room, 'messages', v_messages, 'board', v_board,
    'agents', jsonb_build_object(
      'present', coalesce(v_turn->'present', '[]'::jsonb),
      'listening', coalesce(v_turn->'listening', '[]'::jsonb),
      'messages', coalesce((select jsonb_object_agg(x.sender, x.n) from (select sender, count(*) as n
        from chat_private.messages where room = p_room and sender <> 'yeebyor' group by sender) x), '{}'::jsonb),
      'tasks_done', coalesce((select jsonb_object_agg(y.team, y.n) from (select team, count(*) as n
        from chat_private.tasks where room = p_room and status = 'DONE' group by team) y), '{}'::jsonb)));
end;
$$;
