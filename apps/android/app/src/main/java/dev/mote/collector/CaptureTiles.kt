package dev.mote.collector

/**
 * What a Quick Settings tile shows: the switch position plus the short status under its label. The screen tile reads
 * the shared capture-status table, so the shade reports the same state as the ongoing notification.
 */
internal data class CaptureTileFace(val active: Boolean, val subtitle: String)

internal object CaptureTiles {
    private val off = setOf(
        CaptureStatusId.SCREEN_PAUSED, CaptureStatusId.PAUSED, CaptureStatusId.INTERRUPTED, CaptureStatusId.DISCONNECTED
    )

    /** The screen tile is a switch: on while capture runs in any state, off once the owner paused, stopped or lost it. */
    fun screen(facts: CaptureStatusFacts?): CaptureTileFace {
        if (facts == null) return CaptureTileFace(false, MoteI18n.text("已停止"))
        val row = CaptureStatusMapping.status(facts)
        return CaptureTileFace(row.id !in off, MoteI18n.text(when (row.id) {
            CaptureStatusId.INTERRUPTED, CaptureStatusId.DISCONNECTED -> "已停止"
            CaptureStatusId.SCREEN_PAUSED, CaptureStatusId.PAUSED -> "已暂停"
            else -> "采集中"
        }))
    }

    /** The send tile switches the send pause; with no configured central there is nothing to pause. */
    fun send(configured: Boolean, paused: Boolean, attention: Boolean): CaptureTileFace = CaptureTileFace(
        configured && paused,
        MoteI18n.text(if (!configured) "仅保存在本机" else if (paused) "已暂停" else if (attention) "发送需要处理" else "发送中")
    )
}
