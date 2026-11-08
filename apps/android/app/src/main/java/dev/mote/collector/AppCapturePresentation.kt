package dev.mote.collector

/** Configuration facts only. A version match is not a claim of live page coverage. */
internal object AppCapturePresentation {
    data class App(val id: String, val label: String, val version: String)
    data class Rule(val id: String, val version: String, val appVersion: String, val kind: String, val fields: Set<String>)
    enum class Scope { ALL, CONFIGURED, RULES, ATTENTION }
    data class Snapshot(val collection: AppCollectionRules, val excluded: Set<String>, val rules: String,
        val projection: Boolean, val ocr: Boolean) {
        val ruleCatalog: Map<String, List<Rule>> by lazy { UiPageRules.parse(rules)
            .filter { it.optInt("formatVersion") == 3 && it.optString("platform") == "android" }
            .groupBy { it.getString("appId") }.mapValues { (_, entries) -> entries.map { rule(it) } } }
    }

    private fun rule(value: org.json.JSONObject) = Rule(value.getString("id"), value.getString("version"), value.getString("appVersion"), value.getString("kind"),
        value.getJSONObject("fields").keys().asSequence().toSortedSet())

    fun rules(raw: String, appId: String): List<Rule> = UiPageRules.parse(raw)
        .filter { it.optInt("formatVersion") == 3 && it.optString("platform") == "android" && it.optString("appId") == appId }
        .map(::rule)

    fun ruleApps(raw: String): Set<String> = UiPageRules.parse(raw)
        .filter { it.optInt("formatVersion") == 3 && it.optString("platform") == "android" }
        .map { it.getString("appId") }.toSet()

    fun mode(snapshot: Snapshot, id: String): AppCollectionMode = if (id in snapshot.excluded) AppCollectionMode.OFF
        else snapshot.collection.apps[id] ?: snapshot.collection.defaultMode
    fun configured(snapshot: Snapshot, id: String) = id in snapshot.excluded || id in snapshot.collection.apps
    fun matching(rules: List<Rule>, version: String) = rules.filter { version.isNotBlank() && it.appVersion == version }
    fun needsAttention(snapshot: Snapshot, app: App, rules: List<Rule>): Boolean = mode(snapshot, app.id).structured &&
        (snapshot.projection || (!snapshot.ocr && matching(rules, app.version).isEmpty()))

    fun visible(snapshot: Snapshot, apps: List<App>, scope: Scope, query: String): List<App> = apps.filter { app ->
        (query.isBlank() || app.label.contains(query, true) || app.id.contains(query, true)) && when (scope) {
            Scope.ALL -> true
            Scope.CONFIGURED -> configured(snapshot, app.id)
            Scope.RULES -> snapshot.ruleCatalog[app.id].orEmpty().isNotEmpty()
            Scope.ATTENTION -> needsAttention(snapshot, app, snapshot.ruleCatalog[app.id].orEmpty())
        }
    }
}
