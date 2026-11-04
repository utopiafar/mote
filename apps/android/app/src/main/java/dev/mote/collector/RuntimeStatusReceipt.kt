package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Android mirror of the shared agent-runtime status receipt
 * (packages/shared/src/agent-runtime-status.ts). Strict object keys, bounded
 * strings and integer revisions fail closed on secret- or path-shaped fields;
 * unknown feature/provider identifiers stay displayable instead of rejecting
 * the whole receipt. Kept JVM-safe so the contract tests without a device. */
internal object RuntimeStatusReceipt {
    private val identifier = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")
    private const val MAX_SAFE = 9007199254740991.0
    private val sources = setOf("environment", "saved", "file")
    private val effects = setOf("immediate", "next-request", "next-admission", "restart", "migration")
    private val domainStatuses = setOf("applied", "restart-required", "invalid")

    enum class Readiness { CLOSED, FAILED, UNCONFIGURED, RESTART_PENDING, READY }
    enum class FeatureState { UNKNOWN, UNCONFIGURED, READY }

    data class FeatureSelection(val profileId: String, val provider: String, val model: String, val configured: Boolean)
    data class DomainStatus(val id: String, val status: String, val error: String?)
    data class Receipt(
        val revision: Long,
        val features: Map<String, FeatureSelection>,
        val closed: Boolean,
        val shuttingDown: Boolean,
        val configured: Boolean,
        val domain: DomainStatus?,
        val lastErrorCode: String?,
        val lastErrorDomain: String?,
        /** Validated saved model-settings object (profiles, defaults, defaultModels). */
        val saved: JSONObject,
    )

    private fun strictKeys(value: JSONObject, expected: Set<String>): Boolean =
        value.keys().asSequence().all { it in expected }
    private fun text(value: JSONObject, key: String, min: Int, max: Int): String? =
        (value.opt(key) as? String)?.takeIf { it.length in min..max }
    private fun boolean(value: JSONObject, key: String): Boolean? = value.opt(key) as? Boolean
    private fun count(value: JSONObject, key: String): Long? {
        val raw = value.opt(key) as? Number ?: return null
        val double = raw.toDouble()
        return if (double >= 0 && double <= MAX_SAFE && double % 1.0 == 0.0) raw.toLong() else null
    }
    private fun identifier(value: JSONObject, key: String): String? =
        (value.opt(key) as? String)?.takeIf { identifier.matches(it) }

    private fun settings(value: Any?): JSONObject? {
        val settings = value as? JSONObject ?: return null
        val keys = setOf("provider", "protocol", "baseUrl", "model", "reasoningEffort", "serviceTier", "maxTokens",
            "modelRequestTimeoutMs", "agentTimeoutMs", "allowUnauthenticatedLocal", "apiKeyConfigured", "headersConfigured", "extraBodyConfigured")
        if (!strictKeys(settings, keys)) return null
        if (text(settings, "provider", 1, 128) == null || text(settings, "protocol", 1, 64) == null ||
            text(settings, "baseUrl", 0, 4096) == null || text(settings, "model", 0, 512) == null ||
            text(settings, "reasoningEffort", 1, 64) == null) return null
        if (settings.has("serviceTier") && text(settings, "serviceTier", 1, 64) == null) return null
        val maxTokens = count(settings, "maxTokens") ?: return null
        if (maxTokens < 1 || maxTokens > 1_000_000) return null
        for (timeout in listOf("modelRequestTimeoutMs", "agentTimeoutMs")) {
            val raw = settings.opt(timeout)
            if (raw != JSONObject.NULL && ((raw as? Number)?.toDouble()?.let { it >= 1 && it % 1.0 == 0.0 } != true)) return null
        }
        if (boolean(settings, "allowUnauthenticatedLocal") == null || boolean(settings, "apiKeyConfigured") == null ||
            boolean(settings, "headersConfigured") == null || boolean(settings, "extraBodyConfigured") == null) return null
        return settings
    }

    private fun profile(value: Any?): Boolean {
        val profile = value as? JSONObject ?: return false
        if (!strictKeys(profile, setOf("id", "name", "settings", "readOnly", "source"))) return false
        if (identifier(profile, "id") == null || text(profile, "name", 1, 100) == null || settings(profile.opt("settings")) == null) return false
        if (profile.has("readOnly") && boolean(profile, "readOnly") == null) return false
        if (profile.has("source") && (profile.opt("source") as? String) !in sources) return false
        return true
    }

    private fun featureSelection(value: Any?): FeatureSelection? {
        val selection = value as? JSONObject ?: return null
        if (!strictKeys(selection, setOf("profileId", "provider", "model", "configured"))) return null
        val profileId = identifier(selection, "profileId") ?: return null
        val provider = text(selection, "provider", 1, 128) ?: return null
        val model = text(selection, "model", 0, 512) ?: return null
        val configured = boolean(selection, "configured") ?: return null
        return FeatureSelection(profileId, provider, model, configured)
    }

    private fun field(value: Any?): Boolean {
        val field = value as? JSONObject ?: return false
        if (!strictKeys(field, setOf("path", "label", "description", "sensitive", "effect"))) return false
        if (text(field, "path", 1, 500) == null) return false
        if (field.has("label") && text(field, "label", 1, 200) == null) return false
        if (field.has("description") && text(field, "description", 0, 2000) == null) return false
        if (field.has("sensitive") && boolean(field, "sensitive") == null) return false
        if (field.has("effect") && (field.opt("effect") as? String) !in effects) return false
        return true
    }

    private fun domain(value: Any?): DomainStatus? {
        val domain = value as? JSONObject ?: return null
        if (!strictKeys(domain, setOf("id", "saved", "effective", "fields", "status", "error"))) return null
        val id = identifier(domain, "id") ?: return null
        val status = (domain.opt("status") as? String)?.takeIf { it in domainStatuses } ?: return null
        val fields = domain.optJSONArray("fields") ?: return null
        if (!(0 until fields.length()).all { field(fields.opt(it)) }) return null
        if (domain.has("error") && text(domain, "error", 1, 200) == null) return null
        return DomainStatus(id, status, domain.optString("error").takeIf { it.isNotEmpty() })
    }

    private fun runtime(value: Any?): Triple<Boolean, Boolean, Boolean>? {
        val runtime = value as? JSONObject ?: return null
        val keys = setOf("closed", "configured", "generation", "activeRuns", "retiringGenerations", "releasedGenerations",
            "preparedGenerations", "closeErrors", "lastCloseError", "preparedAgents", "pendingPreparations",
            "pendingCleanupFailures", "shuttingDown")
        if (!strictKeys(runtime, keys)) return null
        val closed = boolean(runtime, "closed") ?: return null
        val configured = boolean(runtime, "configured") ?: return null
        val shuttingDown = boolean(runtime, "shuttingDown") ?: return null
        for (counter in listOf("generation", "activeRuns", "retiringGenerations", "releasedGenerations", "preparedGenerations",
            "closeErrors", "preparedAgents", "pendingPreparations", "pendingCleanupFailures")) if (count(runtime, counter) == null) return null
        if (runtime.has("lastCloseError")) {
            val failure = runtime.optJSONObject("lastCloseError") ?: return null
            if (!strictKeys(failure, setOf("name", "code")) || text(failure, "name", 1, 200) == null) return null
            if (failure.has("code") && text(failure, "code", 1, 200) == null) return null
        }
        return Triple(closed, configured, shuttingDown)
    }

    /** Strictly parse one serialized receipt; anything malformed, secret- or
     * path-shaped returns null instead of guessing at another object. */
    fun parse(value: JSONObject): Receipt? {
        if (!strictKeys(value, setOf("revision", "saved", "features", "runtime", "configuration"))) return null
        val revision = count(value, "revision") ?: return null
        val saved = value.optJSONObject("saved") ?: return null
        if (!strictKeys(saved, setOf("version", "revision", "source", "settings", "profiles", "defaults", "defaultModels"))) return null
        if (count(saved, "version") != 1L || count(saved, "revision") == null || (saved.opt("source") as? String) !in sources) return null
        if (settings(saved.opt("settings")) == null) return null
        val profiles = saved.optJSONArray("profiles") ?: return null
        if (!(0 until profiles.length()).all { profile(profiles.opt(it)) }) return null
        if (!record(saved, "defaults", { identifier.matches(it) }, { it is String && identifier.matches(it) })) return null
        if (!record(saved, "defaultModels", { identifier.matches(it) }, { it is String && it.length <= 512 })) return null
        val rawFeatures = value.optJSONObject("features") ?: return null
        val features = LinkedHashMap<String, FeatureSelection>()
        for (key in rawFeatures.keys()) {
            if (!identifier.matches(key)) return null
            features[key] = featureSelection(rawFeatures.opt(key)) ?: return null
        }
        val (closed, configured, shuttingDown) = runtime(value.opt("runtime")) ?: return null
        val configuration = value.optJSONObject("configuration") ?: return null
        if (!strictKeys(configuration, setOf("version", "revision", "configFile", "domains", "lastError", "domain"))) return null
        if (count(configuration, "version") != 1L || count(configuration, "revision") == null ||
            text(configuration, "configFile", 0, 4096) == null) return null
        val domains = configuration.optJSONArray("domains") ?: return null
        val parsed = (0 until domains.length()).map { domain(domains.opt(it)) ?: return null }
        var lastErrorCode: String? = null; var lastErrorDomain: String? = null
        if (!configuration.has("lastError")) return null
        if (!configuration.isNull("lastError")) {
            val failure = configuration.optJSONObject("lastError") ?: return null
            if (!strictKeys(failure, setOf("code", "domain"))) return null
            lastErrorCode = text(failure, "code", 1, 200) ?: return null
            lastErrorDomain = if (failure.has("domain")) identifier(failure, "domain") ?: return null else null
        }
        val selectedDomain = if (configuration.has("domain")) domain(configuration.opt("domain")) ?: return null
            else null
        val modelsDomain = selectedDomain ?: parsed.find { it.id == "models" }
        return Receipt(revision, features, closed, shuttingDown, configured, modelsDomain, lastErrorCode, lastErrorDomain, saved)
    }

    private fun record(value: JSONObject, key: String, keysOk: (String) -> Boolean, valuesOk: (Any?) -> Boolean): Boolean {
        val raw = value.optJSONObject(key) ?: return false
        return raw.keys().asSequence().all { keysOk(it) && valuesOk(raw.opt(it)) }
    }

    /** Mirrors agentRuntimeReadiness: ready needs configured state applied. */
    fun readiness(receipt: Receipt): Readiness {
        if (receipt.closed || receipt.shuttingDown) return Readiness.CLOSED
        if (receipt.domain == null || receipt.domain.status == "invalid" ||
            (receipt.lastErrorCode != null && (receipt.lastErrorDomain == null || receipt.lastErrorDomain == "models"))) return Readiness.FAILED
        if (!receipt.configured) return Readiness.UNCONFIGURED
        if (receipt.domain?.status == "restart-required") return Readiness.RESTART_PENDING
        return Readiness.READY
    }

    /** Mirrors agentRuntimeFeatureState: a missing selection is never ready. */
    fun featureState(receipt: Receipt, capability: String): FeatureState {
        val selected = receipt.features[capability] ?: return FeatureState.UNKNOWN
        return if (selected.configured) FeatureState.READY else FeatureState.UNCONFIGURED
    }

    fun readinessLabel(readiness: Readiness): String = when (readiness) {
        Readiness.READY -> MoteI18n.text("已就绪")
        Readiness.RESTART_PENDING -> MoteI18n.text("重启后生效")
        Readiness.UNCONFIGURED -> MoteI18n.text("未配置")
        Readiness.FAILED -> MoteI18n.text("失败")
        Readiness.CLOSED -> MoteI18n.text("已关闭")
    }

    /** One-line effective selection for admin surfaces; profile names fall back
     * to identifiers and unknown features keep their wire key. */
    fun effectiveSummary(receipt: Receipt, featureLabel: (String) -> String, profileName: (String) -> String?): String {
        val restart = if (receipt.domain?.status == "restart-required") " · " + MoteI18n.text("重启后生效") else ""
        return receipt.features.entries.joinToString("；") { (feature, selected) ->
            featureLabel(feature) + "：" + (profileName(selected.profileId) ?: selected.profileId) +
                (if (selected.model.isNotEmpty()) " · " + selected.model else "") +
                (if (selected.configured) "" else " · " + MoteI18n.text("尚未生效"))
        } + restart
    }
}
