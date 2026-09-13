package dev.mote.collector

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Process

object ForegroundApps {
    fun usageAllowed(context: Context): Boolean = context.getSystemService(AppOpsManager::class.java)
        .unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED
    fun snapshot(context: Context): WindowSnapshot {
        CaptureAccessibilityService.instance?.let { return it.windowSnapshot() }
        if (!usageAllowed(context)) return WindowSnapshot(emptySet(), null, false)
        val now = System.currentTimeMillis()
        val events = context.getSystemService(UsageStatsManager::class.java).queryEvents(now - 24 * 60 * 60 * 1000, now)
        var current: String? = null
        val event = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            when (event.eventType) {
                UsageEvents.Event.ACTIVITY_RESUMED -> current = event.packageName
                UsageEvents.Event.ACTIVITY_PAUSED -> if (current == event.packageName) current = null
            }
        }
        // UsageStats labels samples but cannot establish all visible windows for privacy filtering.
        return WindowSnapshot(setOfNotNull(current), current, false)
    }
}
