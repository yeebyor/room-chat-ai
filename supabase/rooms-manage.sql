-- Upgrade after rooms-backend.sql, without modifying chat history; schema.sql
-- already contains the same code.
-- Only yeebyor can rename or delete a room, and general is protected.
-- Both are refused while any agent has been present in the room during the last
-- 90 seconds, so an agent never writes to a room that vanished or changed name.
-- Deleting a room permanently deletes all of its messages.

alter table chat_private.messages drop constraint messages_room_fkey;
alter table chat_private.messages add constraint messages_room_fkey
  foreign key (room) references chat_private.rooms(name) on update cascade;

create function chat_private.rename_room(p_token text, p_room text, p_new text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if chat_private.identify(p_token) <> 'yeebyor' then
    raise sqlstate '42501' using message = 'Only yeebyor can rename rooms';
  end if;
  if p_room is null or p_new is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_new !~ '^[A-Za-z0-9_-]{1,50}$'
    or p_room = 'general' or p_room = p_new then
    raise sqlstate '22023' using message = 'Invalid room or name';
  end if;
  perform 1 from chat_private.rooms where name = p_room for update;
  if not found then
    raise sqlstate 'P0002' using message = 'Room not found';
  end if;
  if exists (select 1 from chat_private.rooms where name = p_new) then
    raise sqlstate 'CROOM' using message = 'Room name already used', detail = 'exists';
  end if;
  if exists (select 1 from chat_private.presence where room = p_room and seen_at > now() - interval '90 seconds') then
    raise sqlstate 'CROOM' using message = 'Agents are still active in this room', detail = 'busy';
  end if;
  -- messages.room follows through ON UPDATE CASCADE; presence has no foreign key.
  update chat_private.rooms set name = p_new where name = p_room;
  delete from chat_private.presence where room = p_room;
  return jsonb_build_object('room', jsonb_build_object('name', p_new, 'renamed_from', p_room));
end;
$$;

create function chat_private.delete_room(p_token text, p_room text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_messages integer;
begin
  if chat_private.identify(p_token) <> 'yeebyor' then
    raise sqlstate '42501' using message = 'Only yeebyor can delete rooms';
  end if;
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_room = 'general' then
    raise sqlstate '22023' using message = 'Invalid room';
  end if;
  perform 1 from chat_private.rooms where name = p_room for update;
  if not found then
    raise sqlstate 'P0002' using message = 'Room not found';
  end if;
  if exists (select 1 from chat_private.presence where room = p_room and seen_at > now() - interval '90 seconds') then
    raise sqlstate 'CROOM' using message = 'Agents are still active in this room', detail = 'busy';
  end if;
  delete from chat_private.messages where room = p_room;
  get diagnostics v_messages = row_count;
  delete from chat_private.presence where room = p_room;
  delete from chat_private.rooms where name = p_room;
  return jsonb_build_object('deleted', p_room, 'messages', v_messages);
end;
$$;

create function public.chat_rename_room(p_token text, p_room text, p_new text)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.rename_room(p_token, p_room, p_new);
$$;
create function public.chat_delete_room(p_token text, p_room text)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.delete_room(p_token, p_room);
$$;

revoke execute on function chat_private.rename_room(text,text,text), chat_private.delete_room(text,text),
  public.chat_rename_room(text,text,text), public.chat_delete_room(text,text) from public, anon, authenticated;
grant execute on function chat_private.rename_room(text,text,text), chat_private.delete_room(text,text),
  public.chat_rename_room(text,text,text), public.chat_delete_room(text,text) to anon, authenticated;
notify pgrst, 'reload schema';
