# Conversation, tasks and actions

The product direction is one continuing conversation for questions, records, corrections and authorized work. The model interprets the owner's latest instructions and effective Memory, with reasonable judgment for low-consequence details that are easy to correct. Pure recording needs a light acknowledgement; evidence and structured detail stay behind small optional entry points.

The main conversation persists each owner message before starting its read-only query or action draft. When compatible work is already active, the selected model decides whether the new message supplements that work or starts an independent request. Independent messages can answer while another query waits. Unified actions and lightweight recording/onboarding remain separate implementation steps in the [architecture map](architecture.md).

## Conversation and background work

Central retains submitted conversations, task state and results across clients. A local connection or page lifetime does not own a durable task. Messages can refer to prior context and corrections; model-selected retrieval should deepen only where useful. Previously answered questions and explicit refusals belong in effective context rather than being asked again.

Tasks, matters, suggestions, drafts and notifications describe different state. A suggestion is not an executed action, an accepted task is not a completed result, and an Agent report is not independent verification. Background uncertainty can remain unresolved until it affects the current answer or action. Owner questions use the shared versioned service and release execution resources while waiting.

Important constraints such as “do not create calendar events automatically” remain effective. A newer applicable instruction can steer ongoing work; unrelated new messages do not implicitly cancel it. Current provider support and task cancellation/version checks determine whether steering or continuation is available. No keyword table should determine whether a sentence is a question, request or personal preference.

For a compatible active Codex query, Central delivers the exact owner supplement through the existing native turn's `turn/steer` and retains its actual acknowledgement and turn identity. The acknowledgement is a receipt, not the adjusted task's final result. DSH currently has no matching live-steer protocol; its supplement is a durable continuation after the original query, with a visible relationship to the later owner message. The superseded original draft cannot start work as the latest instruction. A persistent DSH application keeps its existing single-writer identity: a second interaction waits without starting a private application child, while a query using another available runtime can continue.

Unconfirmed delivery remains unknown across restart and is never blindly resent. An acknowledged supplement can resume only from the original valid prepared input, with its original tools and scope plus the exact acknowledged owner text; missing or invalid input blocks recovery. Cancelling words already accepted by the runtime withdraws the affected current query/result rather than claiming to erase the model's input. Late or superseded results cannot publish. A supplement does not widen the older query's source, model or Action authority, and recovery does not replay external effects.

A formal `assistant.task` is a separate durable Task, linked to its original conversation or suggestion. The same model decision can select that Task using only current, authorized metadata. The new message must retain the Task's exact original scope and compatible actual model selection; the Task owner rechecks its immutable input, current batch, revision and execution fence. A native Codex ACK updates that Task's ongoing turn. A newly queued Task first waits for its own real executor to select a compatible model and register control; the supplement cannot select that model on its behalf. An owner-question wait or runtime without native steering instead receives a new read-only batch for the same Task, under the original Task grant. Unrelated messages can answer while either path waits.

Task supplements retain their own durable message receipts and current Task status. Cancelling a supplement withdraws the affected attempt and queues the original Task with the remaining authorized inputs and previously answered owner questions; it does not cancel the Task or erase words already delivered to a native turn. An old batch cannot replace the current Task result. Restart reconstructs the Task's frozen evidence and exact accepted owner words, with the saved actual model profile, model and configuration fingerprint. A changed or missing selection blocks that continuation. Combined owner replies and supplements retain the existing batch context byte budget; an oversized reconstruction remains blocked with all messages retained, rather than truncating them. Cancelling a supplement can bring the same Task back within that budget. Tasks started before a selection pin existed retain ordinary recovery, but are not guessed into the steering candidate list; a receipt without its required pin cannot resume an adjusted run. None of these paths grants external Actions or repeats an unknown external effect.

## Authorization and external effects

Read-only context tools expose authorized retained evidence. Product commands and Actions perform external effects, for both Mote and authorized external Agent clients. Captured instructions cannot grant action authority. Available tools, source permissions and requested scope still constrain the model's judgment.

An explicit instruction that specifies the target, scope and permanent deletion can execute without repeated confirmation. Ask when scope is unclear or material conditions change. An already authorized retention policy does not need approval of every batch. Source deletion and Mote archive deletion are separate; ordinary expiry and explicit forgetting also have different scopes.

For example, “permanently delete these three imported recordings” identifies an action, while “clean up the recordings” may need a scope choice. “Draft a reply” authorizes preparation; “send this reply to this person” supplies different authority. The model uses the owner's instructions and effective Memory rather than a new parallel rule set for external Agents.

Critical funds transfer and account/security changes retain the owner's final decision. When transaction terms actually require confirmation, present the concrete target and consequence once. Do not multiply modal approvals after a complete, applicable authorization. Results with an unknown external response need reconciliation before a duplicate send.

## Calendar and notifications

Calendar plans have their own start/end, all-day, timezone and status fields. Observing an event does not prove attendance or turn planned duration into measured activity. Calendar actions preserve the selected target and product-command result; a draft alone does not create an event.

Current notifications include Central state and online client presentation. Android's MVP polls while its process is alive, so it cannot promise timely background delivery on an idle phone. Native push is a future direction without a selected vendor, release or date. Read/handled state and feedback should attach to the actual task or notification rather than create another independent task copy.

## Progress and evidence

Show concise actual stage, waiting reason, result and a light route to source/detail. A user can ask for more. Report delivered evidence and available model usage; unknown usage is not zero, and estimated cost is not measured execution time. Screenshots, generated tests, real models and device behavior each support their own conclusions.

Implementation: [assistant-tasks.ts](../apps/server/src/assistant-tasks.ts), [assistant-actions.ts](../apps/server/src/assistant-actions.ts), [assistant-drafts.ts](../apps/server/src/assistant-drafts.ts), [assistant-notifications.ts](../apps/server/src/assistant-notifications.ts), [actions.ts](../apps/server/src/actions.ts) and [owner-questions.ts](../apps/server/src/owner-questions.ts). Runtime and recovery contracts are in [Agent execution](agent-runtime.md); source and model policy are in [Memory](memory.md) and [configuration](server-configuration.md).
