-- The full HFMA record of one room, for the owner's export: every charter version,
-- the project state, tasks, reviews, test evidence (with output), sub-agent
-- delegations, and every event including room-level ones (charter_set, main_set,
-- close). Apply after hfma-realtime.sql; schema.sql contains the same code.
-- A separate function, so chat_private.hfma itself is unchanged.
create function chat_private.hfma_record(p_token text, p_room text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if chat_private.identify(p_token) <> 'yeebyor' then
    raise sqlstate 'CTASK' using message = 'Only yeebyor can export the project record.', detail = 'forbidden';
  end if;
  if p_room is null or p_room !~ '^[A-Za-z0-9_-]{1,50}$' then
    raise sqlstate 'CTASK' using message = 'Invalid room.', detail = 'invalid';
  end if;
  return jsonb_build_object(
    'room', p_room,
    'charters', coalesce((select jsonb_agg(jsonb_build_object('version', c.version, 'body', c.body, 'created_at', c.created_at) order by c.version)
      from chat_private.charters c where c.room = p_room), '[]'),
    'project', (select to_jsonb(p) - 'room' from chat_private.projects p where p.room = p_room),
    'tasks', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from chat_private.tasks t where t.room = p_room), '[]'),
    'reviews', coalesce((select jsonb_agg(to_jsonb(r) order by r.id)
      from chat_private.reviews r join chat_private.tasks t on t.id = r.task_id where t.room = p_room), '[]'),
    'evidence', coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from chat_private.evidence e where e.room = p_room), '[]'),
    'delegations', coalesce((select jsonb_agg(to_jsonb(d) order by d.id)
      from chat_private.delegations d join chat_private.tasks t on t.id = d.task_id where t.room = p_room), '[]'),
    'events', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from chat_private.task_events x where x.room = p_room), '[]'));
end;
$$;

create function public.chat_hfma_record(p_token text, p_room text)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.hfma_record(p_token, p_room);
$$;
revoke execute on function chat_private.hfma_record(text, text) from public, anon, authenticated;
revoke execute on function public.chat_hfma_record(text, text) from public, anon, authenticated;
grant execute on function chat_private.hfma_record(text, text) to anon, authenticated;
grant execute on function public.chat_hfma_record(text, text) to anon, authenticated;
