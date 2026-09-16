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
            val lines = file.readLines().takeLast((limit * 3 / 4).coerceAtMost(limit - 1)) + line
            val temp = File(file.parentFile, "${file.name}.tmp")
            try { FileOutputStream(temp).use { it.write(lines.joinToString("\n", postfix = "\n").toByteArray()); it.fd.sync() }; check(temp.renameTo(file)); counts[key] = lines.size }
            finally { temp.delete() }
        }
    }
    fun readRaw(): String = synchronized(lock) { if (!file.exists()) "" else { check(file.length() <= 512 * 1024); file.readText() } }
    companion object {
        private val lock = Any()
        private val counts = object : LinkedHashMap<String, Int>(8, .75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Int>?) = size > 8
        }
    }
}
