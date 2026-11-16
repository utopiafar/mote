# Conversation, tasks and actions

The product direction is one continuing conversation for questions, records, corrections and authorized work. The model interprets the owner's latest instructions and effective Memory, with reasonable judgment for low-consequence details that are easy to correct. Pure recording needs a light acknowledgement; evidence and structured detail stay behind small optional entry points.

The current main conversation still uses read-only queries and action drafts, with messages queued per conversation. User steering, unified actions and background integration are implementation gaps in the [architecture map](architecture.md), not a separate permanent read-only product mode.

## Conversation and background work

Central retains submitted conversations, task state and results across clients. A local connection or page lifetime does not own a durable task. Messages can refer to prior context and corrections; model-selected retrieval should deepen only where useful. Previously answered questions and explicit refusals belong in effective context rather than being asked again.

Tasks, matters, suggestions, drafts and notifications describe different state. A suggestion is not an executed action, an accepted task is not a completed result, and an Agent report is not independent verification. Background uncertainty can remain unresolved until it affects the current answer or action. Owner questions use the shared versioned service and release execution resources while waiting.

Important constraints such as “do not create calendar events automatically” remain effective. A newer applicable instruction can steer ongoing work; unrelated new messages do not implicitly cancel it. Current provider support and task cancellation/version checks determine whether steering or continuation is available. No keyword table should determine whether a sentence is a question, request or personal preference.

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
