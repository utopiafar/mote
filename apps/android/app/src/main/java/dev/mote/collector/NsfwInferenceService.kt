package dev.mote.collector

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.Process
import android.os.SharedMemory
import org.json.JSONObject

/** Native crashes/hangs are confined to :nsfw. Image bytes stay in memory. */
class NsfwInferenceService : Service() {
    private val lock = Any()
    private var handle = 0L
    private var sessionThreads = 0
    private var destroyed = false
    private lateinit var store: NsfwModelStore
    override fun onCreate() { super.onCreate(); store = NsfwModelStore(this) }
    override fun onBind(intent: Intent): IBinder = binder
    private val binder = object : INsfwService.Stub() {
        override fun processId(): Int = Process.myPid()
        override fun review(image: SharedMemory, threads: Int, maxTokens: Int, policy: String): String = synchronized(lock) {
            try {
                check(!destroyed); NsfwConfig(threads = threads, policy = policy, maxTokens = maxTokens).validate()
                require(image.size in 1..12*1024*1024)
                if (handle == 0L || sessionThreads != threads) {
                    if (handle != 0L) { NativeVlm.release(handle); handle = 0L }
                    val paths = store.verifiedFiles() // Full SHA-256 on both files before every native load.
                    handle = NativeVlm.load(paths.getValue("language").absolutePath, paths.getValue("vision").absolutePath, threads)
                    check(handle != 0L); sessionThreads = threads
                }
                val mapped = image.mapReadOnly()
                val bytes = ByteArray(image.size)
                try { mapped.get(bytes) } finally { SharedMemory.unmap(mapped) }
                val system = assets.open("review-system.txt").bufferedReader().use { it.readText().trim() }
                val grammar = assets.open("review-grammar.gbnf").bufferedReader().use { it.readText() }
                val result = JSONObject(NativeVlm.run(handle, bytes, system, policy, maxTokens, grammar))
                check(result.getString("status") == "eos") { MoteI18n.text("模型输出被截断") }
                val decision = result.getString("text")
                ReviewDecision.parse(decision)
                result.toString()
            } catch (_: Exception) { throw IllegalStateException(MoteI18n.text("本机 Qwen 审查失败，请重新加载模型")) }
            finally { image.close() }
        }
    }
    override fun onDestroy() {
        Thread { synchronized(lock) { destroyed = true; if (handle != 0L) NativeVlm.release(handle); handle = 0L } }.start()
        super.onDestroy()
    }
}
