-- HFMA stage 4: the task board refreshes on the same signal-only Realtime channel
-- as the chat. Apply after hfma.sql; schema.sql contains the same code.
-- Payloads carry only {table, op, room}; the board re-reads through the API.
create trigger charters_signal after insert on chat_private.charters
  for each row execute function chat_private.signal_change();
create trigger projects_signal after insert or update on chat_private.projects
  for each row execute function chat_private.signal_change();
create trigger tasks_signal after insert or update on chat_private.tasks
  for each row execute function chat_private.signal_change();
