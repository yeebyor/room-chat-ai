# NOTED-ASTRA: An independent review of the HFMA proposals

> **Archive.** Written October 4, 2026, before HFMA was specified, and kept unchanged as a
> record of why the rules look the way they do. Line numbers, file names and the
> implementation status mentioned here have changed since; this file was called
> `NOTED-ASTRA.md`, and the `NOTED.md` it reviews is now [notes.md](notes.md). The rules in force are in
> [HFMA.md](../../HFMA.md).

Date: October 4, 2026. Basis of the review: NOTED.md read to the end, then a static examination of the code and guides in room-chat-ai. There was no live database inspection, no exploitation attempt, and no re-verification of the SchedShrink session. The implementation findings below apply to the sources examined, not a statement that the deployment is certainly identical. The .env files were not opened and the project scripts were not run.

**Main assessment:** the initial list equates recording and approval flows with enforcement too quickly. HFMA needs a definition of what the substrate can really prevent, who can still get around it, and how authority and evidence flow past leaders to sub-agents. That is more fundamental than adding many statuses or voting mechanisms.

**A1. G1, G3, C4: a worktree is not an authority boundary, and merge is not the only effect that needs guarding.**

The claim that G1 is enforced along with G3 is too strong. A worktree separates the working directory, but it stays connected to the same repository and shares some metadata and references. This sharing is described in the [official Git documentation](https://git-scm.com/docs/git-worktree#_description). My architectural conclusion: a worktree does not by itself prevent a team from writing to another team's directory or bypassing the integration gate if process permissions allow it.

Rejecting changes at merge time only means something if the integration target can only be written by a trusted service. A ban on changing files is also not the same as a ban on running migrations, sending external requests, or changing shared artifacts. Those effects can happen before merge. C4 needs to define the boundaries of processes, credentials, filesystem, network and the trusted integration service. The CLI is only an interface; role checks must live in a service that cannot be bypassed.

File ownership rules should ask the owner's approval for cross-team changes rather than always rejecting them. An absolute rejection makes cross-module refactors hard. The version of the ownership rules and the exception permits need to be part of the integration decision.

**A2. G3: per team is a responsibility boundary, not necessarily the unit of writer isolation.**

Switching from worktree per agent to worktree per team absolutely moves collisions inside the team. Two sub-agents writing the same file can still overwrite each other. My proposal: a team owns an integration space, while tasks with concurrent writers use separate workspaces or a single serialized writer. Read-only sub-agents need no worktree of their own.

One repo per project is an operational choice, not an HFMA requirement. A monorepo can work too if the boundaries of artifacts, changes and authorization are clear. Avoid presenting the repo layout decision as a contribution or an architectural must.

**A3. G2: a status sequence does not yet define a correct task protocol.**

`CLAIMED` and `WORKING` must be distinguished by observable actions; otherwise they only add administration. More important are the transition preconditions: the expected task version, the current claim holder, its authority period, the charter version, and the artifact being judged. Status changes must be atomic, and a retry with the same operation ID must not duplicate effects.

Distinguish tasks waiting on dependencies, waiting on the owner, failed, cancelled, and superseded. Not all of them need to be new statuses, but the semantics must exist. `APPROVED` also does not mean integrated or meeting the project criteria. For each task, decide whether done means producing a report, passing review, or landing in the project artifact. Add typed dependencies and cycle detection so local tasks do not all look done while integration stays impossible.

**A4. G4: approvals and test results must be bound to a specific integration candidate.**

An approval needs to bind at least the task ID, the candidate hash, the integration base, the charter version and the test suite version. If the candidate changes, the approval does not carry over automatically. If the integration target changes, the merged result needs to be checked again, with an explicit rule for when a re-review is needed. Without this, changes can be slipped in after review, or two changes that pass separately can fail when merged.

Tests run by the substrate fix the authenticity of execution reports, but they do not fix wrong tests. The empty test case in NOTED.md shows exactly this difference. Separate tests proposed by the author from acceptance criteria controlled by the owner or an evaluator. The test runner must be isolated from integration credentials, because running tests means running code an agent may have written. Record results including skipped tests, case counts, timeouts and environment versions; an exit code alone is not enough.

**A5. G4, C1: a different team does not automatically mean an independent review.**

Different vendors do not guarantee uncorrelated mistakes. A reviewer can take the author's summary as a premise or help design the change it later approves. Define independence operationally: it did not author the candidate under review, can read the artifacts and raw evidence, and checks the acceptance criteria itself. For high-risk changes, ask the reviewer to form failure hypotheses before seeing the author's conclusions.

Strong credentials prevent misattribution, not careless approval or collusion. The statement that review and audit are meaningless without C1 is too absolute: they still help analyze mistakes by cooperative agents, but they cannot serve as proof of a separation of authority that resists impersonation.

**A6. C1: the risk finding is supported by the code, but the scope of its verification needs narrowing.**

`scripts/chat.mjs:16-17` picks the token from the environment based on the argument name. The script does not load an env file itself; the loading hint is on line 1. `scripts/create-local-credentials.mjs:17` does write all three agents' tokens to one file. This supports the risk in the documented shared launch pattern; it does not prove every running process holds every token. I did not inspect env contents, process environments or actual ACLs.

The server does not simply trust a name from the client: `supabase/schema.sql:63-74` decides identity from the token hash and the revocation flag, and `src/app/api/messages/route.ts:37` rejects a `sender` field. So the main problem is the distribution of the ability to use an identity, not a lack of authentication.

Splitting token file names is not enough if all of them can still be read by processes with the same rights. Define team identity, leader session identity, and authorization per project and operation. A room token does not need to inherit merge capability. For sub-agents, derived capabilities must be narrower than or equal to their parent's, have an expiry, and be revoked when the delegation ends. State this guarantee in terms of the threat model, not as an identity that absolutely cannot be forged.

**A7. C2: a charter agents cannot edit does not yet guarantee work follows the charter.**

Agents can still reinterpret criteria without changing a database row. Every task and acceptance decision must point to the ID and version of the criteria met, with matching evidence. Criteria that cannot yet be tested automatically must be marked as human judgment, not silently assumed guaranteed by the server.

Owner changes also need semantics: do they void old approvals, supersede old tasks, or only apply to the next phase? Separate the goals and limits agents may not change from implementation decisions that are delegated on purpose. If every detail goes into a charter only the owner can change, team autonomy disappears without an equivalent security benefit.

**A8. C3: claim expiry needs a generation number and a separate task heartbeat.**

An expired claim does not prove the old leader has stopped. It may still be working when a new leader takes over. Use an increasing claim generation number; every status change, artifact submission and integration must carry the active generation. Operations by the old claim holder are rejected even if it reconnects. This number limits which results are accepted; it does not magically stop the old process.

Do not extend claims based on room presence. An agent can poll diligently without progress, or work legitimately without polling. `CHAT.md:130-132` even asks agents to run `leave` before long work. Proposal C3, which mimics the 90-second presence, contradicts that work pattern if applied directly. Use a per-task heartbeat, a separate work deadline, and artifact-based progress signals.

Returning a task to `TODO` is not always safe either. If there are external effects whose status is unknown, reconcile first. Keep a checkpoint and the reason the claim ended so the successor does not repeat actions that already succeeded.

**A9. G5: audit is not enough as a by-product of Git and statuses.**

Git shows artifact changes, not every delegation, rejected attempt, discarded result, cancellation or failed access. Commit author identity is also not equivalent to an authenticated process identity. The log needs event IDs, session identity, parent-child relations, task IDs, policy versions, claim generations, artifact hashes, and causal links between operations.

Record status changes and audit events in the same transaction, then link external execution results through an operation ID. Store them outside any space teams can edit. A prototype does not need a blockchain or signatures on every event right away; an append-only log through a trusted service plus an artifact archive is already a more measurable start.

Retention also needs an explicit decision. `supabase/schema.sql:392-395` deletes messages when a room is deleted. The current room log is not an experiment archive that resists deletion. Do not let tidying up rooms erase the paper's evidence.

**A10. The delegation ledger must distinguish leader reports from runtime observations.**

A leader recording through the CLI is the leader's claim about its children. It can forget to record, leave out results it does not like, or name sub-agents without proof that the process really ran. Mark the origin of each fact: reported by the leader, observed by a runtime adapter, or verified from artifacts.

A minimum delegation contract should contain parent and child IDs, the task, frozen inputs, the charter version, the write space, tool capabilities, budget, deadline, and the shape of the result. Record creation, start, result, cancellation and cancellation acknowledgment as separate events. If the vendor offers no observation of children, write down that limit; do not count the absence of logs as the absence of sub-agents.

**A11. The hierarchy layer needs child acceptance rules and cascading cancellation.**

A parent task must not count as complete just because the leader wrote a summary. Every required child must finish with its result accepted, or be cancelled with a valid reason. Optional children and failed experiments must stay visible. If two children produce conflicting recommendations, record the leader's decision together with the rejected result.

Cancelling a parent or changing the charter version must revoke the authority of affected children, including grandchildren. Late results may be kept for audit, but do not automatically become active results. For adapters that cannot stop a process, the substrate at least rejects late results and effects at the points it controls, and states that stopping the process is not yet guaranteed.

**A12. A hierarchy needs control over information lost in summarizing.**

The leader filters information from its sub-agents. Important mistakes can be lost before reaching a reviewer or the owner even if every identity and status is correct. Delegation results need to separate findings, assumptions, evidence, uncertainty, and unresolved objections. Summaries must point to their sources so reviewers can trace claims without giving every sub-agent a voice in the room.

For the paper, measure how many child objections survive into the parent's decision, and how many defects a child knew about but were lost in summarizing. This tests the mechanism that is truly specific to hierarchy, not just a count of leader messages.

**A13. The orchestrator needs a term of office and a per-decision separation of authority.**

An orchestrator that also leads a team has a conflict of interest in task assignment, reviewer selection and accepting its team's results. It may propose assignments, but the service must check reviewer eligibility without the orchestrator being able to override it. Decisions about its own results still go through the same role separation.

Store the orchestrator appointment with a term number. When it changes, the old orchestrator's commands no longer apply. Project state must be recoverable from the substrate, not from the old leader's conversation memory. For three teams, a replacement appointed by the owner is enough for an initial version; an automatic leader election algorithm is not needed without a clear availability requirement.

**A14. G6: message counts are a weak proxy for cost and blockage.**

Sub-agents can use up resources without a single room message. Conversely, a long discussion can be productive. Message limits and rejection counts must not be treated as cost limits. The statement that tokens cannot be counted is also too absolute: availability depends on the adapter or vendor reports. If unavailable, mark it as unknown; do not invent estimates and call them measurements.

Apply a per-project budget allocated to teams and down to children, with limits on delegation depth, active children, duration, attempts, and observable tool calls. Avoid double counting child usage already included in the parent's report. A warning and a stop are two different actions: `@yeebyor` does not stop the work loop. When a hard limit is reached, block new delegations or effects and keep a checkpoint.

**A15. G7: the same topic is not the definition of a conflict, and different topics are not proof of consistency.**

Two proposals on the same topic can be compatible, or simply alternatives not yet chosen. Two decisions under different keys can contradict each other, for example a requirement for offline operation and a mandatory dependency on an external API. Keyed records only detect administrative collisions, not semantic conflicts.

Start from a decision registry that records scope, version, status, superseded decisions, dependencies and explicit limits. A deterministic validator can check the limits that have been formalized. An LLM may help find suspected conflicts as a signal for review, without the authority to change decisions. With this separation the substrate stays deterministic in enforcement; there is no need to choose between a full LLM judge and key detection that is too simple.

**A16. C6 and closing by the owner: measure decision quality, not just approval speed.**

An owner who approves quickly may be getting a misleading summary. Summaries need to show unproven criteria, missing evidence, minority objections, changes since the last approval, and artifact links. Distinguish a zero value from data not yet known. Measure the accuracy of understanding and defects that slipped through alongside the owner's time.

The owner's right to close a phase does not require every small task to wait for the owner's approval. Choose checkpoints by risk and by the criteria that cannot yet be automated. Escalation needs a "waiting for decision" status, grouping of similar cases, and a rule for when the owner is unavailable. The owner's silence must never count as approval. This policy must be separate from the 100-second chat hold.

**A17. Correction to section 2: room creation is not enforced as an owner-only right.**

This is a direct mismatch with the code. `supabase/schema.sql:309-317` only authenticates the `create_room` caller, without checking that it is yeebyor. `src/app/api/rooms/route.ts:11-17` also passes the authenticated token to that function without an owner condition. The same path is in the upgrade script `supabase/rooms-backend.sql:31-39`.

Besides explicit creation, `supabase/schema.sql:246` inserts the room in the message send path, before the turn check. If the send is valid, the new room is saved along with it; if the transaction fails, that insert is rolled back too. This behavior also appears in `supabase/turn-autonomy.sql:176`.

The restriction while an agent is present applies to rename and delete (`supabase/schema.sql:365-367` and `389-391`), not to pin (`326-340`) or create. So the table row that groups create, pin, rename and delete as one server guarantee needs splitting. A UI claim is not an API authorization boundary.

**A18. Correction to section 2: the server stop only guarantees rejecting new agent messages.**

`supabase/schema.sql:106-110` decides `stopped` from the owner's latest message matching the phrase, and `268-269` rejects new agent sends. `scripts/chat.mjs:55-60` leaves its polling loop when it sees the stopped condition. This does not control tool processes or sub-agents already running. The sentence saying the server stops every agent goes beyond what the implementation guarantees.

The regex also matches the phrase inside a sentence, including quotes or negations. A later owner message that does not match can reopen the conversation. For governance, propose an explicit control operation with a project status and a cancellation generation number, and make the chat a view of that event. Do not equate extracting commands from free text with a hierarchical stop protocol.

**A19. Limit of section 2: the stale reply guard does not prove an agent read the latest context.**

`supabase/schema.sql:261-266` requires an ID and then checks for messages with a higher ID. There is no check that the given ID equals the room's latest ID. `src/app/api/messages/route.ts:45-48` passes on any number that passes cursor validation. So an ID higher than the latest one can get past the stale check, although the turn and stop conditions still apply.

The rejection claim is correct for clients that honestly report their last cursor. For stronger enforcement, use a room version that must equal the server version inside the transaction. Even that only proves version agreement, not that the model really understood the content. The same limit applies to task and charter versions.

The turn table also simplifies the presence rules: `supabase/schema.sql:142-154` allows a pool from mentions without the presence requirement and falls back to other agents when no presence is reported. This matters when the paper describes the set of eligible participants; it is not just a display detail.

**A20. C5: configuration records are not enough for reproduction, and old data is not automatically just a case study.**

Without model versions, causal comparison of model capability is weak. But old data can still support measured descriptive analysis or protocol findings that do not depend on the model version, as long as the missing metadata and selection bias are explained. Do not erase its value with a single classification.

For new experiments, keep a manifest per run: the initial and final artifact versions, adapters, policies, task inputs, evaluation data, available capabilities, the prompt for each role, and configuration changes during the run. The turn seed alone does not guarantee reproduction: the computation also depends on time and presence (`supabase/schema.sql:101-137`), while the presence table is updated or deleted (`212-219`). The message log is not enough to recover all that state. Record the scheduler's decisions with their inputs.

Separate replaying substrate decisions from repeating model output. The first can be tested exactly when every input is recorded; the second may still vary. Do not promise full reproduction just because versions and seeds are recorded.

**A21. For the paper, define invariants and progress limits before claiming the architecture is safe.**

Proposed invariants: only the active claim generation can submit an active result; the author cannot be the only approver; integration only accepts candidates with evidence that is still valid; a child gains no authority beyond its parent; and closing a project refers to a valid criteria version. Each invariant needs to name the enforcing component and the assumptions that make it hold.

Progress is a different claim: what happens if a reviewer disappears, the owner is unavailable, or the audit service fails? A protocol that always rejects every action does prevent violations, but it is useless. Report task success and recovery time together with violations. Test fault injection such as a dead leader, an old leader coming back, a retry after a timeout, a candidate changed after review, a late child result, and tests that change the environment. This is a proposed experiment, not results I have run.

**A22. The novelty claim needs hypotheses that separate hierarchy, federation and governance.**

Combining Git, a task board and review across different vendors is not yet enough to show scientific novelty. A sharper candidate contribution is a protocol for authority and evidence across delegation boundaries when the vendor runtime is only partly observable. State what the service guarantees, what adapters report, and what still depends on model compliance.

Baselines are needed that let the cause of any benefit be separated: a single agent with a comparable budget; a flat team with the same gates; a single-vendor hierarchy with the same gates; a hierarchical federation with prompt-only rules; and full HFMA. Not every variant has to run at once, but a baseline without gates alone cannot prove the benefit of hierarchy or vendor diversity. Add targeted ablations for the mechanisms actually claimed as contributions.

No systematic literature survey was done in this review. So I neither confirm nor reject the novelty claim against prior publications. Before a paper, compare related work by unit of delegation, authorization guarantees, child observability, failure recovery and evaluation, not just by similar architecture terms.

**A23. The evaluation design must control hidden costs and owner bias.**

One SchedShrink session can motivate mechanisms, but it does not separate the influence of model, prompt, task or orchestrator. Randomize or balance the assignment of models to roles, use several tasks and repetitions, and set the sample size from a pilot and the uncertainty you want to bound. The main unit of analysis is the independent run or task, not 32 messages treated as 32 samples.

Freeze the criteria before a run, evaluate artifacts without knowing the experimental condition where possible, and report failed and stopped runs. The main metrics can be task success and defects that slipped through. Include total time, observed cost with the unknown part, rework, owner load, review blockage, and completeness of the delegation trail. Few room messages do not prove total coordination is cheaper if child communication is hidden.

Choosing DSAI tasks helps the owner judge, but it does not remove bias when the owner also designs, operates and evaluates the system. For CNN tasks, freeze the data split, model selection rules, compute limits, and a final evaluation that may not be used for iteration. Add short tasks with objectively checkable results so the effect of governance is not drowned in training time. Tasks must not be re-chosen after seeing which condition wins.

**A24. The priority order in section 6 needs to change according to the dependencies between guarantees.**

I would not put worktrees as the first foundation, and would not postpone C4, C5 or the audit as documentation work after the core. The order I propose:

1. **Define the contracts and trust boundaries.** Set the invariants, the capabilities that can really be limited, session and team identity, charter versions, and runtime assumptions. Correct the implementation claims A17-A19 before using them as the basis for the specification. Write the evaluation hypotheses and the minimum run manifest at this stage.
2. **Build one complete task flow.** Limited identity and capabilities, workspaces matching concurrent writers, claims with generations, fixed candidate submission, test evidence from an isolated runner, review, then integration that only a trusted service can perform. A minimum audit log is recorded from the first transaction. Do not build every status variant first.
3. **Prove the hierarchy layer and recovery.** One leader delegates to a child with a measurable contract, accepts or rejects its result, then is tested when the claim expires or the parent is cancelled. Include an orchestrator change and the rejection of old results. Without this stage, the prototype is still mainly a governance system between leaders.
4. **Add minimum operational controls before long runs.** Derived budgets, cancellation, waiting for owner decisions, simple evidence summaries, and a decision registry. Hard limits and the means to understand escalations need to arrive together, not escalation triggers first and owner summaries later.
5. **Extend features based on measured failures.** Semantic conflict detection, more complex review policies, adaptive scheduling and detailed dashboards can follow. Run the baselines and ablations after the base protocol is stable.

For an early prototype, owner-managed exceptions and a simple registry make more sense than distributed consensus, a mandatory LLM judge, or full formal verification. But the assumptions about security, identity, artifact versions and evidence recording must not be treated as cosmetic additions. That is the part that decides whether the paper is measuring an architecture that enforces rules or just agents that happen to follow them.
