package dev.mote.collector

/** Transport restrictions apply equally to scheduled, manual and recovery uploads. */
data class SyncConditions(val chargingOnly: Boolean, val batteryNotLow: Boolean, val wifiOnly: Boolean) {
    fun waitingReason(charging: Boolean, batteryLow: Boolean?, unmeteredWifi: Boolean): String? = when {
        chargingOnly && !charging -> MoteI18n.text("等待充电")
        batteryNotLow && batteryLow != false -> MoteI18n.text("等待电量恢复")
        wifiOnly && !unmeteredWifi -> MoteI18n.text("等待非计费 Wi-Fi")
        else -> null
    }
}
