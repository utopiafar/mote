package dev.mote.collector

/** Deterministic Android presentation of the shared FileView. The server's
 * projection owns availability; no label, path or URI grants a read or an
 * external open. The signature covers only the fields this surface publishes,
 * so an unchanged polling response never replaces a page. */
internal object FileViewPresentation {
    data class Capabilities(val body: Boolean, val original: Boolean)

    data class Summary(
        val captureId: String,
        val revision: String,
        val retention: String,
        val body: String,
        val semantic: String,
        val embedding: String,
        val original: String,
        val origin: String?,
    ) {
        val signature: String get() = listOf(captureId, revision, retention, body, semantic, embedding, original, origin.orEmpty()).joinToString("|")
        val lines: List<String> get() = listOfNotNull(
            retention,
            MoteI18n.text("正文提取") + " · " + body,
            MoteI18n.text("语义理解") + " · " + semantic,
            MoteI18n.text("向量索引") + " · " + embedding,
            original,
            origin,
        )
    }

    fun capabilities(view: CentralFileView?): Capabilities =
        Capabilities(body = view?.bodyAvailable == true, original = view != null && view.hasOriginal && view.canOpenOriginal)

    fun summary(view: CentralFileView): Summary = Summary(
        captureId = view.captureId,
        revision = view.revision,
        retention = when (view.retention) {
            "reference" -> MoteI18n.text("仅引用 · 不读取正文")
            "archive" -> MoteI18n.text("原件归档")
            else -> MoteI18n.text("正文快照")
        },
        body = coverage(view.extraction),
        semantic = coverage(view.semantic),
        embedding = coverage(view.embedding),
        original = when {
            view.canOpenOriginal && view.hasOriginal -> MoteI18n.text("可打开原件")
            view.hasOriginal -> MoteI18n.text("原件不可用")
            else -> MoteI18n.text("未保留原件")
        },
        origin = view.originMissing.takeIf { it }?.let { MoteI18n.text("原位置已不可见") },
    )

    /** Availability changed while a page is open. An unavailable view is not a
     * change: a transient transport failure keeps the current body. */
    fun shouldReload(previous: String?, view: CentralFileView?): Boolean =
        view != null && summary(view).signature != previous

    /** These responses revoke the pinned read itself; every other failure stays
     * a transient or local presentation state. */
    fun revoked(error: Throwable?): Boolean = error is CentralFailure && error.status in setOf(401, 403, 404, 409, 410)

    fun coverage(value: CentralFileView.Coverage): String = when (value.status) {
        "pending" -> MoteI18n.text("待处理")
        "ready" -> MoteI18n.text("已完成")
        "failed" -> MoteI18n.text("失败")
        "unsupported" -> MoteI18n.text("不支持")
        else -> if (value.completed != null && value.total != null) MoteI18n.text("部分 {0}/{1}", value.completed, value.total) else MoteI18n.text("部分可用")
    }

    /** One compact line for the source list. It states what this FileView proves
     * and never infers another coverage dimension from a single ready status. */
    fun listDetail(row: LibrarySourceProjection.Row): String? {
        val view = row.fileView ?: return null
        val summary = summary(view)
        return listOf(summary.retention, MoteI18n.text("正文提取") + " · " + summary.body,
            MoteI18n.text("语义理解") + " · " + summary.semantic, summary.original,
            summary.origin).filterNotNull().joinToString(" · ")
    }
}
