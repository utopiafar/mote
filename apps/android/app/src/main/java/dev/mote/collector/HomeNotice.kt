package dev.mote.collector

/** The single line above the home content. Copy stays as keys so the row translates at render time. */
internal data class HomeNotice(
    val titleKey: String,
    val actionKey: String,
    val level: CaptureStatusLevel,
    val operation: Operation,
    /** Optional muted suffix, such as the time a screen pause started. */
    val detail: String? = null,
) {
    sealed interface Operation {
        data object Connect : Operation
        data class Capture(val operation: CaptureStatusOperation) : Operation
    }

    companion object {
        /** First use is the only state that outranks a quiet status row: no connection still saves locally. */
        fun connect() = HomeNotice("连接你的 Mote", "连接", CaptureStatusLevel.REMINDER, Operation.Connect)

        /** One row at most: the shared table picks it, and a needs-action row always wins over first use. */
        fun from(facts: CaptureStatusFacts): HomeNotice? {
            val status = CaptureStatusMapping.status(facts)
            if (facts.connection == CaptureConnection.UNCONFIGURED && status.level != CaptureStatusLevel.NEEDS_ACTION) return connect()
            val home = status.home ?: return null
            return HomeNotice(home.titleKey, actionKey(home.operation), status.level, Operation.Capture(home.operation))
        }

        private fun actionKey(operation: CaptureStatusOperation): String = when (operation) {
            CaptureStatusOperation.RESUME_CAPTURE, CaptureStatusOperation.RESUME_SEND -> "恢复"
            CaptureStatusOperation.RECONNECT -> "连接"
            CaptureStatusOperation.RESTART_CAPTURE -> "重新开启"
            CaptureStatusOperation.OPEN_PERMISSIONS, CaptureStatusOperation.OPEN_STORAGE, CaptureStatusOperation.OPEN_SYNC -> "处理"
        }
    }
}
