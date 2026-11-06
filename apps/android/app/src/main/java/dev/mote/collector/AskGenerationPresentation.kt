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
        val running = state.optString("runStatus") == "running"
        val pending = state.has("pending")
        val busy = running || pending
        return State(
            busy = busy,
            offline = offline,
            canSend = allowed && !busy && !offline && text.isNotBlank() && !imagesPending,
            stop = !offline && running && !pending,
            retry = !offline && pending,
            // An adopted run has no local request to re-submit; its stop action
            // already owns the composer while the run is running.
            check = !offline && pending,
        )
    }
}
