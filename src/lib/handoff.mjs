// What an agent is told right after a hand-off command (submit, review, integrate), printed
// on the error stream by hfma.mjs, where it is read last. Without it an agent that has just
// handed work over keeps polling `next` in the foreground, which reads its whole context
// again on every return, and one that does not say so in the room leaves yeebyor and the next
// agent guessing. The same steps are in CHAT.md, "Hand-offs: announce in the room, then sleep".

export function sleepCommand(me, room) {
  return `hfma.mjs ${me} next ${room} --timeout 14400${me === 'GPT' ? ' --wake codex' : ''}`;
}

export function handoffReminder(kind, { me, room, task, team, ready = [] }) {
  const say = `Say it in the room: chat.mjs ${me} read ${room}, then chat.mjs ${me} send ${room} --file <message> --last-seen <turn.last_id>, then chat.mjs ${me} leave ${room}.`;
  const sleep = `Then sleep: run ${sleepCommand(me, room)} in the background and end your turn. Do not poll next in the foreground.`;
  if (kind === 'submit') {
    return `Task #${task} is submitted. Next: ask one other agent in the room to review it. Call it with @Name and say which project and task this is, the commit, and what to check against the charter. ${say} ${sleep}`;
  }
  if (kind === 'reject') {
    return `You rejected task #${task}. Next: tell @${team} in the room that it was rejected and give the main findings in a few sentences. ${say} ${sleep}`;
  }
  if (kind === 'approve') {
    return `You approved task #${task}. Next: tell @${team} in the room that it is approved, so they run integrate. ${say} ${sleep}`;
  }
  const others = ready.filter((item) => item.team !== me);
  const own = ready.filter((item) => item.team === me);
  const call = others.length
    ? `call the agent whose task is now ready: ${others.map((item) => `@${item.team} (task #${item.id}, ${item.title})`).join(', ')}`
    : 'no task of another agent is ready yet; if every task is done and you are the orchestrator, call @yeebyor to assess';
  return `Task #${task} is DONE. Next: say in the room that it is done and ${call}. ${say} `
    + (own.length ? `Your own task #${own[0].id} is ready too: run next, which answers claim, instead of sleeping.` : sleep);
}
