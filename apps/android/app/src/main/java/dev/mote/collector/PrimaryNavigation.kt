package dev.mote.collector

/** Application routes are explicit UI metadata, never inferred from captured content. */
enum class MotePrimaryTab(val titleKey: String, val icon: String, val localPage: String) {
    TODAY("今天", "overview", "OVERVIEW"),
    LIBRARY("资料库", "library", "LIBRARY"),
    ASK("问一问", "ask", "ASK"),
    DEVICE("本机", "settings", "SETTINGS")
}

data class MoteNavigationGroup(val titleKey: String, val pages: List<String>)

object MoteNavigation {
    val libraryPages = listOf("archive", "materials", "coding", "timeline", "files", "sources", "memories", "notes", "imports", "insights", "agentView")
    val groups = listOf(
        MoteNavigationGroup("资料库", libraryPages),
        MoteNavigationGroup("今天", listOf("overview", "actions")),
        MoteNavigationGroup("连接与授权", listOf("devices", "connections", "lark")),
        MoteNavigationGroup("管理与维护", listOf("statistics", "processing", "extensions", "settings", "usage", "vault", "developer", "about", "help"))
    )
    fun centralTab(page: String): MotePrimaryTab = when (page) {
        "ask" -> MotePrimaryTab.ASK
        "overview", "actions" -> MotePrimaryTab.TODAY
        in libraryPages -> MotePrimaryTab.LIBRARY
        else -> MotePrimaryTab.DEVICE
    }
    fun localTab(page: String): MotePrimaryTab = when (page) {
        "OVERVIEW" -> MotePrimaryTab.TODAY
        "LIBRARY", "NOTES" -> MotePrimaryTab.LIBRARY
        "ASK" -> MotePrimaryTab.ASK
        else -> MotePrimaryTab.DEVICE
    }
    fun centralParent(page: String): String? = when (centralTab(page)) {
        MotePrimaryTab.TODAY -> "overview".takeUnless { page == it }
        MotePrimaryTab.LIBRARY -> "archive".takeUnless { page == it }
        MotePrimaryTab.DEVICE -> "about".takeUnless { page == it }
        MotePrimaryTab.ASK -> null
    }
    fun isFirstUse(hasConnection: Boolean, captureEnabled: Boolean, lastCapture: String?, hasRecords: Boolean) =
        !hasConnection && !captureEnabled && lastCapture == null && !hasRecords
}
