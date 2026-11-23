# Product

**English** · [简体中文](product.zh-CN.md)

Mote is an extensible personal context center. It collects authorized material from devices, files, applications and conversations, archives, organizes and interprets it, and makes that context available to applications and agents. A personal assistant is one application that grows on this foundation.

This page describes product direction; see [Architecture](architecture.md) for current implementation coverage.

## Position and scope

Collection, archiving, memory, retrieval and extensions form the foundation. Mote provides its own applications and serves authorized external applications and agents. Prioritize actions through connected tools and plugins; external agents can use Mote context for general terminal, coding and computer tasks.

One instance has one owner, without accounts, tenants or team collaboration. Sharing context with selected people is outside the near-term scope. Interaction should feel natural and warm; companionship is not a separate core delivery promise.

## Material and understanding

Original material, working context, long-term memory and reviews serve different purposes. Authorized archived material can be retrieved without waiting for Memory. Retain originals and device copies indefinitely by default, without an artificial material-storage quota; the owner chooses retention rules. Deletion at the source does not delete the Mote archive.

Models interpret meaning and choose retrieval tools; do not substitute keyword dispatch or handcrafted semantic heuristics. Use context and valid memories to make judgments. Where consequences are minor and correction is easy, proceed with useful work; ask when a key gap matters. Keep a small set of important preferences and constraints in context, retrieving other material as needed. Memories preserve subjects, provenance, time and validity; inferences are not the owner's words.

The model or selected memory implementation decides whether additional review is useful. Do not require an extra model call for every batch or replace that judgment with handcrafted semantic routing rules.

Deterministic code handles privacy filters, authorization, transport, deduplication, retention and measured usage. Captured and third-party content is context, and does not become an owner instruction by being summarized into memory.

## Applications and actions

Mote opens to Chat on Web, Mac and Android. From Chat, use Feed for updates and recaps, Ideas for suggestions and questions, Goals for commitments and follow-up, and Library for material and its sources. Memory, Skills, Connections and Settings support managing the context center. [Architecture](architecture.md#client-navigation) maps these nine entries to the current implementations.

The personal assistant uses one continuing main conversation for questions, assignments, feedback and corrections. Long tasks run in the background while conversation remains available. New guidance takes priority for the affected work. Plain recording receives a lightweight acknowledgement. Start “Get to know me” from Connections, choose sources and a time range, and follow the result in Chat.

Models follow current instructions, valid memories and existing authorization. Explicit constraints persist. Continue work already authorized; ask when necessary information is missing or a change exceeds that authorization. External agents follow the same principle. Select models by module or request; automatic fallback requires an explicitly permitted scope.
