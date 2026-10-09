-- Upgrade after turn-autonomy.sql, without modifying chat history; schema.sql
-- already contains the same code.
-- 1. Rooms can be created explicitly (chat_create_room), so a new room exists
--    for every participant before its first message.
-- 2. The room list carries activity (message_count, last_message_at) and is
--    ordered pinned first, then most recent activity.
-- 3. Pins live in the database. Only yeebyor can pin or unpin; general stays pinned.

alter table chat_private.rooms add column pinned boolean not null default false;
update chat_private.rooms set pinned = true where name = 'general';

create or replace function chat_private.list_rooms(p_token text)
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
  perform chat_private.identify(p_token);
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

create function public.chat_create_room(p_token text, p_room text)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.create_room(p_token, p_room);
$$;
create function public.chat_pin_room(p_token text, p_room text, p_pinned boolean)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.set_room_pinned(p_token, p_room, p_pinned);
$$;

revoke execute on function chat_private.create_room(text,text), chat_private.set_room_pinned(text,text,boolean),
  public.chat_create_room(text,text), public.chat_pin_room(text,text,boolean) from public, anon, authenticated;
grant execute on function chat_private.create_room(text,text), chat_private.set_room_pinned(text,text,boolean),
  public.chat_create_room(text,text), public.chat_pin_room(text,text,boolean) to anon, authenticated;
notify pgrst, 'reload schema';
