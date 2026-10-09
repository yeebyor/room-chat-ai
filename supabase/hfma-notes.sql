-- After a 120-second silence the last speaker may speak again when no other agent is
-- present (an @mention of an absent agent no longer holds the room forever); task_note
-- for review findings outside a reject; main_report flags a dirty project folder.
-- Generated from schema.sql.

create or replace function chat_private.send_message(p_token text, p_room text, p_message text, p_client_id uuid,
  p_last_seen bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sender text; v_row chat_private.messages; v_text text := btrim(p_message); v_turn jsonb;
  v_latest bigint;
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
      if v_turn->>'next' is distinct from v_sender and not (
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

create or replace function chat_private.hfma(p_token text, p_op text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sender text := chat_private.identify(p_token);
  v_room text;
  v_task chat_private.tasks;
  v_charter chat_private.charters;
  v_project chat_private.projects;
  v_id bigint;
  v_commit text;
  v_reason text;
  v_status text;
  v_item jsonb;
  v_ok text[];
  v_key text;
  v_decision chat_private.decisions;
  v_other chat_private.decisions;
begin
  if jsonb_typeof(p_args) is distinct from 'object' then
    perform chat_private.hfma_fail('invalid', 'args must be a JSON object.');
  end if;
  case p_op

  when 'charter_set' then
    perform chat_private.hfma_owner(v_sender);
    v_room := chat_private.hfma_room(p_args);
    perform chat_private.hfma_open(v_room);
    perform chat_private.hfma_check_charter(p_args->'charter');
    insert into chat_private.charters(room, version, body)
      values (v_room, coalesce((select max(version) from chat_private.charters where room = v_room), 0) + 1, p_args->'charter')
      returning * into v_charter;
    insert into chat_private.projects(room) values (v_room) on conflict do nothing;
    perform chat_private.hfma_event(v_room, null, v_sender, 'charter_set');
    return jsonb_build_object('room', v_room, 'version', v_charter.version);

  when 'charter_get' then
    v_room := chat_private.hfma_room(p_args);
    v_charter := chat_private.hfma_charter(v_room);
    select * into v_project from chat_private.projects where room = v_room;
    return jsonb_build_object('room', v_room, 'version', v_charter.version, 'charter', v_charter.body,
      'created_at', v_charter.created_at, 'project', to_jsonb(v_project) - 'room');

  -- The CLI records the initial main hash (owner) and later reports what it sees.
  when 'main_set' then
    perform chat_private.hfma_owner(v_sender);
    v_room := chat_private.hfma_room(p_args);
    perform chat_private.hfma_charter(v_room);
    v_commit := chat_private.hfma_hash(p_args, 'main_hash');
    v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
    update chat_private.projects set main_hash = v_commit, inconsistent = false where room = v_room;
    perform chat_private.hfma_event(v_room, null, v_sender, 'main_set', null, v_commit, null, v_reason);
    return jsonb_build_object('room', v_room, 'main_hash', v_commit);

  when 'main_report' then
    v_room := chat_private.hfma_room(p_args);
    v_commit := chat_private.hfma_hash(p_args, 'main_hash');
    select * into v_project from chat_private.projects where room = v_room for update;
    if v_project.main_hash is null then
      perform chat_private.hfma_fail('missing', 'yeebyor has not recorded the initial main hash yet (hfma.mjs setup).');
    end if;
    -- "dirty" lists tracked files changed or staged in the project folder itself,
    -- which only integrate may touch.
    v_reason := case when p_args ? 'dirty' then chat_private.hfma_text(p_args, 'dirty', 2000) end;
    if (v_project.main_hash <> v_commit or v_reason is not null) and not v_project.inconsistent then
      update chat_private.projects set inconsistent = true where room = v_room;
      perform chat_private.hfma_event(v_room, null, v_sender, 'main_inconsistent', null, v_commit, null,
        case when v_project.main_hash <> v_commit then format('main recorded as %s, found %s', v_project.main_hash, v_commit)
          else 'Uncommitted changes in the project folder: ' || v_reason end);
    end if;
    return jsonb_build_object('room', v_room, 'consistent', v_project.main_hash = v_commit and v_reason is null,
      'main_hash', v_project.main_hash);

  when 'task_create' then
    v_room := chat_private.hfma_room(p_args);
    perform chat_private.hfma_manager(v_room, v_sender);
    perform chat_private.hfma_open(v_room);
    if coalesce(p_args->>'team', '') not in ('Claude', 'GPT', 'Gemini') then
      perform chat_private.hfma_fail('invalid', 'team must be one of Claude, GPT or Gemini.');
    end if;
    if p_args ? 'depends_on' and (jsonb_typeof(p_args->'depends_on') <> 'array'
      or exists (select 1 from jsonb_array_elements_text(p_args->'depends_on') d where d !~ '^[1-9][0-9]{0,17}$'
        or not exists (select 1 from chat_private.tasks t where t.id = d::bigint and t.room = v_room))) then
      perform chat_private.hfma_fail('invalid', 'depends_on must be a list of IDs of tasks that already exist in this room.');
    end if;
    insert into chat_private.tasks(room, title, description, team, depends_on, created_by)
      values (v_room, chat_private.hfma_text(p_args, 'title', 200),
        case when p_args ? 'description' then chat_private.hfma_text(p_args, 'description', 8000) else '' end,
        p_args->>'team',
        coalesce((select array_agg(distinct d::bigint) from jsonb_array_elements_text(p_args->'depends_on') d), '{}'),
        v_sender)
      returning id into v_id;
    perform chat_private.hfma_event(v_room, v_id, v_sender, 'create');
    return chat_private.hfma_task_json(v_id);

  when 'task_claim' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    if v_sender <> v_task.team then
      perform chat_private.hfma_fail('forbidden', format('Only team %s may claim this task.', v_task.team));
    end if;
    if v_task.status <> 'TODO' then
      perform chat_private.hfma_fail('status', format('The task status is %s, not TODO.', v_task.status));
    end if;
    if exists (select 1 from chat_private.tasks where id = any(v_task.depends_on) and status <> 'DONE') then
      perform chat_private.hfma_fail('status', 'Some dependencies are not DONE yet.');
    end if;
    update chat_private.tasks set status = 'CLAIMED', generation = generation + 1, heartbeat_at = now(),
      claim_version = (chat_private.hfma_charter(v_task.room)).version
      where id = v_task.id;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'claim', v_task.generation + 1);
    return chat_private.hfma_task_json(v_task.id);

  when 'task_heartbeat' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_holder(v_task, v_sender, p_args);
    if v_task.status <> 'CLAIMED' then
      perform chat_private.hfma_fail('status', format('The task status is %s, not CLAIMED.', v_task.status));
    end if;
    update chat_private.tasks set heartbeat_at = now() where id = v_task.id;
    return chat_private.hfma_task_json(v_task.id);

  -- Raw test results from scripts/hfma.mjs. Agents never write these by hand.
  when 'evidence_add' then
    v_room := chat_private.hfma_room(p_args);
    v_charter := chat_private.hfma_charter(v_room);
    v_status := coalesce(p_args->>'kind', '');
    if v_status not in ('submit', 'verify', 'integrate', 'close') then
      perform chat_private.hfma_fail('invalid', 'kind must be submit, verify, integrate or close.');
    end if;
    if v_status = 'close' then
      perform chat_private.hfma_owner(v_sender);
      perform chat_private.hfma_text(p_args, 'criterion', 20);
    else
      v_task := chat_private.hfma_task(p_args);
      if v_task.room <> v_room then
        perform chat_private.hfma_fail('invalid', 'That task does not belong to this room.');
      end if;
    end if;
    -- exit_code is null when the command could not start or was killed.
    if not (p_args ? 'exit_code') or (jsonb_typeof(p_args->'exit_code') <> 'null' and coalesce(p_args->>'exit_code', '') !~ '^-?[0-9]{1,9}$')
      or coalesce(jsonb_typeof(p_args->'timed_out'), '') <> 'boolean'
      or coalesce(p_args->>'duration_ms', '') !~ '^[0-9]{1,9}$'
      or coalesce(jsonb_typeof(p_args->'output'), '') <> 'string' or char_length(p_args->>'output') > 16000
      or (p_args ? 'env' and jsonb_typeof(p_args->'env') <> 'object') then
      perform chat_private.hfma_fail('invalid', 'Evidence must include exit_code, timed_out, duration_ms and output (at most 16000 characters).');
    end if;
    insert into chat_private.evidence(room, task_id, kind, criterion, commit, charter_version, command,
      exit_code, timed_out, duration_ms, output, env, actor)
    values (v_room, v_task.id, v_status, p_args->>'criterion', chat_private.hfma_hash(p_args, 'commit'), v_charter.version,
      chat_private.hfma_text(p_args, 'command', 500), (p_args->>'exit_code')::integer, (p_args->>'timed_out')::boolean,
      (p_args->>'duration_ms')::integer, p_args->>'output', coalesce(p_args->'env', '{}'), v_sender)
    returning id into v_id;
    perform chat_private.hfma_event(v_room, v_task.id, v_sender, 'evidence_' || v_status, v_task.generation,
      p_args->>'commit', v_id, case when (p_args->>'exit_code') = '0' and not (p_args->>'timed_out')::boolean then 'passed' else 'failed' end);
    return jsonb_build_object('evidence', v_id, 'passed', (p_args->>'exit_code') = '0' and not (p_args->>'timed_out')::boolean);

  when 'task_submit' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    perform chat_private.hfma_holder(v_task, v_sender, p_args);
    if v_task.status <> 'CLAIMED' then
      perform chat_private.hfma_fail('status', format('The task status is %s, not CLAIMED.', v_task.status));
    end if;
    v_commit := chat_private.hfma_hash(p_args, 'commit');
    perform chat_private.hfma_passing(chat_private.hfma_id(p_args, 'evidence'), v_task.id, 'submit', v_sender, v_commit);
    if exists (select 1 from chat_private.delegations where task_id = v_task.id and status = 'open') then
      perform chat_private.hfma_fail('delegation', 'A sub-agent delegation is still open. Close it first with hfma.mjs child.');
    end if;
    update chat_private.tasks set status = 'REVIEW', candidate = v_commit, heartbeat_at = now() where id = v_task.id;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'submit', v_task.generation, v_commit,
      (p_args->>'evidence')::bigint);
    return chat_private.hfma_task_json(v_task.id);

  when 'task_review' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    if v_sender = v_task.team then
      perform chat_private.hfma_fail('forbidden', 'The authoring team may not review its own task.');
    end if;
    if v_task.status <> 'REVIEW' then
      perform chat_private.hfma_fail('status', format('The task status is %s, not REVIEW.', v_task.status));
    end if;
    v_commit := chat_private.hfma_hash(p_args, 'commit');
    if v_commit <> v_task.candidate then
      perform chat_private.hfma_fail('commit', format('The candidate under review is %s.', v_task.candidate));
    end if;
    v_status := coalesce(p_args->>'verdict', '');
    if v_status not in ('approve', 'reject') then
      perform chat_private.hfma_fail('invalid', 'verdict must be approve or reject.');
    end if;
    if v_status = 'approve' then
      perform chat_private.hfma_passing(chat_private.hfma_id(p_args, 'evidence'), v_task.id, 'verify', v_sender, v_commit);
    end if;
    insert into chat_private.reviews(task_id, reviewer, verdict, commit, charter_version, notes, evidence_id)
      values (v_task.id, v_sender, v_status, v_commit, (chat_private.hfma_charter(v_task.room)).version,
        chat_private.hfma_text(p_args, 'notes', 8000),
        case when v_status = 'approve' then (p_args->>'evidence')::bigint end);
    if v_status = 'approve' then
      update chat_private.tasks set status = 'APPROVED', approved_hash = v_commit where id = v_task.id;
    else
      update chat_private.tasks set status = 'CLAIMED', candidate = null, rejections = rejections + 1,
        heartbeat_at = now() where id = v_task.id returning * into v_task;
    end if;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, v_status, v_task.generation, v_commit,
      case when v_status = 'approve' then (p_args->>'evidence')::bigint end);
    if v_status = 'reject' and v_task.rejections >= 3 then
      perform chat_private.hfma_block(v_task, 'substrate', 'Rejected 3 times; waiting for a decision by yeebyor.');
    end if;
    return chat_private.hfma_task_json(v_task.id);

  -- Called by hfma.mjs integrate with what happened. "merged" records the new
  -- main hash BEFORE the CLI moves the branch.
  when 'task_integrate' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room, true);
    if v_sender not in (v_task.team, 'yeebyor') then
      perform chat_private.hfma_manager(v_task.room, v_sender);
    end if;
    if v_task.status <> 'APPROVED' then
      perform chat_private.hfma_fail('status', format('The task status is %s, not APPROVED.', v_task.status));
    end if;
    if chat_private.hfma_hash(p_args, 'commit') <> v_task.approved_hash then
      perform chat_private.hfma_fail('commit', format('The approved hash is %s.', v_task.approved_hash));
    end if;
    v_status := coalesce(p_args->>'outcome', '');
    if v_status = 'merged' then
      v_commit := chat_private.hfma_hash(p_args, 'merge_hash');
      perform chat_private.hfma_passing(chat_private.hfma_id(p_args, 'evidence'), v_task.id, 'integrate', v_sender, v_commit);
      if not v_task.exception and coalesce(p_args->>'ownership_ok', '') <> 'true' then
        perform chat_private.hfma_fail('invalid', 'merged must include ownership_ok true from the file path check.');
      end if;
      update chat_private.tasks set status = 'DONE', merge_hash = v_commit, integrate_failures = 0 where id = v_task.id;
      update chat_private.projects set main_hash = v_commit where room = v_task.room;
      perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'integrate', v_task.generation, v_commit,
        (p_args->>'evidence')::bigint);
    elsif v_status = 'moved' then
      update chat_private.tasks set status = 'CLAIMED', candidate = null, approved_hash = null, heartbeat_at = now()
        where id = v_task.id;
      perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'integrate_moved', v_task.generation,
        v_task.approved_hash, null, 'The team branch moved after approval; submit again.');
    elsif v_status = 'ownership' then
      v_reason := 'Files outside the team paths: ' || chat_private.hfma_text(p_args, 'files', 4000);
      perform chat_private.hfma_block(v_task, v_sender, v_reason);
    elsif v_status = 'failed' then
      v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
      v_commit := v_task.approved_hash;
      update chat_private.tasks set status = 'CLAIMED', candidate = null, approved_hash = null, heartbeat_at = now(),
        integrate_failures = integrate_failures + 1 where id = v_task.id returning * into v_task;
      perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'integrate_failed', v_task.generation,
        v_commit, case when p_args ? 'evidence' then chat_private.hfma_id(p_args, 'evidence') end, v_reason);
      if v_task.integrate_failures >= 2 then
        perform chat_private.hfma_block(v_task, 'substrate', 'Integration failed 2 times in a row; waiting for a decision by yeebyor.');
      end if;
    else
      perform chat_private.hfma_fail('invalid', 'outcome must be merged, moved, ownership or failed.');
    end if;
    return chat_private.hfma_task_json(v_task.id);

  when 'task_cancel', 'task_reassign' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    perform chat_private.hfma_manager(v_task.room, v_sender);
    v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
    if v_task.status in ('DONE', 'CANCELLED') then
      perform chat_private.hfma_fail('status', format('The task status is %s.', v_task.status));
    end if;
    if p_op = 'task_reassign' and p_args ? 'team' and coalesce(p_args->>'team', '') not in ('Claude', 'GPT', 'Gemini') then
      perform chat_private.hfma_fail('invalid', 'team must be one of Claude, GPT or Gemini.');
    end if;
    update chat_private.delegations set status = 'cancelled', closed_at = now() where task_id = v_task.id and status = 'open';
    if p_op = 'task_cancel' then
      update chat_private.tasks set status = 'CANCELLED' where id = v_task.id;
    else
      -- A new generation makes every operation of the previous holder stale.
      update chat_private.tasks set status = 'TODO', team = coalesce(p_args->>'team', team), generation = generation + 1,
        heartbeat_at = null, candidate = null, approved_hash = null, blocked_from = null, block_reason = null,
        rejections = 0, integrate_failures = 0 where id = v_task.id;
    end if;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, replace(p_op, 'task_', ''),
      v_task.generation + (p_op = 'task_reassign')::integer, null, null, v_reason);
    return chat_private.hfma_task_json(v_task.id);

  when 'task_block' then
    perform chat_private.hfma_owner(v_sender);
    v_task := chat_private.hfma_task(p_args);
    if v_task.status not in ('TODO', 'CLAIMED', 'REVIEW', 'APPROVED') then
      perform chat_private.hfma_fail('status', format('A task with status %s cannot be blocked.', v_task.status));
    end if;
    perform chat_private.hfma_block(v_task, v_sender, chat_private.hfma_text(p_args, 'reason', 2000));
    return chat_private.hfma_task_json(v_task.id);

  -- unblock returns the task where it was; exception also lets files outside the
  -- team's paths through integrate for this one task.
  when 'task_unblock', 'task_exception' then
    perform chat_private.hfma_owner(v_sender);
    v_task := chat_private.hfma_task(p_args);
    v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
    if p_op = 'task_unblock' and v_task.status <> 'BLOCKED' then
      perform chat_private.hfma_fail('status', format('The task status is %s, not BLOCKED.', v_task.status));
    end if;
    update chat_private.tasks set exception = exception or p_op = 'task_exception',
      status = case when status = 'BLOCKED' then blocked_from else status end,
      blocked_from = null, block_reason = null, rejections = 0, integrate_failures = 0
      where id = v_task.id;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, replace(p_op, 'task_', ''), v_task.generation,
      null, null, v_reason);
    return chat_private.hfma_task_json(v_task.id);

  -- A review finding that does not fit a reject, e.g. a second reviewer whose task was
  -- already returned. next shows these notes to the team holding the task.
  when 'task_note' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    if v_sender <> 'yeebyor' and not ((chat_private.hfma_charter(v_task.room)).body->'ownership') ? v_sender then
      perform chat_private.hfma_fail('forbidden', 'Only agents in this project or yeebyor can add notes.');
    end if;
    if v_task.status in ('DONE', 'CANCELLED') then
      perform chat_private.hfma_fail('status', format('The task status is %s; notes are for open tasks.', v_task.status));
    end if;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'note', v_task.generation, v_task.candidate, null,
      chat_private.hfma_text(p_args, 'note', 8000));
    return chat_private.hfma_task_json(v_task.id);

  when 'delegate' then
    v_task := chat_private.hfma_task(p_args);
    perform chat_private.hfma_open(v_task.room);
    perform chat_private.hfma_holder(v_task, v_sender, p_args);
    if v_task.status <> 'CLAIMED' then
      perform chat_private.hfma_fail('status', format('The task status is %s, not CLAIMED.', v_task.status));
    end if;
    insert into chat_private.delegations(task_id, leader, generation, label, contract)
      values (v_task.id, v_sender, v_task.generation, chat_private.hfma_text(p_args, 'label', 80),
        chat_private.hfma_text(p_args, 'contract', 16000))
      returning id into v_id;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'delegate', v_task.generation, null, null,
      p_args->>'label');
    return jsonb_build_object('delegation', v_id, 'task', v_task.id);

  -- A result keeps the child's findings, assumptions, evidence and objections
  -- apart, so objections survive the leader's summary.
  when 'child_close' then
    select t.* into v_task from chat_private.tasks t join chat_private.delegations d on d.task_id = t.id
      where d.id = chat_private.hfma_id(p_args, 'delegation') for update of t;
    if not found then
      perform chat_private.hfma_fail('missing', 'Delegation not found.');
    end if;
    if v_sender <> v_task.team then
      perform chat_private.hfma_fail('forbidden', format('Only team %s closes this delegation.', v_task.team));
    end if;
    v_status := coalesce(p_args->>'status', '');
    if v_status not in ('accepted', 'rejected', 'failed', 'cancelled') then
      perform chat_private.hfma_fail('invalid', 'status must be accepted, rejected, failed or cancelled.');
    end if;
    if v_status <> 'cancelled' then
      v_reason := chat_private.hfma_text(p_args, 'result', 16000);
      select array_agg(h) into v_ok from unnest(array['Findings', 'Assumptions', 'Evidence', 'Objections']) h
        where v_reason !~* ('(^|\n)#+\s*' || h);
      if v_ok is not null then
        perform chat_private.hfma_fail('invalid', 'The result must have the section headings: ' || array_to_string(v_ok, ', ') || '.');
      end if;
    end if;
    update chat_private.delegations set status = v_status, result = v_reason, closed_at = now()
      where id = (p_args->>'delegation')::bigint and status = 'open';
    if not found then
      perform chat_private.hfma_fail('status', 'The delegation is already closed.');
    end if;
    perform chat_private.hfma_event(v_task.room, v_task.id, v_sender, 'child_' || v_status, v_task.generation);
    return jsonb_build_object('delegation', (p_args->>'delegation')::bigint, 'status', v_status);

  -- Record a decision. A decision on a key that already has an active one either names
  -- it in "supersedes" (a deliberate change) or becomes a conflict.
  when 'decision_add' then
    v_room := chat_private.hfma_room(p_args);
    perform chat_private.hfma_open(v_room);
    v_charter := chat_private.hfma_charter(v_room);
    if v_sender <> 'yeebyor' and not (v_charter.body->'ownership') ? v_sender then
      perform chat_private.hfma_fail('forbidden', 'Only agents in this project or yeebyor can record decisions.');
    end if;
    v_key := lower(btrim(chat_private.hfma_text(p_args, 'key', 80)));
    if v_key !~ '^[a-z0-9][a-z0-9 ._/-]{0,79}$' then
      perform chat_private.hfma_fail('invalid', 'key must be a short topic: letters, digits, spaces, . _ / -');
    end if;
    select * into v_other from chat_private.decisions where room = v_room and key = v_key and status = 'active' for update;
    if p_args ? 'supersedes' then
      if v_other.id is null or v_other.id <> chat_private.hfma_id(p_args, 'supersedes') then
        perform chat_private.hfma_fail('status', format('supersedes must name the active decision on "%s"%s.', v_key,
          case when v_other.id is null then ' (there is none)' else format(' (#%s)', v_other.id) end));
      end if;
      update chat_private.decisions set status = 'superseded', resolved_at = now() where id = v_other.id;
    end if;
    insert into chat_private.decisions(room, key, title, body, actor, status, supersedes, conflicts_with)
      values (v_room, v_key, chat_private.hfma_text(p_args, 'title', 200), chat_private.hfma_text(p_args, 'body', 8000), v_sender,
        case when v_other.id is not null and not p_args ? 'supersedes' then 'conflict' else 'active' end,
        case when p_args ? 'supersedes' then v_other.id end,
        case when v_other.id is not null and not p_args ? 'supersedes' then v_other.id end)
      returning * into v_decision;
    perform chat_private.hfma_event(v_room, null, v_sender,
      case when v_decision.status = 'conflict' then 'decision_conflict' else 'decision' end, null, null, null,
      format('#%s %s: %s', v_decision.id, v_key, v_decision.title));
    return to_jsonb(v_decision);

  -- Settle a conflict: keep the active decision (the new one is rejected) or replace it.
  -- The orchestrator may decide only when neither side is its own; otherwise yeebyor.
  when 'decision_resolve' then
    select * into v_decision from chat_private.decisions where id = chat_private.hfma_id(p_args, 'decision') for update;
    if v_decision.id is null then
      perform chat_private.hfma_fail('missing', 'Decision not found.');
    end if;
    perform chat_private.hfma_open(v_decision.room);
    if v_decision.status <> 'conflict' then
      perform chat_private.hfma_fail('status', format('Decision #%s is %s, not a conflict.', v_decision.id, v_decision.status));
    end if;
    select * into v_other from chat_private.decisions where id = v_decision.conflicts_with for update;
    if v_sender <> 'yeebyor' and (v_sender is distinct from (chat_private.hfma_charter(v_decision.room)).body->>'orchestrator'
        or v_sender in (v_decision.actor, v_other.actor)) then
      perform chat_private.hfma_fail('forbidden', 'Only yeebyor, or the orchestrator when neither decision is its own, can resolve this conflict.');
    end if;
    v_status := coalesce(p_args->>'choice', '');
    if v_status not in ('keep', 'replace') then
      perform chat_private.hfma_fail('invalid', 'choice must be keep (the active decision stays) or replace (the conflicting one wins).');
    end if;
    v_reason := chat_private.hfma_text(p_args, 'reason', 2000);
    if v_status = 'keep' then
      update chat_private.decisions set status = 'rejected', resolved_by = v_sender, resolution = v_reason, resolved_at = now()
        where id = v_decision.id;
    else
      if v_other.status <> 'active' then
        perform chat_private.hfma_fail('status', format('Decision #%s is no longer active; record the new decision again.', v_other.id));
      end if;
      update chat_private.decisions set status = 'superseded', resolved_by = v_sender, resolution = v_reason, resolved_at = now()
        where id = v_other.id;
      update chat_private.decisions set status = 'active', supersedes = v_other.id, resolved_by = v_sender, resolution = v_reason,
        resolved_at = now() where id = v_decision.id;
    end if;
    perform chat_private.hfma_event(v_decision.room, null, v_sender, 'decision_resolve', null, null, null,
      format('#%s on %s: %s. %s', v_decision.id, v_decision.key, case when v_status = 'keep' then format('kept #%s', v_other.id)
        else format('#%s replaces #%s', v_decision.id, v_other.id) end, v_reason));
    return (select to_jsonb(d) from chat_private.decisions d where d.id = v_decision.id);

  when 'task_get' then
    v_id := chat_private.hfma_id(p_args, 'task');
    if not exists (select 1 from chat_private.tasks where id = v_id) then
      perform chat_private.hfma_fail('missing', 'Task not found.');
    end if;
    return chat_private.hfma_task_json(v_id) || jsonb_build_object(
      'reviews', coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from chat_private.reviews r where r.task_id = v_id), '[]'),
      'evidence', coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from chat_private.evidence e where e.task_id = v_id), '[]'),
      'delegations', coalesce((select jsonb_agg(to_jsonb(d) order by d.id) from chat_private.delegations d where d.task_id = v_id), '[]'),
      'events', coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from chat_private.task_events x where x.task_id = v_id), '[]'));

  when 'board' then
    v_room := chat_private.hfma_room(p_args);
    select * into v_project from chat_private.projects where room = v_room;
    return jsonb_build_object('room', v_room,
      'charter_version', (select max(version) from chat_private.charters where room = v_room),
      'project', to_jsonb(v_project) - 'room',
      'tasks', coalesce((select jsonb_agg(chat_private.hfma_task_json(t.id) order by t.id)
        from chat_private.tasks t where t.room = v_room), '[]'),
      'decisions', coalesce((select jsonb_agg(to_jsonb(d) order by d.id)
        from chat_private.decisions d where d.room = v_room), '[]'));

  -- Only yeebyor closes, against the latest charter: every task finished, main
  -- consistent, each command criterion passing on main, each owner criterion
  -- confirmed by yeebyor in this call.
  when 'project_close' then
    perform chat_private.hfma_owner(v_sender);
    v_room := chat_private.hfma_room(p_args);
    perform chat_private.hfma_open(v_room, true);
    v_charter := chat_private.hfma_charter(v_room);
    select * into v_project from chat_private.projects where room = v_room for update;
    if v_project.main_hash is null then
      perform chat_private.hfma_fail('missing', 'The main hash has not been recorded yet.');
    end if;
    if exists (select 1 from chat_private.tasks where room = v_room and status not in ('DONE', 'CANCELLED')) then
      perform chat_private.hfma_fail('status', 'Some tasks are not DONE or CANCELLED yet.');
    end if;
    if exists (select 1 from chat_private.decisions where room = v_room and status = 'conflict') then
      perform chat_private.hfma_fail('conflict', 'A decision conflict is still open; resolve it before closing.');
    end if;
    if p_args ? 'owner_criteria' and jsonb_typeof(p_args->'owner_criteria') <> 'array' then
      perform chat_private.hfma_fail('invalid', 'owner_criteria must be a list of criterion IDs.');
    end if;
    for v_item in select * from jsonb_array_elements(v_charter.body->'criteria') loop
      if v_item->>'check' = 'owner' and not coalesce(p_args->'owner_criteria', '[]') ? (v_item->>'id') then
        perform chat_private.hfma_fail('criteria', format('You have not marked criterion %s as met.', v_item->>'id'));
      end if;
      if v_item->>'check' = 'command' and not exists (select 1 from chat_private.evidence e where e.room = v_room
          and e.kind = 'close' and e.criterion = v_item->>'id' and e.commit = v_project.main_hash
          and e.charter_version = v_charter.version and e.command = v_item->>'command'
          and e.exit_code = 0 and not e.timed_out) then
        perform chat_private.hfma_fail('criteria', format('Criterion %s has no passing evidence on main for charter version %s.',
          v_item->>'id', v_charter.version));
      end if;
    end loop;
    update chat_private.projects set closed_at = now() where room = v_room;
    perform chat_private.hfma_event(v_room, null, v_sender, 'close', null, v_project.main_hash);
    return jsonb_build_object('room', v_room, 'closed', true, 'main_hash', v_project.main_hash, 'charter_version', v_charter.version);

  else
    perform chat_private.hfma_fail('invalid', format('Unknown operation %s.', p_op));
  end case;
  return null;
end;
$$;
