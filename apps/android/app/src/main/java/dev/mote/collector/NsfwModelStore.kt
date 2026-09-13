package dev.mote.collector

import android.content.Context
import org.json.JSONObject
import java.io.*
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

data class NsfwModelFile(val role: String, val fileName: String, val size: Long, val sha256: String, val mirror: String, val official: String)
data class NsfwManifest(val id: String, val revision: String, val totalBytes: Long, val files: List<NsfwModelFile>) {
    companion object {
        fun parse(json: JSONObject): NsfwManifest {
            val array = json.getJSONArray("files")
            val files = List(array.length()) { index ->
                val item = array.getJSONObject(index)
                NsfwModelFile(item.getString("role"), item.getString("fileName"), item.getLong("size"), item.getString("sha256"),
                    item.getJSONObject("urls").getString("mirror"), item.getJSONObject("urls").getString("official")).also {
                    require(it.sha256.matches(Regex("[a-f0-9]{64}")) && it.size in 1..2_000_000_000)
                    require(it.fileName in setOf("model.gguf", "mmproj.gguf"))
                    NsfwConfig.validateModelUrl(it.mirror); NsfwConfig.validateModelUrl(it.official)
                }
            }
            return NsfwManifest(json.getString("id"), json.getString("revision"), json.getLong("totalBytes"), files).also {
                require(it.revision.matches(Regex("[a-f0-9]{40}")))
                require(files.size == 2 && files.map { file -> file.role }.toSet() == setOf("language", "vision"))
                require(files.map { file -> file.fileName }.toSet().size == 2 && files.sumOf { file -> file.size } == it.totalBytes)
            }
        }
    }
}

/** Downloads public model bytes only. Screenshots never enter this store or any network request. */
class NsfwModelStore(context: Context) {
    val manifest = context.assets.open("qwen-manifest.json").bufferedReader().use { NsfwManifest.parse(JSONObject(it.readText())) }
    val directory = File(context.noBackupFilesDir, "models/qwen/${manifest.revision}").apply { mkdirs() }
    fun target(file: NsfwModelFile) = File(directory, file.fileName)
    private val prefs = context.getSharedPreferences("nsfw_status", Context.MODE_PRIVATE)
    @Volatile private var connection: HttpURLConnection? = null
    private val cancelled = AtomicBoolean(false)
    fun status(message: String) { prefs.edit().putString("modelStatus", message).apply() }
    fun status(): String = prefs.getString("modelStatus", null) ?: if (hasFile()) "模型文件已存在，加载时会重新核对 SHA-256" else "尚未下载完整双模型 · 启用本机审查时不会采集"
    fun inferenceStatus(message: String) { prefs.edit().putString("inferenceStatus", message).apply() }
    fun inferenceStatus(): String = prefs.getString("inferenceStatus", "推理尚未启动")!!
    fun hasFile(): Boolean = manifest.files.all { target(it).isFile && target(it).length() == it.size }
    fun verifiedFiles(): Map<String, File> {
        check(hasFile()) { "请先下载或导入语言模型和视觉投影模型" }
        return manifest.files.associate { file ->
            check(sha256(target(file)) == file.sha256) { "模型 SHA-256 不匹配，请重新下载" }
            file.role to target(file)
        }
    }
    fun cancel() { cancelled.set(true); connection?.disconnect() }
    fun download(config: NsfwConfig): Unit = modelLock {
        config.validate()
        for (file in manifest.files) {
        if (target(file).length() == file.size && sha256(target(file)) == file.sha256) continue
        val urls = when (config.source) { "mirror" -> listOf(file.mirror); "official" -> listOf(file.official); "custom" -> listOf(config.customUrl.trimEnd('/') + "/" + file.fileName); else -> listOf(file.mirror, file.official) }
        var last: Exception? = null
        for ((index, url) in urls.withIndex()) {
            try { downloadOne(url, file); last = null; break }
            catch (error: Exception) {
                if (cancelled.get()) throw InterruptedIOException("下载已取消，断点保留")
                last = error
                status(if (index + 1 < urls.size) "当前来源失败，保留断点并尝试下一来源" else "下载未完成，保留断点并等待重试")
            }
        }
        if (last != null) throw last
        }
        status("双模型已通过 SHA-256 校验，可断网推理")
    }
    private fun downloadOne(source: String, file: NsfwModelFile) {
        val target = target(file)
        val part = File(directory, "${file.fileName}.part")
        if (part.length() > file.size) part.delete()
        var offset = part.length()
        if (offset < file.size) {
            var current = URL(NsfwConfig.validateModelUrl(source).toString())
            var redirects = 0
            while (true) {
                if (cancelled.get()) throw InterruptedIOException()
                val request = current.openConnection() as HttpURLConnection
                connection = request
                request.connectTimeout = 20000; request.readTimeout = 20000; request.instanceFollowRedirects = false
                request.setRequestProperty("Accept-Encoding", "identity")
                request.setRequestProperty("User-Agent", "Mote/0.2 Android model downloader")
                if (offset > 0) request.setRequestProperty("Range", "bytes=$offset-")
                try {
                    val code = request.responseCode
                    if (code in setOf(301, 302, 303, 307, 308)) {
                        require(++redirects <= 5) { "模型下载重定向次数过多" }
                        current = URL(current, request.getHeaderField("Location") ?: throw IOException("模型重定向缺少地址"))
                        NsfwConfig.validateModelUrl(current.toString()); continue
                    }
                    require(code in setOf(200, 206)) { "模型下载 HTTP $code" }
                    if (code == 206) validateRange(request.getHeaderField("Content-Range"), offset, file.size) else offset = 0
                    check(directory.usableSpace >= file.size - offset + 32L * 1024 * 1024) { "空间不足，请预留模型大小及 32 MiB" }
                    FileOutputStream(part, offset > 0).use { out ->
                        request.inputStream.use { input ->
                            val buffer = ByteArray(128 * 1024); var count = offset; var last = 0L
                            while (true) {
                                if (cancelled.get()) throw InterruptedIOException()
                                val length = input.read(buffer); if (length < 0) break
                                count += length; check(count <= file.size) { "下载大小超过固定清单" }
                                out.write(buffer, 0, length)
                                val now = System.nanoTime()
                                if (now - last > 250_000_000L) { last = now; status("${file.fileName} 下载 %.1f / %.1f MiB · %d%%".format(count / 1048576.0, file.size / 1048576.0, count * 100 / file.size)) }
                            }
                            out.fd.sync()
                        }
                    }
                    break
                } finally { request.disconnect(); connection = null }
            }
        }
        check(part.length() == file.size) { "模型下载未完整，断点保留" }
        status("正在核对模型 SHA-256…")
        if (sha256(part) != file.sha256) { part.delete(); throw IOException("模型 SHA-256 不符，已清除损坏断点") }
        if (cancelled.get()) throw InterruptedIOException()
        check(part.renameTo(target)) { "模型校验通过但保存失败" }
        status("模型已下载并通过 SHA-256 校验，可断网运行")
    }
    fun importModel(input: InputStream) = modelLock {
        val incoming = File(directory, "import.part")
        try {
            status("导入并校验固定模型…")
            FileOutputStream(incoming).use { out ->
                val buffer = ByteArray(128 * 1024); var total = 0L
                while (true) {
                    val count = input.read(buffer); if (count < 0) break
                    total += count; check(total <= manifest.files.maxOf { it.size }) { "导入文件超过固定模型大小" }; out.write(buffer, 0, count)
                }
                out.fd.sync()
            }
            val hash = sha256(incoming)
            val file = manifest.files.singleOrNull { it.size == incoming.length() && it.sha256 == hash }
                ?: error("导入文件不是清单指定的语言/视觉模型（大小/SHA-256 不符）")
            check(incoming.renameTo(target(file))) { "无法保存导入模型" }
            status("${file.fileName} 导入成功、SHA-256 通过；" + if (hasFile()) "双模型已齐备" else "请继续导入另一个模型")
        } finally { incoming.delete() }
    }
    private fun <T> modelLock(action: () -> T): T = synchronized(downloadLock) {
        RandomAccessFile(File(directory, "writer.lock"), "rw").use { file -> file.channel.use { channel -> channel.lock().use { action() } } }
    }
    companion object {
        private val downloadLock = Any()
        fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().buffered().use { input ->
                val buffer = ByteArray(128 * 1024)
                while (true) { val length = input.read(buffer); if (length < 0) break; digest.update(buffer, 0, length) }
            }
            return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        }
        fun validateRange(value: String?, offset: Long, total: Long) {
            val match = Regex("bytes (\\d+)-(\\d+)/(\\d+)").matchEntire(value ?: "") ?: throw IOException("无效 Content-Range")
            val (start, end, size) = match.destructured
            require(start.toLong() == offset && size.toLong() == total && end.toLong() in offset until total) { "断点响应与清单不匹配" }
        }
    }
}
