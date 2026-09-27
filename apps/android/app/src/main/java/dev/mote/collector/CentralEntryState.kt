package dev.mote.collector

/** Native presentation for a selected central origin; never carries device credentials. */
internal class CentralEntryState {
    enum class Phase { NEEDS_NODE, LOADING, READY, FAILED }
    var phase = Phase.NEEDS_NODE; private set
    var server = ""; private set
    fun begin(endpoint: String, confirmedEndpoint: String): Boolean {
        server = endpoint.trim().trimEnd('/')
        phase = if (server.isNotBlank() && server == confirmedEndpoint.trim().trimEnd('/')) Phase.LOADING else Phase.NEEDS_NODE
        return phase == Phase.LOADING
    }
    fun canResume(endpoint: String, confirmedEndpoint: String): Boolean =
        phase in setOf(Phase.LOADING, Phase.READY) && server.isNotBlank() &&
            server == endpoint.trim().trimEnd('/') && server == confirmedEndpoint.trim().trimEnd('/')
    fun failed() { phase = Phase.FAILED }
    fun finished() { if (phase == Phase.LOADING) phase = Phase.READY }
    val showWeb get() = phase == Phase.READY
}
