package dev.mote.collector

/** Application routes are explicit UI metadata, never inferred from captured content. */
enum class MotePrimaryTab(val titleKey: String, val icon: String, val localPage: String) {
    TODAY("首页", "overview", "OVERVIEW"),
    LIBRARY("内容", "library", "LIBRARY"),
    ASK("问一问", "ask", "ASK")
}

data class MoteNavigationGroup(val titleKey: String, val pages: List<String>)

object MoteNavigation {
    val libraryPages = listOf("archive", "materials", "coding", "timeline", "files", "sources", "memories", "notes", "imports", "insights", "agentView")
    val groups = listOf(
        MoteNavigationGroup("内容", libraryPages),
        MoteNavigationGroup("首页", listOf("overview", "actions")),
        MoteNavigationGroup("连接与授权", listOf("devices", "connections", "lark")),
        MoteNavigationGroup("管理与维护", listOf("statistics", "processing", "plugins", "settings", "usage", "vault", "developer", "about", "help"))
    )
    fun centralTab(page: String): MotePrimaryTab = when (page) {
        "ask" -> MotePrimaryTab.ASK
        "overview", "actions" -> MotePrimaryTab.TODAY
        in libraryPages -> MotePrimaryTab.LIBRARY
        else -> MotePrimaryTab.TODAY
    }
    fun localTab(page: String): MotePrimaryTab = when (page) {
        "OVERVIEW" -> MotePrimaryTab.TODAY
        "LIBRARY", "NOTES" -> MotePrimaryTab.LIBRARY
        "ASK" -> MotePrimaryTab.ASK
        else -> MotePrimaryTab.TODAY
    }
    fun centralParent(page: String): String? = when {
        page in libraryPages -> "archive".takeUnless { page == it }
        page == "actions" -> "overview"
        page == "extensions" -> "about"
        page in groups.drop(2).flatMap { it.pages } -> "about".takeUnless { page == it }
        else -> null
    }
    fun isFirstUse(hasConnection: Boolean, captureEnabled: Boolean, lastCapture: String?, hasRecords: Boolean) =
        !hasConnection && !captureEnabled && lastCapture == null && !hasRecords
}
