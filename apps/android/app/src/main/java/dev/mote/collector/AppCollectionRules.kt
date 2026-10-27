package dev.mote.collector

import org.json.JSONObject

enum class AppCollectionChannel { DURATION, SCREENSHOT, STRUCTURED, OCR }

enum class AppCollectionMode(val wire: String, val duration: Boolean, val screenshots: Boolean, val structured: Boolean) {
    CONTENT("content", true, true, true), ACTIVITY("activity", true, false, false), OFF("off", false, false, false),
    SCREENSHOT("screenshot", false, true, false), STRUCTURED("structured", false, false, true),
    DURATION_SCREENSHOT("duration_screenshot", true, true, false), DURATION_STRUCTURED("duration_structured", true, false, true),
    SCREENSHOT_STRUCTURED("screenshot_structured", false, true, true);
    fun allows(channel: AppCollectionChannel) = when(channel) {
        AppCollectionChannel.DURATION -> duration
        AppCollectionChannel.SCREENSHOT -> screenshots
        AppCollectionChannel.STRUCTURED, AppCollectionChannel.OCR -> structured
    }
    companion object {
        fun from(value: String) = entries.singleOrNull { it.wire == value } ?: error(MoteI18n.text("应用采集选项无效"))
        fun fromChoices(duration: Boolean, screenshots: Boolean, structured: Boolean) = entries.single {
            it.duration == duration && it.screenshots == screenshots && it.structured == structured
        }
    }
}

/** Explicit app identity rules only; unknown surfaces use the default unless a privacy rule needs identity. */
data class AppCollectionRules(val defaultMode: AppCollectionMode, val apps: Map<String, AppCollectionMode>) {
    fun mayCollectContent() = defaultMode.screenshots || defaultMode.structured || apps.values.any { it.screenshots || it.structured }
    fun mayCollectScreenshots() = defaultMode.screenshots || apps.values.any { it.screenshots }
    fun mayCollectStructured() = defaultMode.structured || apps.values.any { it.structured }
    fun requiresWindowIdentity(excludedPackages: Set<String>) = excludedPackages.isNotEmpty() || defaultMode != AppCollectionMode.CONTENT || apps.values.any { it != AppCollectionMode.CONTENT }
    /** Independent channel admission. OCR is structured content, with its separate opt-in checked by the caller. */
    fun allows(windows: WindowSnapshot, excludedPackages: Set<String>, channel: AppCollectionChannel): Boolean {
        if (windows.packages.any { it in excludedPackages }) return false
        if (!windows.trustworthy && requiresWindowIdentity(excludedPackages)) return false
        val selected = windows.foreground?.let { apps[it] } ?: defaultMode
        if (!selected.allows(channel)) return false
        if (channel == AppCollectionChannel.DURATION) return windows.trustworthy && !windows.foreground.isNullOrBlank() && windows.foreground in windows.packages
        return windows.packages.none { it != windows.foreground && !(apps[it] ?: defaultMode).allows(channel) }
    }
    fun selection(windows: WindowSnapshot, excludedPackages: Set<String>) = AppCollectionMode.fromChoices(
        allows(windows, excludedPackages, AppCollectionChannel.DURATION),
        allows(windows, excludedPackages, AppCollectionChannel.SCREENSHOT),
        allows(windows, excludedPackages, AppCollectionChannel.STRUCTURED))
    /** Scheduling projection for existing metadata observers; never capture-channel authorization. */
    fun decide(windows: WindowSnapshot, excludedPackages: Set<String>): AppCollectionMode {
        val selected = selection(windows, excludedPackages)
        val requested = windows.foreground?.let { apps[it] } ?: defaultMode
        return if (selected.screenshots || selected.structured) AppCollectionMode.CONTENT
        else if (requested.screenshots || requested.structured) AppCollectionMode.OFF
        else if (selected.duration) AppCollectionMode.ACTIVITY else AppCollectionMode.OFF
    }
    fun json(): String = JSONObject().put("default", defaultMode.wire).put("apps", JSONObject().apply { apps.toSortedMap().forEach { (key, value) -> put(key, value.wire) } }).toString()
    companion object {
        const val DEFAULT = "{\"default\":\"activity\",\"apps\":{}}"
        const val CONTENT_DEFAULT = "{\"default\":\"content\",\"apps\":{}}"
        private val packagePattern = Regex("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)*")
        fun parse(value: String): AppCollectionRules {
            require(value.toByteArray(Charsets.UTF_8).size <= 32768) { MoteI18n.text("应用规则超过大小上限") }
            StrictJson.validate(value)
            val root = JSONObject(value)
            require(root.keys().asSequence().toSet() == setOf("default", "apps")) { MoteI18n.text("应用规则结构无效") }
            val entries = root.getJSONObject("apps"); require(entries.length() <= 200) { MoteI18n.text("最多200项应用规则") }
            val apps = entries.keys().asSequence().associateWith { id ->
                require(id.length <= 255 && packagePattern.matches(id)) { MoteI18n.text("请输入完整应用包名") }
                AppCollectionMode.from(entries.getString(id))
            }
            return AppCollectionRules(AppCollectionMode.from(root.getString("default")), apps)
        }
        fun fromLines(defaultMode: AppCollectionMode, value: String): AppCollectionRules {
            val apps = linkedMapOf<String, AppCollectionMode>()
            value.lineSequence().map(String::trim).filter(String::isNotEmpty).forEach { line ->
                val parts = line.split('='); require(parts.size == 2) { MoteI18n.text("每行使用 包名=采集选项") }
                val id = parts[0].trim(); require(!apps.containsKey(id)) { MoteI18n.text("同一应用不能配置两次") }
                apps[id] = AppCollectionMode.from(parts[1].trim())
            }
            return parse(AppCollectionRules(defaultMode, apps).json())
        }
    }
}

/** All identified visible windows participate, including launchers, keyboards and system surfaces. */
internal data class CollectionWindow(val type: Int, val packageName: String?, val systemBar: Boolean = false)
internal data class CaptureBounds(val left: Int, val top: Int, val right: Int, val bottom: Int)
internal object SystemBarRegion {
    const val MIUI_HOME = "com.miui.home"
    const val MIUI_SYSTEM_UI = "miui.systemui.plugin"
    /** A system-owned OEM status surface is chrome only inside OS-provided bar geometry. */
    fun miuiStatus(window: CaptureBounds, display: CaptureBounds, insets: CaptureBounds,
        packageName: String?, systemOwner: Boolean, type: Int, active: Boolean, focused: Boolean): Boolean =
        packageName == MIUI_SYSTEM_UI && systemOwner && type == 3 && !active && !focused && contains(window, display, insets)
    /** HyperOS exposes GestureStubHome outside the standard navigation inset (74px vs 48px).
     * This OEM exception only covers an inactive system-owned, full-width bottom navigation strip.
     * Never apply it to launcher Activities, side overlays, floating panels or hidden navigation.
     */
    fun miuiNavigation(window: CaptureBounds, display: CaptureBounds, navigationBottom: Int,
        density: Float, packageName: String?, systemOwner: Boolean, type: Int, active: Boolean, focused: Boolean): Boolean {
        if (packageName != MIUI_HOME || !systemOwner || type != 3 || active || focused || navigationBottom <= 0 ||
            !density.isFinite() || density <= 0) return false
        val height = window.bottom - window.top
        return window.left == display.left && window.right == display.right && window.bottom == display.bottom &&
            window.top >= display.top && height >= navigationBottom && height <= (32 * density).toInt()
    }
    /** Use OS-provided insets, not localized window titles or a guessed bar height. */
    fun contains(window: CaptureBounds, display: CaptureBounds, insets: CaptureBounds): Boolean {
        if (window.right <= window.left || window.bottom <= window.top ||
            window.left < display.left || window.top < display.top || window.right > display.right || window.bottom > display.bottom) return false
        return insets.top > 0 && window.bottom <= display.top + insets.top ||
            insets.bottom > 0 && window.top >= display.bottom - insets.bottom ||
            insets.left > 0 && window.right <= display.left + insets.left ||
            insets.right > 0 && window.left >= display.right - insets.right
    }
}
internal object CollectionWindows {
    fun snapshot(windows: List<CollectionWindow>, foreground: String?): WindowSnapshot {
        val contentWindows = windows.filterNot { it.type == 3 && it.packageName in setOf("com.android.systemui", SystemBarRegion.MIUI_HOME, SystemBarRegion.MIUI_SYSTEM_UI) && it.systemBar }
        val packages = contentWindows.mapNotNull { it.packageName }.toSet()
        val trustworthy = contentWindows.isNotEmpty() && contentWindows.all { it.type in 1..3 && !it.packageName.isNullOrBlank() } &&
            (foreground.isNullOrBlank() || foreground in packages)
        return WindowSnapshot(packages, foreground, trustworthy)
    }
}
