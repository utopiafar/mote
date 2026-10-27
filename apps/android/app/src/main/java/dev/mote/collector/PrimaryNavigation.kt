package dev.mote.collector

/** Application routes are explicit UI metadata, never inferred from captured content. */
enum class MotePrimaryTab(val titleKey: String, val icon: String, val localPage: String, val route: String) {
    HOME("首页", "overview", "OVERVIEW", "home"),
    LIBRARY("资料库", "library", "LIBRARY", "library"),
    ASK("问一问", "ask", "ASK", "ask"),
    SOURCES("来源", "sources", "SOURCES", "sources"),
    ACTIVITY("活动", "activity", "ACTIVITY", "activity")
}

data class MoteNavigationGroup(val titleKey: String, val pages: List<String>)

object MoteNavigation {
    fun primaryTabs(): List<MotePrimaryTab> = listOf(MotePrimaryTab.HOME, MotePrimaryTab.LIBRARY, MotePrimaryTab.ASK, MotePrimaryTab.SOURCES)
    fun initialLocalPage(): String = "OVERVIEW"
    val libraryPages = listOf("archive", "materials", "coding", "timeline", "files", "memories", "notes", "imports", "insights", "agentView")
    // Legacy Coding transport links retain their library context, but are not content types.
    val libraryBrowsePages = libraryPages.filterNot { it == "coding" }
    val groups = listOf(
        MoteNavigationGroup("资料库", libraryBrowsePages),
        MoteNavigationGroup("首页", listOf("overview", "actions")),
        MoteNavigationGroup("来源", listOf("sources", "devices", "connections", "lark")),
        MoteNavigationGroup("管理与维护", listOf("statistics", "processing", "plugins", "settings", "usage", "vault", "developer", "about", "help"))
    )
    fun centralAllowsAdd(page: String): Boolean = page in setOf("ask", "sources") || page in libraryPages || page in groups[1].pages
    fun centralTab(page: String): MotePrimaryTab = when (page) {
        "overview", "actions" -> MotePrimaryTab.HOME
        "ask" -> MotePrimaryTab.ASK
        "sources", "devices", "connections", "lark" -> MotePrimaryTab.SOURCES
        "activity", "processing" -> MotePrimaryTab.ACTIVITY
        in libraryPages -> MotePrimaryTab.LIBRARY
        else -> MotePrimaryTab.LIBRARY
    }
    fun localTab(page: String): MotePrimaryTab = when (page) {
        "OVERVIEW" -> MotePrimaryTab.HOME
        "LIBRARY", "NOTES" -> MotePrimaryTab.LIBRARY
        "ASK" -> MotePrimaryTab.ASK
        "SOURCES", "CONNECTION", "CAPTURE", "PRIVACY", "PERMISSIONS" -> MotePrimaryTab.SOURCES
        "ACTIVITY" -> MotePrimaryTab.ACTIVITY
        else -> MotePrimaryTab.LIBRARY
    }
    fun centralParent(page: String): String? = when {
        page == "sources" || page == "activity" -> null
        page in setOf("devices", "connections", "lark") -> "sources"
        page == "processing" -> "activity"
        page in libraryPages -> "archive".takeUnless { page == it }
        page == "actions" -> "overview"
        page == "extensions" -> "about"
        page in groups.drop(2).flatMap { it.pages } -> "about".takeUnless { page == it }
        else -> null
    }
    fun isFirstUse(hasConnection: Boolean, captureEnabled: Boolean, lastCapture: String?, hasRecords: Boolean) =
        !hasConnection && !captureEnabled && lastCapture == null && !hasRecords
}
