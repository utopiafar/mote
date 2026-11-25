package dev.mote.collector

import org.json.JSONObject

/** Sending locks the composer until Central acknowledges the message. Each
 * accepted answer keeps its own stop control while the composer is available. */
internal object AskGenerationPresentation {
    data class State(
        val busy: Boolean,
        val offline: Boolean,
        val canSend: Boolean,
        val stop: Boolean,
        val retry: Boolean,
        val check: Boolean,
    )

    fun read(
        state: JSONObject,
        text: String,
        imagesPending: Boolean,
        offline: Boolean,
        allowed: Boolean = true,
    ): State {
        val status = state.optString("runStatus")
        val active = status in NativeAskRunState.active
        val pending = state.has("pending")
        // An adopted message has no local request. Keep the check action reachable
        // instead of inventing a request body or a terminal state.
        val adopted = active && !state.has("activeRequest") && NativeAskRunState.messageId(state).isNotBlank()
        return State(
            busy = pending,
            offline = offline,
            canSend = allowed && !pending && !offline && text.isNotBlank() && !imagesPending,
            stop = !offline && active && !pending && NativeAskRunState.messageId(state).isNotBlank(),
            retry = !offline && pending,
            check = !offline && (pending || adopted),
        )
    }
}
