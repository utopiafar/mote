package dev.mote.collector

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/** Measured platform facts only; unavailable fields are omitted, never inferred from content. */
object CollectorMetadata {
    fun snapshot(context: Context, method: String, intervalMs: Long? = null, activityOnly: Boolean = false): JSONObject {
        val root = JSONObject().put("version", 1).put("observedAt", Instant.now().toString())
            .put("collector", JSONObject().put("version", BuildConfig.VERSION_NAME).put("method", method))
        val device = JSONObject()
        fun value(key: String, raw: String?) { raw?.takeIf { it.isNotBlank() && it != Build.UNKNOWN }?.let { device.put(key, it.take(200)) } }
        value("osVersion", Build.VERSION.RELEASE); value("osBuild", Build.DISPLAY)
        value("manufacturer", Build.MANUFACTURER); value("model", Build.MODEL)
        value("architecture", Build.SUPPORTED_ABIS.firstOrNull()); value("locale", Locale.getDefault().toLanguageTag())
        runCatching { value("timeZone", ZoneId.systemDefault().id) }
        root.put("device", device)
        val state = JSONObject()
        runCatching {
            val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            battery?.let {
                val level = it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1); val scale = it.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
                if (scale > 0 && level in 0..scale) state.put("batteryPercent", level * 100.0 / scale)
                when (it.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)) {
                    BatteryManager.BATTERY_STATUS_CHARGING -> state.put("charging", true)
                    BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> state.put("charging", false)
                }
                val plugged = it.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)
                if (plugged >= 0) state.put("onBattery", plugged == 0)
            }
        }
        runCatching {
            val power = context.getSystemService(PowerManager::class.java)
            state.put("powerSave", power.isPowerSaveMode).put("screenInteractive", power.isInteractive)
                .put("thermalState", when (power.currentThermalStatus) {
                    PowerManager.THERMAL_STATUS_NONE -> "nominal"
                    PowerManager.THERMAL_STATUS_LIGHT -> "fair"
                    PowerManager.THERMAL_STATUS_MODERATE, PowerManager.THERMAL_STATUS_SEVERE -> "serious"
                    PowerManager.THERMAL_STATUS_CRITICAL, PowerManager.THERMAL_STATUS_EMERGENCY, PowerManager.THERMAL_STATUS_SHUTDOWN -> "critical"
                    else -> "unknown"
                })
        }
        runCatching { state.put("screenLocked", context.getSystemService(KeyguardManager::class.java).isKeyguardLocked) }
        runCatching {
            val network = context.getSystemService(ConnectivityManager::class.java)
            val active = network.activeNetwork
            val caps = active?.let(network::getNetworkCapabilities)
            state.put("networkType", when {
                active == null -> "none"; caps == null -> "unknown"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "other"
            })
            if (caps != null) state.put("networkMetered", !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
        }
        runCatching { state.put("availableStorageBytes", context.noBackupFilesDir.usableSpace.coerceAtLeast(0)) }
        root.put("state", state)
        root.put("media", MediaCollection.snapshot(context, activityOnly))
        if (intervalMs != null) root.put("capture", JSONObject().put("intervalMs", intervalMs))
        return root
    }
    fun appName(context: Context, id: String): String = runCatching {
        val info = context.packageManager.getApplicationInfo(id, 0)
        context.packageManager.getApplicationLabel(info).toString().trim().take(200).ifBlank { "未知应用" }
    }.getOrDefault("未知应用")
}
