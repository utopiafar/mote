package dev.mote.collector

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Bitmap
import android.os.IBinder
import android.os.Process
import android.os.SharedMemory
import android.system.OsConstants
import java.io.IOException
import java.io.ByteArrayOutputStream
import org.json.JSONObject
import java.util.concurrent.*

class NsfwUnavailable(message: String) : IOException(message)

class NsfwClient(context: Context) : AutoCloseable {
    private val context = context.applicationContext
    private val store = NsfwModelStore(context)
    private val lock = Any()
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var connection: Connection? = null
    @Volatile private var closed = false
    init { clients.add(this) }
    fun check(bitmap: Bitmap, config: NsfwConfig): ReviewDecision {
        config.validate()
        check(!closed)
        if (!store.hasFile()) throw NsfwUnavailable("Qwen 本机审查 模型未就绪；请先下载/导入，当前帧不采集")
        val started = System.nanoTime()
        val result = executor.submit<String> {
            val active = connect()
            val scale = minOf(1.0, config.reviewMaxSide.toDouble() / maxOf(bitmap.width, bitmap.height))
            val small = if (scale < 1.0) Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width*scale).toInt()), maxOf(1, (bitmap.height*scale).toInt()), true) else bitmap
            val bytes = try { ByteArrayOutputStream().use { check(small.compress(Bitmap.CompressFormat.PNG, 100, it)); it.toByteArray() } }
                finally { if (small !== bitmap) small.recycle() }
            val shared = SharedMemory.create("mote-qwen-image", bytes.size)
            try {
                val mapped = shared.mapReadWrite()
                try { mapped.put(bytes) } finally { SharedMemory.unmap(mapped) }
                check(shared.setProtect(OsConstants.PROT_READ))
                active.service!!.review(shared, config.threads, config.maxTokens, config.policy)
            } finally { shared.close() }
        }
        return try {
            val native = JSONObject(result.get(config.timeoutMs, TimeUnit.MILLISECONDS))
            val decision = ReviewDecision.parse(native.getString("text"))
            store.inferenceStatus("Qwen CPU 已审查 · %.0f ms · %s\n加载 %d / 图像预填 %d / 解码 %d ms · %d token".format((System.nanoTime() - started) / 1_000_000.0, if (decision.allow) "当前帧通过" else "当前帧已过滤", native.optLong("loadMs"), native.optLong("visionPrefillMs"), native.optLong("decodeMs"), native.optInt("tokens")))
            decision
        } catch (_: Exception) {
            result.cancel(true)
            reset()
            store.inferenceStatus("Qwen 本机审查 超时、进程退出或模型错误：已中止当前帧，下次重建推理进程")
            throw NsfwUnavailable("本机 Qwen 审查不可用，当前帧未进入 OCR/保存/上传；下一周期重试")
        }
    }
    private fun connect(): Connection {
        check(!closed)
        var create = false
        val active = synchronized(lock) {
            connection?.takeIf { !it.dead } ?: Connection().also { connection = it; create = true }
        }
        if (create) {
            active.bound = context.bindService(Intent(context, NsfwInferenceService::class.java), active, Context.BIND_AUTO_CREATE)
            if (!active.bound) { disconnect(active); throw NsfwUnavailable("无法绑定 Qwen 本机审查 推理进程") }
        }
        if (!active.ready.await(10, TimeUnit.SECONDS) || active.dead || active.service == null || closed) {
            disconnect(active); throw NsfwUnavailable("Qwen 本机审查 进程连接中断或超时")
        }
        active.pid = active.service!!.processId()
        return active
    }
    fun reset() {
        val active = connection ?: return
        // Only the private service PID from our non-exported Binder, never this process.
        if (active.pid > 0 && active.pid != Process.myPid()) {
            Process.killProcess(active.pid)
            val deadline = System.nanoTime() + 2_000_000_000L
            while (active.binder?.isBinderAlive == true && System.nanoTime() < deadline) android.os.SystemClock.sleep(10)
        }
        disconnect(active)
    }
    private fun disconnect(active: Connection) {
        synchronized(lock) { active.dead = true; active.ready.countDown(); if (connection === active) connection = null }
        active.binder?.let { runCatching { it.unlinkToDeath(active.death, 0) } }
        if (active.bound) { active.bound = false; runCatching { context.unbindService(active) } }
    }
    override fun close() { closed = true; reset(); executor.shutdownNow(); clients.remove(this) }
    private inner class Connection : ServiceConnection {
        val ready = CountDownLatch(1)
        @Volatile var service: INsfwService? = null
        @Volatile var binder: IBinder? = null
        @Volatile var dead = false
        @Volatile var bound = false
        @Volatile var pid = 0
        val death = IBinder.DeathRecipient { disconnect(this) }
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            if (closed || dead) { disconnect(this); return }
            this.binder = binder
            service = INsfwService.Stub.asInterface(binder)
            try { binder.linkToDeath(death, 0) } catch (_: Exception) { dead = true }
            ready.countDown()
        }
        override fun onServiceDisconnected(name: ComponentName) { disconnect(this) }
        override fun onBindingDied(name: ComponentName) { disconnect(this) }
        override fun onNullBinding(name: ComponentName) { disconnect(this) }
    }
    companion object {
        private val clients = ConcurrentHashMap.newKeySet<NsfwClient>()
        fun resetAll() { clients.forEach { it.reset() } }
    }
}
