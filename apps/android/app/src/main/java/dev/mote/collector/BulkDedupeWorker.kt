package dev.mote.collector

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.work.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.time.Instant

/** Only encrypted metadata is persisted; pixels live in bounded worker-local buffers. */
class BulkDedupeStore(context: Context) {
    private val dir = File(context.noBackupFilesDir, "bulk-dedupe").apply { check(isDirectory || mkdirs()) }
    private val cipher = SecretBox()
    fun quarantine() = DurableQueue(File(dir, "pending"), cipher)
    @Synchronized fun read(name: String): JSONObject {
        require(name in listOf("report", "plan"))
        val file = File(dir, "$name.enc")
        return if (file.exists()) JSONObject(String(cipher.open(file.readBytes()), Charsets.UTF_8)) else JSONObject()
    }
    @Synchronized fun write(name: String, value: JSONObject) {
        require(name in listOf("report", "plan"))
        val temp = File.createTempFile("state", ".tmp", dir)
        try {
            FileOutputStream(temp).use { it.write(cipher.seal(value.toString().toByteArray())); it.fd.sync() }
            check(temp.renameTo(File(dir, "$name.enc")))
        } finally { temp.delete() }
    }
}

object BulkDedupeRules {
    fun features(bytes: ByteArray, mode: ScreenshotDedupeHelper.Mode): ScreenshotDedupeHelper.FrameFeatures {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= minOf(32_000_000L, Runtime.getRuntime().maxMemory() / 16)) { "图片尺寸无效或过大" }
        val size = ScreenshotDedupeHelper.sampleSizeForMode(bounds.outWidth, bounds.outHeight, mode)
        // Match the capture pipeline's single filtered resize. Decoder subsampling can
        // erase localized differences before the shared thresholds inspect them.
        val bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
        val sample = Bitmap.createScaledBitmap(bitmap, size.width, size.height, true)
        try {
            val pixels = IntArray(size.width * size.height)
            sample.getPixels(pixels, 0, size.width, 0, 0, size.width, size.height)
            return ScreenshotDedupeHelper.buildFeatures(size.width, size.height, pixels)
                .copy(width = bounds.outWidth, height = bounds.outHeight)
        } finally { if (sample !== bitmap) sample.recycle(); bitmap.recycle() }
    }
}

class BulkDedupeWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    companion object { const val NAME = "mote-bulk-dedupe" }
    private val store = BulkDedupeStore(context)
    private fun progress(stage: String, done: Int, total: Int, found: Int = 0, errors: Int = 0) {
        setProgressAsync(workDataOf("stage" to stage, "done" to done, "total" to total, "found" to found, "errors" to errors)).get()
    }
    override fun doWork(): Result = try {
        if (inputData.getString("action") == "scan") scan() else resolve()
    } catch (error: Exception) {
        Result.failure(workDataOf("message" to (error.message ?: "操作失败，未处理记录已保留")))
    }
    private fun scan(): Result {
        val mode = ScreenshotDedupeHelper.Mode.fromRaw(inputData.getString("mode"))
        store.write("report", JSONObject().put("complete", false))
        val queue = applicationContext.queue()
        val ids = queue.dedupeIds(); val rows = mutableListOf<JSONObject>(); var errors = 0
        ids.forEachIndexed { index, id ->
            if (isStopped) return Result.failure()
            try { queue.dedupeRow(id)?.takeIf { it.optString("source") == "screen" && it.optBoolean("hasImage") }?.let(rows::add) } catch (_: Exception) { errors++ }
            if (index % 10 == 0) progress("读取目录", index + 1, ids.size, errors = errors)
        }
        rows.sortWith(compareBy<JSONObject> { Instant.parse(it.getString("capturedAt")) }.thenBy { it.getString("id") })
        val pairs = JSONArray(); var reference: JSONObject? = null; var signature: String? = null
        rows.forEachIndexed { index, row ->
            if (isStopped) return Result.failure()
            try {
                val bytes = queue.image(row.getString("id")) ?: error("图片已离开本机")
                val features = BulkDedupeRules.features(bytes, mode)
                val previous = reference
                val comparison = if (previous != null && previous.optString("appId") == row.optString("appId")) ScreenshotDedupeHelper.shouldSkip(signature, features, mode) else null
                if (comparison?.duplicate == true) {
                    pairs.put(JSONObject().put("reference", previous).put("candidate", row).put("bytes", bytes.size)
                        .put("reason", comparison.reason).put("hashDistance", comparison.hashDistance)
                        .put("changedPixelRatio", comparison.changedPixelRatio).put("changedBlocks", comparison.changedBlocks)
                        .put("changedRows", comparison.changedRows).put("changedCols", comparison.changedCols))
                } else { reference = row; signature = features.toSignature() }
            } catch (_: Exception) { errors++; reference = null; signature = null }
            if (index % 5 == 0 || index == rows.lastIndex) progress("比较图片", index + 1, rows.size, pairs.length(), errors)
        }
        if (isStopped) return Result.failure()
        store.write("report", JSONObject().put("complete", true).put("mode", mode.rawValue).put("comparison", "last_retained")
            .put("scanned", rows.size).put("errors", errors).put("pairs", pairs).put("at", Instant.now().toString()))
        return Result.success(workDataOf("message" to "扫描完成：${rows.size} 张，${pairs.length()} 张候选，$errors 张跳过或读取失败"))
    }
    private fun resolve(): Result {
        val action = inputData.getString("action")!!
        require(action in listOf("move", "delete", "restore", "purge"))
        val plan = store.read("plan"); require(plan.getString("job") == inputData.getString("job"))
        val items = plan.getJSONArray("items"); val pending = store.quarantine(); val queue = applicationContext.queue()
        pending.recoverOrphans()
        val restoreLimit = Settings(applicationContext).read().maxQueueMiB * 1024L * 1024L
        var done = 0; var skipped = 0
        for (index in 0 until items.length()) {
            if (isStopped) return Result.failure()
            val pair = items.getJSONObject(index); val row = pair.getJSONObject("candidate"); val ref = pair.optJSONObject("reference")
            try {
                val source = if (action in listOf("restore", "purge")) pending else queue
                val target = when (action) { "move" -> pending; "restore" -> queue; else -> null }
                val ok = source.resolveDedupe(row.getString("id"), row.getString("blob"),
                    if (source === queue) ref!!.getString("id") else null, ref?.getString("blob"), target, if (action == "restore") restoreLimit else Long.MAX_VALUE)
                if (ok) done++ else skipped++
            } catch (_: Exception) { skipped++ }
            progress("处理记录", index + 1, items.length(), done, skipped)
        }
        return Result.success(workDataOf("message" to "处理完成：成功 $done，失效或失败 $skipped；失败记录保留，可重新扫描或重试"))
    }
}
