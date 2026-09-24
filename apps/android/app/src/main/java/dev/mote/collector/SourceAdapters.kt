package dev.mote.collector

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.CancellationSignal
import java.time.Instant
import org.json.JSONObject

enum class SourceQueueKind { INDEXED, FILE_ARCHIVE }

sealed interface SourceEmission {
    val version: Int
    data class Indexed(val scan: SourceScan, override val version: Int = 1) : SourceEmission
    data class Archived(val complete: Boolean, override val version: Int = 1) : SourceEmission
}

/** The adapter only reads. WorkManager, privacy validation, outboxes and ACKs stay in the host. */
interface SourceAdapter {
    val kind: String
    val version: Int
    val queueKind: SourceQueueKind
    fun validateConfiguration(source: LocalSource)
    fun available(context: Context, source: LocalSource): Boolean
    fun lastScan(context: Context, source: LocalSource): String
    fun scan(context: Context, source: LocalSource, cancellation: CancellationSignal): SourceEmission
}

object SourcePrivacyGate {
    fun validate(source: LocalSource, item: JSONObject) {
        val layer = item.getString("layer")
        require(layer in setOf("reference", "snapshot", "original")) { "Invalid source layer" }
        if (source.retention == "reference") require(layer == "reference" && item.optString("text").isEmpty()) { "Reference source emitted content" }
        if (source.retention != "archive") require(layer != "original") { "Source emitted an unauthorized original" }
    }
}

class SourceAdapterRegistry(adapters: List<SourceAdapter> = emptyList()) {
    private val entries = linkedMapOf<String, SourceAdapter>()
    init { adapters.forEach(::register) }
    fun register(adapter: SourceAdapter): SourceAdapterRegistry {
        require(adapter.kind.matches(Regex("[a-z][a-z0-9-]{0,63}(?:\\.[a-z][a-z0-9-]{0,63})*")) && adapter.version > 0 && adapter.kind !in entries) { "Invalid or duplicate source adapter" }
        entries[adapter.kind] = adapter
        return this
    }
    fun forKind(kind: String): SourceAdapter = requireNotNull(entries[kind]) { "Source adapter unavailable: $kind" }
    fun scan(context: Context, source: LocalSource, cancellation: CancellationSignal): SourceEmission {
        val emission = forKind(source.kind).scan(context, source, cancellation)
        require(emission.version == 1) { "Unsupported source emission version" }
        require((forKind(source.kind).queueKind == SourceQueueKind.INDEXED) == (emission is SourceEmission.Indexed)) { "Source adapter emitted the wrong queue kind" }
        if (emission is SourceEmission.Indexed) emission.scan.items.forEach { SourcePrivacyGate.validate(source, it) }
        return emission
    }
}

object SourceAdapters {
    val default = SourceAdapterRegistry()
        .register(object : SourceAdapter {
            override val kind = "local-calendar"
            override val version = 1
            override val queueKind = SourceQueueKind.INDEXED
            override fun validateConfiguration(source: LocalSource) {
                require(source.calendarId != null && source.calendarId >= 0 && source.retention != "archive") { "Invalid calendar source" }
            }
            override fun available(context: Context, source: LocalSource) = context.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED
            override fun lastScan(context: Context, source: LocalSource) = context.localSources().state(source.id).optString("lastScan")
            override fun scan(context: Context, source: LocalSource, cancellation: CancellationSignal): SourceEmission =
                SourceEmission.Indexed(SourceProviders(context.contentResolver, cancellation).scan(source, Instant.now()))
        })
        .register(object : SourceAdapter {
            override val kind = "local-files"
            override val version = 1
            override val queueKind = SourceQueueKind.FILE_ARCHIVE
            override fun validateConfiguration(source: LocalSource) {
                require(source.uri != null && source.uri.startsWith("content://") && !source.uri.contains('?') && !source.uri.contains('#')) { MoteI18n.text("需要系统选择器提供的持久文件权限") }
            }
            override fun available(context: Context, source: LocalSource) = context.contentResolver.persistedUriPermissions.any { it.isReadPermission && it.uri.toString() == source.uri }
            override fun lastScan(context: Context, source: LocalSource) = context.fileArchives().state(source.id).optString("lastScan")
            override fun scan(context: Context, source: LocalSource, cancellation: CancellationSignal): SourceEmission =
                SourceEmission.Archived(FileSources(context, cancellation).scan(source))
        })
}
