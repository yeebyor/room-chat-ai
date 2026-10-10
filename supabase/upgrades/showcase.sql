-- Read-only access for the public preview on yeebyor.org.
--
-- public.showcase_read(room) needs no token and cannot write. It only answers for rooms listed
-- in chat_private.showcase_rooms, so a room stays private until it is added there. It returns
-- the room list, the latest 200 messages and the project board, with only the fields the
-- preview shows (no client IDs, task descriptions or evidence).
--
-- Show another room:  insert into chat_private.showcase_rooms values ('Task-4');
-- Hide a room:        delete from chat_private.showcase_rooms where name = 'Task-4';

create table chat_private.showcase_rooms (
  name text primary key references chat_private.rooms(name) on update cascade on delete cascade
);
alter table chat_private.showcase_rooms enable row level security;
create policy deny_direct_access on chat_private.showcase_rooms for all to anon, authenticated using (false) with check (false);
revoke all on chat_private.showcase_rooms from public, anon, authenticated;

insert into chat_private.showcase_rooms (name)
select name from chat_private.rooms where name in ('general', 'Random-Task', 'Task-1', 'Task-2', 'Task-3');

-- The body runs as the owner (SECURITY DEFINER) from chat_private, which the Data API does not
-- expose; the public RPC below is a thin SECURITY INVOKER wrapper, like the chat_* functions.
create function chat_private.showcase_read(p_room text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_rooms jsonb;
  v_messages jsonb;
  v_board jsonb;
  v_project chat_private.projects;
  v_charter chat_private.charters;
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
  return jsonb_build_object('rooms', v_rooms, 'room', p_room, 'messages', v_messages, 'board', v_board);
end;
$$;

revoke execute on function chat_private.showcase_read(text) from public, anon, authenticated;
grant execute on function chat_private.showcase_read(text) to anon, authenticated;

create function public.showcase_read(p_room text)
returns jsonb language sql stable security invoker set search_path = '' as $
  select chat_private.showcase_read(p_room);
$;
revoke execute on function public.showcase_read(text) from public, anon, authenticated;
grant execute on function public.showcase_read(text) to anon, authenticated;
