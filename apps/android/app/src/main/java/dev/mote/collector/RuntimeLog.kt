package dev.mote.collector

import java.io.File
import java.io.FileOutputStream
import java.time.Instant

/** Original runtime log, separate from transport payloads and opt-in diagnostic samples. */
class RuntimeLog(private val file: File, private val limit: Int = 1000) {
    init { require(limit in 1..1000) }
    fun event(stage: EventStage, code: EventCode, elapsedMs: Long? = null, httpStatus: Int? = null) =
        append(EventJournal.level(code), stage.name, code.name, elapsedMs, httpStatus)
    fun operation(kind: OperationKind, reason: OperationReason) =
        append(when (kind) {
            OperationKind.CAPTURE_FAILED, OperationKind.HEARTBEAT_FAILED, OperationKind.SOURCE_FAILED, OperationKind.CONNECTION_FAILED,
            OperationKind.ACTIVITY_FAILED, OperationKind.MEDIA_FAILED -> "error"
            else -> if (reason == OperationReason.NONE || reason == OperationReason.ACK) "info" else "warn"
        }, "OPERATION", "${kind.name} reason=${reason.name}")
    private fun append(level: String, logger: String, message: String, elapsedMs: Long? = null, httpStatus: Int? = null) = synchronized(lock) {
        // Callers can supply enums and numbers only. Never persist captured content, tokens or exception text.
        val line = buildString {
            append(Instant.now()).append(' ').append(level.uppercase().padEnd(5))
            append(" [thread-").append(Thread.currentThread().id).append("] ").append(logger).append(" - ").append(message)
            elapsedMs?.takeIf { it >= 0 }?.let { append(" elapsedMs=").append(it) }
            httpStatus?.takeIf { it in 100..599 }?.let { append(" httpStatus=").append(it) }
        }
        file.parentFile!!.mkdirs()
        val key = file.absolutePath
        val count = if (file.exists()) counts.getOrPut(key) { file.useLines { it.count() } } else 0
        if (count < limit) { FileOutputStream(file, true).use { it.write((line + "\n").toByteArray()) }; counts[key] = count + 1 }
        else {
            File(file.parentFile, "${file.name}.6").delete()
            for (i in 5 downTo 1) { val prior = File(file.parentFile, "${file.name}.$i"); if (prior.exists()) check(prior.renameTo(File(file.parentFile, "${file.name}.${i + 1}"))) }
            check(file.renameTo(File(file.parentFile, "${file.name}.1")))
            FileOutputStream(file).use { it.write((line + "\n").toByteArray()); it.fd.sync() }; counts[key] = 1
        }
    }
    fun exportRange(after: Long, before: Long = System.currentTimeMillis()): org.json.JSONObject = synchronized(lock) {
        val retained = (6 downTo 0).flatMap { index -> val path = if (index == 0) file else File(file.parentFile, "${file.name}.$index"); if (!path.exists()) emptyList() else { check(path.length() <= 512 * 1024); path.readLines() } }
        val dated = retained.mapNotNull { line -> runCatching { Instant.parse(line.substringBefore(' ')).toEpochMilli() to line }.getOrNull() }
        org.json.JSONObject().put("after", Instant.ofEpochMilli(after)).put("before", Instant.ofEpochMilli(before)).put("oldestRetainedAt", dated.minOfOrNull { it.first }?.let { Instant.ofEpochMilli(it).toString() } ?: org.json.JSONObject.NULL).put("retentionLimited", dated.isEmpty() || dated.minOf { it.first } > after).put("text", dated.filter { it.first >= after && it.first < before }.joinToString("\n") { it.second })
    }
    fun readRaw(): String = synchronized(lock) { if (!file.exists()) "" else { check(file.length() <= 512 * 1024); file.readText() } }
    companion object {
        private val lock = Any()
        private val counts = object : LinkedHashMap<String, Int>(8, .75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Int>?) = size > 8
        }
    }
}
