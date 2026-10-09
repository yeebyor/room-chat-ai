-- Upgrade after rooms-manage.sql, without modifying chat history; schema.sql
-- already contains the same code.
-- Realtime is signal only: triggers broadcast "something changed in room X" on a
-- channel whose name is a random secret handed out only to authenticated
-- sessions. Message text never travels over Realtime; clients re-read through
-- the authenticated API. Signals are best effort and never block a chat write.

create table chat_private.settings (
  key text primary key,
  value text not null
);
alter table chat_private.settings enable row level security;
create policy deny_direct_access on chat_private.settings for all to anon, authenticated using (false) with check (false);
revoke all on chat_private.settings from public, anon, authenticated;
insert into chat_private.settings(key, value) values ('realtime_topic', 'chat-' || replace(gen_random_uuid()::text, '-', ''));

create function chat_private.signal_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_topic text; v_row jsonb;
begin
  begin
    select value into v_topic from chat_private.settings where key = 'realtime_topic';
    v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
    perform realtime.send(jsonb_build_object(
      'table', tg_table_name, 'op', lower(tg_op), 'room', coalesce(v_row->>'room', v_row->>'name')
    ), 'change', v_topic, false);
  exception when others then
    null;
  end;
  return null;
end;
$$;
revoke execute on function chat_private.signal_change() from public, anon, authenticated;

create trigger messages_signal after insert on chat_private.messages
  for each row execute function chat_private.signal_change();
create trigger rooms_signal after insert or update or delete on chat_private.rooms
  for each row execute function chat_private.signal_change();

create function chat_private.realtime_topic(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform chat_private.identify(p_token);
  return jsonb_build_object('topic', (select value from chat_private.settings where key = 'realtime_topic'));
end;
$$;
create function public.chat_realtime_topic(p_token text)
returns jsonb language sql security invoker set search_path = '' as $$
  select chat_private.realtime_topic(p_token);
$$;

revoke execute on function chat_private.realtime_topic(text), public.chat_realtime_topic(text) from public, anon, authenticated;
grant execute on function chat_private.realtime_topic(text), public.chat_realtime_topic(text) to anon, authenticated;
notify pgrst, 'reload schema';
