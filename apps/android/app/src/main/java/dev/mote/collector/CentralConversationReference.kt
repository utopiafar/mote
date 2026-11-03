package dev.mote.collector

/** A saved citation must not use the independent owner archive as a fallback.
 * Its identity is the shared reference route pinned to the citing conversation. */
internal object CentralConversationReference {
    fun route(conversationId: String, evidenceId: String): MoteLink.Route.Reference {
        val conversation = requireNotNull(MoteLink.uuidId(conversationId))
        val capture = CentralEvidenceReference.captureId(evidenceId) ?: requireNotNull(MoteLink.uuidId(evidenceId))
        return MoteLink.Route.Reference(CentralEvidenceReference.capture(capture), conversation)
    }
    fun available(client: CentralClient, conversationId: String, evidenceId: String): Boolean =
        available(client, route(conversationId, evidenceId))
    fun available(client: CentralClient, route: MoteLink.Route.Reference): Boolean {
        fun encode(value: String) = java.net.URLEncoder.encode(value, "UTF-8")
        val conversation = requireNotNull(route.conversation)
        val capture = requireNotNull(CentralEvidenceReference.captureId(route.ref))
        val value = client.get("/api/conversations/" + encode(conversation) + "/references/" + encode(capture))
        return value.optBoolean("available") && CentralEvidenceReference.normalize(value.optString("id")) == route.ref
    }
}
