package dev.mote.collector

import org.json.JSONObject

/** One composer state for a saved or draft question. Generation exposes only
 * stop; an unreachable Central owner replaces it with the retry banner. */
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
        val busy = active || pending
        // An adopted message has no local request. Keep the check action reachable
        // instead of inventing a request body or a terminal state.
        val adopted = active && !state.has("activeRequest") && NativeAskRunState.messageId(state).isNotBlank()
        return State(
            busy = busy,
            offline = offline,
            canSend = allowed && !busy && !offline && text.isNotBlank() && !imagesPending,
            stop = !offline && active && !pending && NativeAskRunState.messageId(state).isNotBlank(),
            retry = !offline && pending,
            check = !offline && (pending || adopted),
        )
    }
}
