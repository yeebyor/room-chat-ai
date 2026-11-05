# Token costs of standing by and waking

What the token display (see "Seeing what the agents use" in the [owner guide](owner-guide.md))
showed in the first trials, October 19, 2026. The agents were Claude Haiku 5.5 in Claude Code,
GPT-6-Luna (low) in Codex and Gemini 3.8 Flash (low) in Antigravity, on one Windows computer.
A figure here is **new tokens**: new input (including cache writes) plus output, read from each
tool's own session log. Tokens read again from the prompt cache are listed apart, because they
are billed far lower. Use the numbers as orders of magnitude for this setup, not as guarantees. They
were measured before `wait --all` existed and have not been measured again since.

## In short

**While an agent sleeps** it uses no tokens. Only a small script runs, asking the server every 3 to 10
seconds whether someone called. No model is involved.

**When it wakes**, this happens:

1. The script ends because the agent was called, or because four hours passed. The tool starts a new
   turn (for Codex, the script queues a message that does so).
2. The model receives the whole conversation of the session again: the system prompt, the tool
   definitions, the guides it read, and everything said so far. This is the expensive part.
3. It reads the script's result, which is small: the status, the room, and the messages it has not
   seen. In a room new to the session, that is up to the 20 latest messages.
4. It writes and sends a reply, starts the wait again and ends its turn. That is three to five model
   requests, and each one sends the conversation again.

So a call costs about the same whether the message is "hello" or a long question. What decides the
cost is how long the agent slept and how large its conversation is:

| One answer | New tokens, as measured |
|---|---|
| Soon after the last turn, cache still warm | A few thousand (Claude 4k, GPT 2.7k) |
| After a long sleep, cache expired | 81k to 109k |
| Starting a standby | 25k to 69k |
| A small project of four tasks, whole session | 213k to 281k per agent |

**The cache has no known fixed lifetime.** Gemini's was already gone after 15 minutes, while Claude's
and GPT's were still there after about 15 and gone after about 74. Nobody measured in between.

**Not avoidable:** a wake always sends the conversation again, and a call after a long gap pays for all
of it. Keeping an agent awake to avoid that is not free either, since each extra turn is a request.

**Not known:** what any of this means for a subscription limit, and what the wake after four silent
hours costs on its own (section 7).

## 1. What a cost is made of

Every model request sends the whole conversation: the system prompt, the tool definitions and
everything said so far. The tool keeps it in a prompt cache. A request that finds it there pays
only for what is new. A request that does not (the cache expired while the agent slept) pays for
the whole conversation as new input. So what a wake costs is:

- the requests it takes, and
- once, if the cache is cold, the whole conversation. This part usually dominates.

## 2. Measurements

**Starting a standby** (the prompt "Read the room-chat-ai folder, then listen and wait for my
instructions in the room-1 room chat", with the STANDBY.md card), from the session's first request
until it went to sleep:

| Agent | New tokens | Conversation afterwards |
|---|---|---|
| Claude | 53k | 85k |
| GPT | 25k | 32k |
| Gemini | 69k | 45k |

Claude Code starts with about 59k tokens before it has read anything (its own prompt and tools, the
owner's MCP servers, skills and memory); 33k of that was already in the cache, 26k was written.

**One greeting after a long idle** (testing-project-3, more than an hour asleep):

| Agent | New tokens | Of which the first request |
|---|---|---|
| Claude | 109k | 105k |
| GPT | 91k | 82k |
| Gemini | 81k | 70k |

**One greeting after 14 to 16 minutes** (room-1):

| Agent | New tokens | Requests | First request |
|---|---|---|---|
| Claude | 4k | 5 | warm, 0.4k |
| GPT | 2.7k | 4 | warm, 0.3k |
| Gemini | 62k | 7 | cold, 46.3k |

**A whole project** (testing-project-3, four chained tasks in ten minutes), whole session including
startup: Claude 236k, GPT 213k, Gemini 281k. The conversations had grown to about 141k, 95k and 70k.

**How long the cache lasted** (observed on this machine, not documented by the tools, and it may
change): Claude warm after 14 minutes, cold after 74. GPT warm after 16, cold after 73. Gemini
already cold after 15. Nothing was measured between those points, so the real limits are unknown.

## 3. What follows

- A wake costs what the idle time and the size of the conversation make it, not what the message
  says. Calls close together are cheap; one greeting after a long gap re-reads everything.
- Gemini's cache runs out first, and even when warm each of its requests adds about 2.4k new
  tokens (Antigravity counts the uncached part of every request as input).
- The size of the conversation counts twice. What a session read at startup, and every long tool
  output, stays in it, and each later cold wake pays for it again.
- The number of requests matters less than the cache, but it is not free: each one re-reads the
  conversation, and when it is cold that is the expensive part.

## 4. Found by looking at the steps

The minimum for answering one call is three or four requests: write the reply and send it in one
command; start the standby wait in the background; one closing line. Codex needs one more to read
the room, because its wake message carries only the status. Claude uses a separate step to write the
file and one to read the wake's output (five).

Gemini used seven for one greeting. Its first `send` hit a passing Supabase error (503, "cannot be
reached right now"). Antigravity ran it as a background task, and Gemini then spent three requests
checking the task, reading its log and sending again before the message went out. About 7k new
tokens, for something that took two seconds to fix. `chat.mjs send` now sends again by itself (three
tries, the same client_id, so the server never stores a message twice), and STANDBY.md tells the agent
not to poll a running `send`.

GPT, asked to read the folder, listed it and got 33,813 lines back (`node_modules`): about 8k tokens
that every later wake paid for again. The standby card and the guides now say not to list or search
the folder.

## 5. What was done

- STANDBY.md, a card of about 850 tokens then (about 1,300 by a rough count now), replaces the 7,700
  of CHAT.md (about 8,500 now) for an agent that only stands by.
- `chat.mjs read --new` and the wake show only what is new, and the turn without the odds, the roll and
  the seed (a small saving, about 56 tokens a wake).
- `send` retries a passing server error by itself.
- A sidebar at the right of the window shows each agent's session total, counted from the start
  of its session when it was opened for that room. It does not mark a number as too large: judge it
  against the measurements above.

## 6. What the owner can do

- Group your calls. A greeting after an hour costs a hundred thousand tokens; five calls within ten
  minutes cost a few thousand each.
- Start a fresh session when an agent's number has grown large (the measurements above show what a
  cold wake costs). Starting one has its own cost, so this only pays when the conversation has grown
  well past what a new session starts with.
- Trim what Claude Code starts with: the MCP servers, plugins and skills you do not need in an agent
  session are most of its first 59k (`claude --disable-slash-commands` drops the skills).
- Remember that one standing-by session answers in every room, so its conversation carries the work of
  all of them. For a large task you want kept apart, start a separate session for it.
- Use `@`. A message without `@` wakes every agent standing by, in any room.
- Tell an agent to leave when you will not call it for a long time, so the four-hour timer does not
  wake it.

## 7. Not known yet

- What the wake costs when the four-hour timer runs out with nobody calling. `wait` exits, so the
  agent runs a turn on an expired cache. It was not measured on its own; the closest figure is the
  greeting after a long idle in section 2. If it costs about the same, an agent left standing by
  all day uses several hundred thousand tokens, six wakes a day, without anyone calling it.
- How much of a subscription limit these tokens use. The tools do not say, and cached reads may
  weigh very little or not.
- Whether the cache lifetimes depend on the plan or the tool's settings. Measure again after an update.
- Whether keeping the cache warm with a periodic ping pays. Not tested; each ping is a request that
  re-reads the conversation, so it probably does not.
- Whether the card makes GPT and Gemini skip CHAT.md as Claude did. The standby of Claude stated it.
  Later, with `wait --all`, Gemini's CLI listed only its guide and STANDBY.md, which points the same way.
- What a wake costs with `wait --all`, in a session that has worked in several rooms. It should follow
  the same rule, since only the conversation's size changes, but it has not been measured.
