# Shared evidence reads

`EvidenceReader` owns archive retrieval and expansion. The app constructs it once, shares its MemoryStore and passes it to MCP; stateless MCP transports do not initialize read models for each request. It stores no authorization or previous query scope. Owner/collector and MCP credential checks stay at the protocol boundary, including revalidation for revoked MCP grants.

`ContextQuery` provides bounded cards and text on top of this reader. Web and MCP expose both exhaustive literal search (stable cursors) and ranked retrieval (the same optional embeddings with lexical fallback used by the Agent). Ranked retrieval is bounded and may be incomplete; use literal pagination to enumerate matches. Missing results do not establish absence of offline data.

`capture:<UUID>` and `memory:<UUID>` are canonical evidence refs. A bare capture UUID remains compatible. Collection and session cards carry explicit search expansion scopes instead of pretending their IDs are readable originals. An immutable capture ID never resolves to a newer source head. Reference reads reapply device/source/time/coding scopes; Memory reads require all dependencies in scope. Queries don't change authorization. Shadow reads recheck the parent after awaiting the collector.

Captured text is untrusted evidence. This service exposes no write tools. Image disclosure remains an explicit host setting and is disabled by default. All Web context routes require owner authorization.
