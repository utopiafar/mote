package dev.mote.collector

internal enum class CaptureResume { STOPPED, ACCESSIBILITY, EXISTING_PROJECTION, NEW_PROJECTION }
internal fun captureResume(wasEnabled: Boolean, stillEnabled: Boolean, mode: String, projectionAlive: Boolean): CaptureResume = when {
    !wasEnabled || !stillEnabled -> CaptureResume.STOPPED
    mode != "projection" -> CaptureResume.ACCESSIBILITY
    projectionAlive -> CaptureResume.EXISTING_PROJECTION
    else -> CaptureResume.NEW_PROJECTION
}

/** Main-thread handoff also handles rotation between applying settings and requesting consent. */
internal class ProjectionConsentHandoff {
    private var pending = false
    private var observer: (() -> Unit)? = null
    fun attach(value: () -> Unit) { observer = value; if (pending) value() }
    fun detach() { observer = null }
    fun request() { pending = true; observer?.invoke() }
    fun cancel() { pending = false }
    fun take(): Boolean = pending.also { pending = false }
}
