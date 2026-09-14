package dev.mote.collector

import org.json.JSONObject

enum class AppCollectionMode(val wire: String) { CONTENT("content"), ACTIVITY("activity"), OFF("off");
    companion object { fun from(value: String) = entries.singleOrNull { it.wire == value } ?: error("应用采集级别必须为 content / activity / off") }
}

/** Explicit app identity rules only. A window ambiguity never grants content access. */
data class AppCollectionRules(val defaultMode: AppCollectionMode, val apps: Map<String, AppCollectionMode>) {
    fun mayCollectContent() = defaultMode == AppCollectionMode.CONTENT || apps.values.any { it == AppCollectionMode.CONTENT }
    fun decide(windows: WindowSnapshot, legacyExcluded: Set<String>): AppCollectionMode {
        if (!windows.trustworthy || windows.foreground.isNullOrBlank() || windows.foreground !in windows.packages) return AppCollectionMode.OFF
        if (windows.packages.any { it in legacyExcluded }) return AppCollectionMode.OFF
        // Every identified auxiliary window obeys the same explicit rules. Never downgrade a sample.
        val selected = apps[windows.foreground] ?: defaultMode
        if (selected == AppCollectionMode.CONTENT && windows.packages.any { it != windows.foreground && (apps[it] ?: defaultMode) != AppCollectionMode.CONTENT }) return AppCollectionMode.OFF
        return selected
    }
    fun json(): String = JSONObject().put("default", defaultMode.wire).put("apps", JSONObject().apply { apps.toSortedMap().forEach { (key, value) -> put(key, value.wire) } }).toString()
    companion object {
        const val DEFAULT = "{\"default\":\"content\",\"apps\":{}}"
        private val packagePattern = Regex("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)*")
        fun parse(value: String): AppCollectionRules {
            require(value.toByteArray(Charsets.UTF_8).size <= 32768) { "应用规则超过大小上限" }
            StrictJson.validate(value)
            val root = JSONObject(value)
            require(root.keys().asSequence().toSet() == setOf("default", "apps")) { "应用规则结构无效" }
            val entries = root.getJSONObject("apps"); require(entries.length() <= 200) { "最多200项应用规则" }
            val apps = entries.keys().asSequence().associateWith { id ->
                require(id.length <= 255 && packagePattern.matches(id)) { "请输入完整应用包名" }
                AppCollectionMode.from(entries.getString(id))
            }
            return AppCollectionRules(AppCollectionMode.from(root.getString("default")), apps)
        }
        fun fromLines(defaultMode: AppCollectionMode, value: String): AppCollectionRules {
            val apps = linkedMapOf<String, AppCollectionMode>()
            value.lineSequence().map(String::trim).filter(String::isNotEmpty).forEach { line ->
                val parts = line.split('='); require(parts.size == 2) { "每行使用 包名=content/activity/off" }
                val id = parts[0].trim(); require(!apps.containsKey(id)) { "同一应用不能配置两次" }
                apps[id] = AppCollectionMode.from(parts[1].trim())
            }
            return parse(AppCollectionRules(defaultMode, apps).json())
        }
    }
}

/** One foreground application; identified keyboard/system windows also participate in app rules. */
internal data class CollectionWindow(val type: Int, val packageName: String?)
internal object CollectionWindows {
    fun snapshot(windows: List<CollectionWindow>, foreground: String?): WindowSnapshot {
        val packages = windows.mapNotNull { it.packageName }.toSet()
        val applications = windows.filter { it.type == 1 }
        val trustworthy = applications.size == 1 && applications.single().packageName == foreground &&
            windows.all { it.type in 1..3 && !it.packageName.isNullOrBlank() } && !foreground.isNullOrBlank()
        return WindowSnapshot(packages, foreground, trustworthy)
    }
}
