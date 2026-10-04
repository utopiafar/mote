package dev.mote.collector

import android.content.Context
import java.io.File
import java.io.FileOutputStream

/** Breaking local boundary: preserve retired files and require an explicit app-storage reset. */
object LocalDataFormat {
    const val VERSION = 3
    const val RESET_MESSAGE = "本机数据格式已退役，请清除应用存储后重新设置。"
    private const val MARKER = ".mote-local-format"
    // WorkManager opens these framework files before Application.onCreate on a fresh install.
    internal val FRAMEWORK_FILES = setOf("androidx.work.workdb", "androidx.work.workdb-shm", "androidx.work.workdb-wal", "androidx.work.workdb-journal")
    @Synchronized fun requireCurrent(directory: File, hasConfiguration: Boolean = false, ignoredFiles: Set<String> = emptySet()) {
        val marker = File(directory, MARKER)
        if (marker.exists()) {
            check(marker.isFile && marker.readText() == VERSION.toString()) { MoteI18n.text(RESET_MESSAGE) }
            return
        }
        check(!hasConfiguration && directory.listFiles().orEmpty().all { it.isFile && it.name in ignoredFiles }) { MoteI18n.text(RESET_MESSAGE) }
        check(directory.isDirectory || directory.mkdirs())
        FileOutputStream(marker).use { it.write(VERSION.toString().toByteArray()); it.fd.sync() }
    }
    fun requireCurrent(context: Context) = requireCurrent(context.applicationContext.noBackupFilesDir,
        context.applicationContext.getSharedPreferences("mote", Context.MODE_PRIVATE).all.isNotEmpty(), FRAMEWORK_FILES)
    fun validateEvent(event: org.json.JSONObject) {
        require(event.keys().asSequence().none { it in setOf("_ocrResult", "_ocrUploaded", "_ocrAttempts", "_ocrConflict") }) { MoteI18n.text(RESET_MESSAGE) }
        require(event.optJSONObject("ocr")?.optString("status") != "pending") { MoteI18n.text(RESET_MESSAGE) }
    }
}
