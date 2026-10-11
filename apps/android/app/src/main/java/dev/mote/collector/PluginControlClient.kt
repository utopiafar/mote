package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Native projection of the shared owner control-plane contract. No query tool
 * can reach these commands; authorization is enforced by CentralClient/server. */
internal data class PluginCommandIntent(val path: String, val method: String, val body: String) {
    fun payload() = JSONObject(body)
}
internal data class PluginCapability(val id: String, val state: String, val reason: String)
internal data class PluginField(val id: String, val label: String, val type: String, val required: Boolean, val options: List<Pair<String, String>>, val description: String)
internal data class PluginInstance(val id: String, val packageId: String, val name: String, val revision: Long, val scope: String, val configuration: JSONObject, val fields: List<PluginField>, val capabilities: List<PluginCapability>, val desired: Boolean, val observed: String, val issues: List<String>, val allowedActions: Set<String>, val secretStatus: JSONObject)
internal data class PluginPackage(val id: String, val name: String, val version: String, val source: JSONObject, val runtime: String, val state: String, val observed: String, val issues: List<String>, val allowedActions: Set<String>, val fields: List<PluginField> = emptyList())
internal data class PluginInventory(val revision: Long, val installation: JSONObject, val packages: List<PluginPackage>, val instances: List<PluginInstance>, val catalog: List<JSONObject>)
internal data class MemoryPlan(val id: String, val name: String, val mode: String, val available: Boolean, val reason: String, val modules: List<JSONObject>, val capabilities: List<PluginCapability>, val allowedActions: Set<String>)
internal data class MemoryBinding(val revision: Long, val generation: Long, val mode: String, val activePlan: MemoryPlan, val plans: List<MemoryPlan>, val modules: List<JSONObject>, val admission: JSONObject, val preparation: JSONObject?, val allowedActions: Set<String>)

internal object PluginControlProjection {
    fun objects(value: JSONArray?) = value?.let { array -> (0 until array.length()).map { array.getJSONObject(it) } }.orEmpty()
    fun strings(value: JSONArray?) = value?.let { array -> (0 until array.length()).map { array.getString(it) } }.orEmpty()
    fun actions(value: JSONObject) = strings(value.optJSONArray("allowedActions")).toSet()
    fun capabilities(value: JSONArray?) = objects(value).map { PluginCapability(it.getString("id"), it.getString("state"), it.optString("reason")) }
    fun fields(value: JSONArray?) = objects(value).map { field ->
        PluginField(field.getString("id"), field.getString("label"), field.getString("type"), field.optBoolean("required"), objects(field.optJSONArray("options")).map { it.getString("value") to it.getString("label") }, field.optString("description"))
    }
    fun instance(value: JSONObject) = PluginInstance(value.getString("id"), value.getString("packageId"), value.getString("name"), value.getLong("revision"), value.getString("scope"), value.getJSONObject("configuration"), fields(value.getJSONArray("configurationSchema")), capabilities(value.getJSONArray("capabilities")), value.getBoolean("desired"), value.getString("observed"), strings(value.getJSONArray("issues")), actions(value), value.getJSONObject("secretStatus"))
    fun inventory(value: JSONObject) = PluginInventory(value.getLong("revision"), value.getJSONObject("installation"), objects(value.getJSONArray("packages")).map { PluginPackage(it.getString("id"), it.getString("name"), it.getString("version"), it.getJSONObject("source"), it.getString("runtime"), it.getString("state"), it.getString("observed"), strings(it.getJSONArray("issues")), actions(it), fields(it.optJSONArray("configurationSchema"))) }, objects(value.getJSONArray("instances")).map(::instance), objects(value.getJSONArray("catalog")))
    fun plan(value: JSONObject) = MemoryPlan(value.getString("id"), value.getString("name"), value.getString("mode"), value.getBoolean("available"), value.optString("reason"), objects(value.getJSONArray("modules")), capabilities(value.getJSONArray("capabilities")), actions(value))
    fun binding(value: JSONObject) = MemoryBinding(value.getLong("revision"), value.getLong("generation"), value.getString("mode"), plan(value.getJSONObject("activePlan")), objects(value.getJSONArray("plans")).map(::plan), objects(value.getJSONArray("modules")), value.getJSONObject("admission"), value.optJSONObject("preparation"), actions(value))
    fun configured(fields: List<PluginField>, configuration: JSONObject): Boolean = fields.all { field ->
        val value = configuration.opt(field.id)
        val absent = value == null || value == JSONObject.NULL || value == ""
        if (absent) !field.required else when (field.type) {
            "boolean" -> value is Boolean
            "number" -> value is Number && value.toDouble().isFinite()
            "select" -> value is String && field.options.any { it.first == value }
            "text", "model-profile", "secret-reference" -> value is String
            else -> false
        }
    }
}

internal class PluginControlClient(private val client: CentralClient) {
    fun inventory() = PluginControlProjection.inventory(client.get("/api/plugins"))
    fun binding() = PluginControlProjection.binding(client.get(BINDING))
    fun resolve(repository: String, tag: String = "") = client.post("/api/plugins/resolve", JSONObject().put("repository", repository).apply { if (tag.isNotBlank()) put("tag", tag) })
    fun execute(intent: PluginCommandIntent): JSONObject = when (intent.method) {
        "POST" -> client.post(intent.path, intent.payload())
        "PATCH" -> client.patch(intent.path, intent.payload())
        else -> error("Unsupported plugin command method")
    }
    companion object {
        const val BINDING = "/api/memory-spaces/default/binding"
        fun intent(path: String, revision: Long, payload: JSONObject = JSONObject(), method: String = "POST", operationId: String = UUID.randomUUID().toString()) =
            PluginCommandIntent(path, method, JSONObject(payload.toString()).put("expectedRevision", revision).put("operationId", operationId).toString())
        fun install(preview: JSONObject, revision: Long) = intent("/api/plugins/install", revision, JSONObject().put("previewId", preview.getString("id")))
        fun configure(packageId: String, instanceId: String?, revision: Long, name: String, scope: String, configuration: JSONObject) = intent(
            if (instanceId == null) "/api/plugin-instances" else "/api/plugin-instances/" + CentralScreens.encode(instanceId), revision,
            JSONObject().put("name", name).put("scope", scope).put("configuration", configuration).apply { if (instanceId == null) put("packageId", packageId) }, if (instanceId == null) "POST" else "PATCH")
        fun instanceAction(id: String, action: String, revision: Long): PluginCommandIntent {
            require(action in setOf("check", "enable", "disable"))
            return intent("/api/plugin-instances/" + CentralScreens.encode(id) + "/" + action, revision)
        }
        fun memoryAction(action: String, revision: Long, preparationId: String? = null): PluginCommandIntent {
            require(action in setOf("pause", "resume", "stop", "activate", "retry", "cancel"))
            return intent(BINDING + "/" + action, revision, JSONObject().apply { preparationId?.let { put("preparationId", it) } })
        }
        fun prepare(planId: String, scope: String, revision: Long, feeAcknowledged: Boolean): PluginCommandIntent {
            require(feeAcknowledged && scope.isNotBlank())
            return intent(BINDING + "/prepare", revision, JSONObject().put("targetPlanId", planId).put("scope", scope).put("feeAcknowledged", true))
        }
        fun uninstall(id: String, revision: Long) = intent("/api/plugins/" + CentralScreens.encode(id) + "/uninstall", revision)
    }
}
