-- Hand-offs in a project room.
--
-- In a room with a charter, an agent that calls another agent with @name may send that message
-- without holding the turn (not while yeebyor was just called, and the last-seen check still
-- applies). Before, an agent that worked for minutes after its last message could not call the
-- reviewer or the orchestrator ("No agent has the turn yet": its own message was the last one
-- and the others were listening), and only a message from yeebyor could unblock it.
-- Rooms without a charter behave as before.

create or replace function chat_private.send_message(p_token text, p_room text, p_message text, p_client_id uuid,
  p_last_seen bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sender text; v_row chat_private.messages; v_text text := btrim(p_message); v_turn jsonb;
  v_latest bigint; v_handoff boolean;
begin
  v_sender := chat_private.identify(p_token);
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' or p_client_id is null
    or v_text is null or char_length(v_text) not between 1 and 4000 or p_last_seen < 0 then
    raise sqlstate '22023' using message = 'Invalid room or message';
  end if;
  -- Only yeebyor's messages may create a room; agents get "not found" for a
  -- room that does not exist, e.g. one deleted while they were working.
  if v_sender = 'yeebyor' then
    insert into chat_private.rooms(name) values (p_room) on conflict do nothing;
  end if;
  -- Serialize writers in a room BEFORE allocating IDs. Incremental readers
  -- cannot skip a lower ID committed after a higher one in the same room.
  perform 1 from chat_private.rooms where name = p_room for update;
  if not found then
    raise sqlstate 'P0002' using message = 'Room not found';
  end if;
  select * into v_row from chat_private.messages
    where room = p_room and sender = v_sender and client_id = p_client_id;
  if found then
    if v_row.message <> v_text then
      raise sqlstate '23505' using message = 'Request ID already used for different text';
    end if;
  else
    -- yeebyor may always speak. Agents must reply to the latest message and
    -- need the turn, checked under the room lock; after 120 seconds of
    -- silence any agent except the last speaker may, and the last speaker too
    -- when no other agent is present (an @mention of an absent agent would
    -- otherwise hold the room forever).
    if v_sender <> 'yeebyor' then
      if p_last_seen is null then
        raise sqlstate 'CTURN' using message = 'Agents must send the last message ID they read', detail = 'last_seen';
      end if;
      -- last_seen must be exactly the latest message ID (0 for an empty room):
      -- lower means newer messages arrived, higher is not a message they read.
      select max(id) into v_latest from chat_private.messages where room = p_room;
      if p_last_seen > coalesce(v_latest, 0) then
        raise sqlstate 'CTURN' using message = 'Last seen ID is not the latest message', detail = 'last_seen';
      end if;
      if p_last_seen < coalesce(v_latest, 0) then
        raise sqlstate 'CTURN' using message = 'New messages since last read', detail = 'stale';
      end if;
      v_turn := chat_private.compute_turn(p_room);
      if (v_turn->>'stopped')::boolean then
        raise sqlstate 'CTURN' using message = 'Conversation stopped by yeebyor', detail = 'stopped';
      end if;
      -- Hand-off in a project room (a room with a charter): an agent that calls another agent
      -- with @name may speak without the turn, unless yeebyor was just called. Otherwise an
      -- agent that worked for minutes after its last message could never call the reviewer or
      -- the orchestrator: its own message is the last one and the others are listening.
      v_handoff := v_turn->>'owner_called_until' is null
        and exists (select 1 from chat_private.charters where room = p_room)
        and exists (select 1 from unnest(array['Claude', 'GPT', 'Gemini']) agent
          where agent <> v_sender and v_text ~* ('@' || agent || '\M'));
      if not v_handoff and v_turn->>'next' is distinct from v_sender and not (
        v_turn->>'open_at' is not null and now() >= (v_turn->>'open_at')::timestamptz
        and (v_sender is distinct from v_turn->>'last_sender'
          or not exists (select 1 from jsonb_array_elements_text(v_turn->'present') p where p <> v_sender))
      ) then
        raise sqlstate 'CTURN' using message = 'Not your turn',
          detail = case when v_turn->>'owner_called_until' is not null then 'owner'
                        else coalesce(v_turn->>'next', 'none') end;
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
