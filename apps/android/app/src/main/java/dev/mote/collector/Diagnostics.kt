package dev.mote.collector

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Numeric allowlist only. No screen text, notes, prompts, decisions, tokens or identifiers. */
class Diagnostics(private val context: Context) {
    private val prefs = context.getSharedPreferences("numeric_diagnostics", Context.MODE_PRIVATE)
    private val file = File(context.noBackupFilesDir, "diagnostics.json")
    fun add(name: String, value: Long = 1) = synchronized(lock) {
        if (!Settings(context).read().diagnosticsEnabled) return@synchronized
        require(name in counters && value >= 0)
        prefs.edit().putLong(name, prefs.getLong(name, 0) + value).commit()
    }
    fun timing(name: String, milliseconds: Long) = synchronized(lock) {
        if (!Settings(context).read().diagnosticsEnabled) return@synchronized
        require(name in timings && milliseconds >= 0)
        prefs.edit().putLong(name, milliseconds).commit()
    }
    fun sample(config: CollectorConfig, force: Boolean = false) = synchronized(lock) {
        if (!config.diagnosticsEnabled) return@synchronized
        val now = System.currentTimeMillis()
        if (!force && now - prefs.getLong("lastSample", 0) < config.diagnosticsIntervalSeconds * 1000L) return@synchronized
        val battery = battery(context)
        val item = JSONObject().put("atMs", now).put("batteryPct", battery.first).put("charging", battery.second)
            .put("queueBytes", context.queue().bytes()).put("queueDepth", context.queue().depth())
            .put("modelBytes", bytes(File(context.noBackupFilesDir, "models"))).put("diagnosticsBytes", file.length())
        val counter = context.getSystemService(BatteryManager::class.java).getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)
        if (counter != Int.MIN_VALUE && counter >= 0) item.put("chargeCounterUAh", counter)
        if (prefs.contains("previousBattery")) item.put("deviceBatteryDeltaPct", battery.first - prefs.getInt("previousBattery", battery.first))
        (counters + timings).forEach { item.put(it, prefs.getLong(it, 0)) }
        val old = read(); val next = JSONArray()
        for (index in maxOf(0, old.length() - 1439) until old.length()) next.put(old.getJSONObject(index))
        next.put(item)
        val temporary = File(context.noBackupFilesDir, "diagnostics.tmp")
        temporary.outputStream().use { out -> out.write(next.toString().toByteArray()); out.fd.sync() }
        check(temporary.renameTo(file))
        prefs.edit().putLong("lastSample", now).putInt("previousBattery", battery.first).commit()
    }
    fun export(): String = synchronized(lock) { JSONObject().put("version", 1).put("platform", "android")
        .put("batteryAttribution", "device-wide, not attributable to Mote").put("samples", read()).toString(2) }
    private fun read(): JSONArray = if (file.exists()) JSONArray(file.readText()) else JSONArray()
    companion object {
        private val lock = Any()
        private val counters = setOf("capturedCount", "blockedCount", "failedCount", "uploadBytes")
        private val timings = setOf("inferenceMs", "ocrMs")
        private fun bytes(file: File): Long = if (file.isDirectory) file.listFiles()?.sumOf { bytes(it) } ?: 0 else file.length()
        fun battery(context: Context): Pair<Int, Boolean> {
            val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
            val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            return (if (level >= 0 && scale > 0) level * 100 / scale else -1) to
                (status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
        }
    }
}
