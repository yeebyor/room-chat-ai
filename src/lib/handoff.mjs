// What an agent is told right after a hand-off command (submit, review, integrate), printed
// on the error stream by hfma.mjs, where it is read last. In a project the room is the pager:
// an agent sleeps in `chat.mjs wait --listen` and wakes only when called with @Name, so a task
// that changes hands without a call in the room stops the project, and nobody wakes. The same
// steps are in CHAT.md, "Hand-offs in a project".

export function sleepCommand(me, room) {
  return `chat.mjs ${me} wait ${room} --listen --timeout 14400${me === 'GPT' ? ' --wake codex' : ''}`;
}

export function handoffReminder(kind, { me, room, task, team, orchestrator, ready = [] }) {
  const say = `Say it in the room: chat.mjs ${me} read ${room}, then chat.mjs ${me} send ${room} --file <message> --last-seen <turn.last_id>.`;
  const sleep = `Then sleep: run ${sleepCommand(me, room)} in the background and end your turn. Do not poll in the foreground.`;
  if (kind === 'submit') {
    return `Task #${task} is submitted. Next: call one other agent in the room with @Name to review it: say which project and task this is, the commit, what the task is for and what to check against the charter. ${say} ${sleep}`;
  }
  if (kind === 'reject') {
    return `You rejected task #${task}. Next: call @${team} in the room: say it was rejected, give the main findings in a few sentences and ask them to fix it and call you again. ${say} ${sleep}`;
  }
  if (kind === 'approve') {
    return `You approved task #${task}. Next: call @${team} in the room: say it is approved and ask them to run integrate, which makes the task DONE. ${say} ${sleep}`;
  }
  if (orchestrator !== me) {
    return `Task #${task} is DONE. Next: say in the room that it is DONE and call the orchestrator, @${orchestrator}, so the next task can start. ${say} ${sleep}`;
  }
  const others = ready.filter((item) => item.team !== me);
  const own = ready.filter((item) => item.team === me);
  const call = others.length
    ? `call the agent whose task is now ready: ${others.map((item) => `@${item.team} (task #${item.id}, ${item.title})`).join(', ')}`
    : 'no task of another agent is ready yet; if every task is done, call @yeebyor to assess';
  return `Task #${task} is DONE and you are the orchestrator. Next: say in the room that it is DONE and ${call}. ${say} `
    + (own.length ? `Your own task #${own[0].id} is ready too: claim it now instead of sleeping.` : sleep);
}
