package dev.mote.collector

import androidx.work.NetworkType
import java.net.URI
import java.util.Locale

/** Internet validation is not a prerequisite for local transport or an explicit HTTP attempt. */
object SyncNetworkPolicy {
    fun requiredNetworkType(server: String, wifiOnly: Boolean, explicit: Boolean = false): NetworkType = when {
        explicit || isLiteralLoopback(server) -> NetworkType.NOT_REQUIRED
        wifiOnly -> NetworkType.UNMETERED
        else -> NetworkType.CONNECTED
    }

    private fun isLiteralLoopback(server: String): Boolean = runCatching {
        val uri = URI(server.trim())
        uri.scheme in setOf("http", "https") &&
            uri.host?.lowercase(Locale.ROOT) in setOf("localhost", "127.0.0.1", "::1", "[::1]") &&
            uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
            (uri.path.isNullOrEmpty() || uri.path == "/") && (uri.port == -1 || uri.port in 1..65535)
    }.getOrDefault(false)
}
