package dev.mote.collector

import android.content.Intent
import android.content.pm.PackageManager

/** Package identities only; system apps obey exactly the same user-selected privacy rules. */
object InstalledApps {
    @Suppress("DEPRECATION")
    fun load(manager: PackageManager, configured: Set<String> = emptySet()): List<Pair<String, String>> {
        val apps = manager.getInstalledApplications(0).associate { it.packageName to it.loadLabel(manager).toString() }.toMutableMap()
        for (category in listOf(Intent.CATEGORY_HOME, Intent.CATEGORY_LAUNCHER)) {
            manager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(category), 0).forEach {
                apps[it.activityInfo.packageName] = it.loadLabel(manager).toString()
            }
        }
        configured.forEach { id -> apps.putIfAbsent(id, runCatching { manager.getApplicationInfo(id, 0).loadLabel(manager).toString() }.getOrDefault(id)) }
        return apps.toList().sortedWith(compareBy<Pair<String, String>> { it.second.lowercase() }.thenBy { it.first })
    }
}
