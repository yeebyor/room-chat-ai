-- Upgrade existing installations without modifying any chat history.
alter table chat_private.credentials drop constraint credentials_sender_check;
alter table chat_private.credentials add constraint credentials_sender_check
  check (sender in ('yeebyor', 'Claude', 'GPT', 'Gemini'));
alter table chat_private.messages drop constraint messages_sender_check;
alter table chat_private.messages add constraint messages_sender_check
  check (sender in ('yeebyor', 'Claude', 'GPT', 'Gemini'));
