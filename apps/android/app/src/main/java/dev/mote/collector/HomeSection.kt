package dev.mote.collector

/** A home block that reads existing data while the home is visible. Each block owns its identity checks and empty state. */
internal interface HomeSection {
    fun refresh()
    fun pause()
    fun close()
}

/**
 * The home frame's android-free rules. The dock, the capture line and the JVM
 * tests share these decisions instead of repeating labels or launch modes.
 */
internal object HomeFrame {
    /** The dock opens the existing Ask destination; it never starts a question by itself. */
    const val ASK_PAGE = "ASK"

    /** The two icon-only dock actions open the editor and request that media in the same tap. */
    val captureEntries = listOf(MoteQuickEntry.PHOTO, MoteQuickEntry.AUDIO)

    /** H04: one draft changes only the record label; the action still opens the same editor. */
    fun recordLabel(hasDraft: Boolean): String = MoteI18n.text(if (hasDraft) "继续草稿" else "记录")

    /** H05: the capture mode handed to the editor, or null for entries that only open the editor. */
    fun startMedia(entry: MoteQuickEntry): String? = entry.takeIf { it in captureEntries }?.media

    /** G01: normal capture is quiet; only a pause or an actionable interruption earns a home line. */
    fun showsCaptureNotice(kind: CaptureOverview.Kind): Boolean =
        kind != CaptureOverview.Kind.HIDDEN && kind != CaptureOverview.Kind.ACTIVE
}
