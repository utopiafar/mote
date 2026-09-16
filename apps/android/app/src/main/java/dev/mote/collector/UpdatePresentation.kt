package dev.mote.collector

/** State-derived actions prevent downloads with no candidate and duplicate install submissions. */
object UpdatePresentation {
    val transferStates = setOf("queued", "waiting_network", "waiting_wifi", "checking", "downloading", "verifying", "network", "rate_limit")
    val installStates = setOf("preparing", "staging", "install_pending", "awaiting_user")
    fun action(state: String, hasCandidate: Boolean): String = when {
        state in installStates || state in transferStates -> "busy"
        state == "ready" || state == "install_permission" -> "install"
        hasCandidate && state in setOf("available", "cancelled", "storage", "checksum", "asset_size", "scheduler", "install_failed") -> "download"
        else -> "check"
    }
}
