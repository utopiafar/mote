package dev.mote.collector

/**
 * The Library page reads captures and sources independently. Each read reports
 * its local and Central outcome here, so the page publishes at most one Central
 * status and only claims emptiness for the current filter after the local
 * reads that can contribute rows have finished. A newer [begin] invalidates
 * reports that still belong to an older page or filter.
 */
internal class LibraryReadState {
    enum class Stream { CAPTURES, SOURCES }
    enum class Central { PENDING, READABLE, SIGNED_OUT, DENIED, OFFLINE, FAILED, SKIPPED }

    data class Failure(val state: Central, val message: String)

    private data class Local(val settled: Boolean = false, val failed: Boolean = false, val message: String = "")
    private data class Remote(val state: Central, val message: String = "")

    private var generation = 0
    private var started = false
    private val local = mutableMapOf<Stream, Local>()
    private val remote = mutableMapOf<Stream, Remote>()

    val epoch: Int get() = generation

    fun begin(): Int {
        generation++
        started = true
        local.clear()
        remote.clear()
        return generation
    }

    fun localSettled(value: Int, stream: Stream) = update(value) { local[stream] = Local(settled = true) }
    fun localFailed(value: Int, stream: Stream, message: String) =
        update(value) { local[stream] = Local(settled = true, failed = true, message = message) }

    fun centralPending(value: Int, stream: Stream) = update(value) { remote[stream] = Remote(Central.PENDING) }
    fun centralReadable(value: Int, stream: Stream) = update(value) { remote[stream] = Remote(Central.READABLE) }
    /** No request was made. A skipped retry must not erase a denial or transport failure. */
    fun centralSkipped(value: Int, stream: Stream) = update(value) {
        when (remote[stream]?.state) {
            null, Central.PENDING, Central.READABLE -> remote[stream] = Remote(Central.SKIPPED)
            else -> Unit
        }
    }
    fun centralFailed(value: Int, stream: Stream, failure: Failure) =
        update(value) { remote[stream] = Remote(failure.state, failure.message) }

    private inline fun update(value: Int, block: () -> Unit) {
        if (!started || value != generation) return
        block()
    }

    fun localFinished(): Boolean = started && Stream.values().all { local[it]?.settled == true }
    fun localFailed(): Boolean = local.values.any { it.failed }

    fun centralFinished(): Boolean = started && Stream.values().all { remote[it]?.state?.let { state -> state != Central.PENDING } == true }

    /** One page status: a local read failure hides any secondary Central complaint. */
    fun status(): String {
        local.values.firstOrNull { it.failed && it.message.isNotBlank() }?.let { return it.message }
        local.values.firstOrNull { it.failed }?.let { return MoteI18n.text("资料暂不可读取，请稍后重试。") }
        val states = remote.values
        states.firstOrNull { it.state == Central.SIGNED_OUT }?.let { return MoteI18n.text(SIGNED_OUT) }
        states.firstOrNull { it.state == Central.DENIED && it.message.isNotBlank() }?.let { return it.message }
        states.firstOrNull { it.state == Central.OFFLINE }?.let { return it.message.ifBlank { MoteI18n.text(OFFLINE) } }
        states.firstOrNull { it.state == Central.FAILED && it.message.isNotBlank() }?.let { return it.message }
        return ""
    }

    fun centralUnreadable(): Boolean = remote.values.any {
        it.state == Central.SIGNED_OUT || it.state == Central.DENIED || it.state == Central.OFFLINE || it.state == Central.FAILED
    }

    /**
     * The empty state for the visible scope. [localMore] means a local page can
     * still add rows, and [more] includes Central pages; neither may claim that
     * the whole filter is empty yet.
     */
    /** The unfiltered all-sources empty state while Central is still being read: rows stand in for its words. */
    fun waitingForCentral(location: String, filtered: Boolean) = location != "central" && location != "local" && !filtered && !centralUnreadable() && !centralFinished()
    fun emptyText(location: String, filtered: Boolean, localMore: Boolean, more: Boolean): String? {
        if (!localFinished() || localFailed() || localMore) return null
        val unreadable = centralUnreadable()
        return when (location) {
            "central" -> when {
                unreadable || !centralFinished() || more -> null
                filtered -> MoteI18n.text("当前筛选下没有资料。")
                else -> MoteI18n.text("中央没有资料。")
            }
            "local" -> if (filtered) MoteI18n.text("当前筛选下暂无本机资料。") else MoteI18n.text("本机没有资料。")
            else -> when {
                unreadable -> if (filtered) MoteI18n.text("当前筛选下暂无本机资料。") else MoteI18n.text("本机没有资料。")
                !centralFinished() -> if (filtered) MoteI18n.text("当前筛选下暂无本机资料。") else MoteI18n.text("本机没有资料，正在读取中央…")
                more -> null
                filtered -> MoteI18n.text("当前筛选下没有资料。")
                else -> MoteI18n.text("这里还没有内容。点击添加，选择文件、屏幕或记录。")
            }
        }
    }

    companion object {
        const val SIGNED_OUT = "先登录中央，各页面会共用这次登录"
        const val OFFLINE = "中央暂不可用 · 保留本机状态，恢复连接后重试"

        /** Translate one Central read failure into the single page-level state. */
        fun centralFailure(error: Throwable, signedOut: Boolean): Failure {
            val failure = error as? CentralFailure
            return when {
                signedOut || failure?.status == 401 || failure?.code == "connection_revoked" ->
                    Failure(Central.SIGNED_OUT, MoteI18n.text(SIGNED_OUT))
                failure?.status == 403 -> Failure(Central.DENIED, error.message.orEmpty())
                error is java.io.IOException -> Failure(Central.OFFLINE, MoteI18n.text(OFFLINE))
                else -> Failure(Central.FAILED, error.message.orEmpty())
            }
        }

        fun signedOut() = Failure(Central.SIGNED_OUT, MoteI18n.text(SIGNED_OUT))
    }
}
