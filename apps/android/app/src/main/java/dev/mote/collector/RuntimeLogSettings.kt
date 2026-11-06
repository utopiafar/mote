package dev.mote.collector

import android.content.Context

data class RuntimeLogPolicy(val enabled: Boolean, val level: String) {
    init { require(level in levels) }
    fun allows(eventLevel: String): Boolean = enabled && levels.indexOf(eventLevel.lowercase()) >= levels.indexOf(level)

    companion object {
        val levels = listOf("debug", "info", "warn", "error")
        fun defaults(development: Boolean) = RuntimeLogPolicy(true, if (development) "debug" else "info")
    }
}

/** Logging is independent of capture settings and must be readable by background workers. */
class RuntimeLogSettings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("runtime_log_settings", Context.MODE_PRIVATE)
    fun read(): RuntimeLogPolicy {
        val defaults = RuntimeLogPolicy.defaults(RuntimeProfile.current.detailedDiagnostics)
        val level = prefs.getString("level", defaults.level)?.takeIf { it in RuntimeLogPolicy.levels } ?: defaults.level
        return RuntimeLogPolicy(prefs.getBoolean("enabled", defaults.enabled), level)
    }
    fun save(policy: RuntimeLogPolicy): Boolean = prefs.edit()
        .putBoolean("enabled", policy.enabled).putString("level", policy.level).commit()
}
