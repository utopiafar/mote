package dev.mote.collector.plugins

import org.json.JSONArray
import org.json.JSONObject
import java.time.OffsetDateTime
import java.time.ZoneId

/** Kotlin consumer of the shared U5 workbench envelope. The server sends a
 * `WorkspaceView` with the existing declarative-view descriptor/spec/data and
 * a typed command directory. This parser mirrors the TS decoder's strictness:
 * unknown keys, wrong value types, undeclared components and command drift are
 * rejected whole. It never invents a second layout language or executable
 * handler. */
enum class WorkspaceTemplate(val wire: String) {
    PROJECT("project"), PERSON("person"), TRAVEL("travel"), READING("reading");
    companion object {
        fun from(value: String): WorkspaceTemplate = entries.firstOrNull { it.wire == value }
            ?: throw IllegalArgumentException("request.template: unknown template")
    }
}

data class WorkspaceScope(val json: JSONObject) {
    companion object {
        private val sourceId = Regex("^[a-zA-Z0-9_.:-]{1,128}$")
        private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        private val keys = setOf("kind", "sourceIds", "after", "before", "deviceId", "timeZone", "evidenceIds")

        fun all(): WorkspaceScope = WorkspaceScope(JSONObject().put("kind", "all"))

        fun read(value: JSONObject): WorkspaceScope {
            for (key in value.keys()) require(key in keys) { "request.scope: unknown field '$key'" }
            val kind = value.opt("kind") as? String ?: throw IllegalArgumentException("request.scope.kind: string required")
            require(kind == "all" || kind == "selection") { "request.scope.kind: invalid" }
            val result = JSONObject().put("kind", kind)
            if (kind == "selection") {
                val sourceIds = value.optJSONArray("sourceIds")
                val evidenceIds = value.optJSONArray("evidenceIds")
                require(sourceIds != null || evidenceIds != null) { "request.scope: selection requires sourceIds or evidenceIds" }
            }
            value.optJSONArray("sourceIds")?.let { list ->
                require(list.length() <= 1024) { "request.scope.sourceIds: too large" }
                result.put("sourceIds", JSONArray().also { out ->
                    for (index in 0 until list.length()) {
                        val id = list.opt(index) as? String ?: throw IllegalArgumentException("request.scope.sourceIds[$index]: string required")
                        require(sourceId.matches(id)) { "request.scope.sourceIds[$index]: invalid" }
                        out.put(id)
                    }
                })
            }
            value.optJSONArray("evidenceIds")?.let { list ->
                require(list.length() <= 1024) { "request.scope.evidenceIds: too large" }
                result.put("evidenceIds", JSONArray().also { out ->
                    for (index in 0 until list.length()) {
                        val id = list.opt(index) as? String ?: throw IllegalArgumentException("request.scope.evidenceIds[$index]: string required")
                        require(uuid.matches(id)) { "request.scope.evidenceIds[$index]: invalid" }
                        out.put(id.lowercase())
                    }
                })
            }
            for (key in listOf("after", "before")) value.opt(key)?.let { raw ->
                val at = raw as? String ?: throw IllegalArgumentException("request.scope.$key: string required")
                OffsetDateTime.parse(at)
                result.put(key, at)
            }
            val after = result.optString("after").takeIf(String::isNotBlank)
            val before = result.optString("before").takeIf(String::isNotBlank)
            if (after != null && before != null)
                require(OffsetDateTime.parse(after).isBefore(OffsetDateTime.parse(before))) { "request.scope: invalid range" }
            value.opt("deviceId")?.let { raw ->
                val device = raw as? String ?: throw IllegalArgumentException("request.scope.deviceId: string required")
                require(sourceId.matches(device)) { "request.scope.deviceId: invalid" }
                result.put("deviceId", device)
            }
            value.opt("timeZone")?.let { raw ->
                val zone = raw as? String ?: throw IllegalArgumentException("request.scope.timeZone: string required")
                require(zone.length in 1..100) { "request.scope.timeZone: invalid" }
                ZoneId.of(zone)
                result.put("timeZone", zone)
            }
            return WorkspaceScope(result)
        }
    }
}

data class WorkspaceRequest(
    val template: WorkspaceTemplate,
    val scope: WorkspaceScope,
    val matterId: String? = null,
    val personMemoryId: String? = null,
) {
    fun json(): JSONObject = JSONObject().put("template", template.wire).put("scope", scope.json).also { value ->
        matterId?.let { value.put("matterId", it) }
        personMemoryId?.let { value.put("personMemoryId", it) }
    }

    companion object {
        private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        fun read(value: JSONObject): WorkspaceRequest {
            for (key in value.keys()) require(key in setOf("template", "scope", "matterId", "personMemoryId")) { "request: unknown field '$key'" }
            val template = WorkspaceTemplate.from(value.opt("template") as? String ?: throw IllegalArgumentException("request.template: string required"))
            val scope = WorkspaceScope.read(value.opt("scope") as? JSONObject ?: throw IllegalArgumentException("request.scope: object required"))
            fun id(name: String): String? = value.opt(name)?.let { raw ->
                val text = raw as? String ?: throw IllegalArgumentException("request.$name: string required")
                require(uuid.matches(text)) { "request.$name: invalid" }
                text.lowercase()
            }
            val matterId = id("matterId")
            val personMemoryId = id("personMemoryId")
            if (template == WorkspaceTemplate.PERSON) require(matterId == null) { "request.matterId: a person template uses personMemoryId" }
            else require(personMemoryId == null) { "request.personMemoryId: only the person template uses a Memory identity" }
            return WorkspaceRequest(template, scope, matterId, personMemoryId)
        }
    }
}

data class WorkspaceCommandRef(val id: String, val apiVersion: String)

sealed interface WorkspaceCommand {
    val id: String
    val apiVersion: String
    fun json(): JSONObject

    data class Refresh(override val id: String, override val apiVersion: String) : WorkspaceCommand {
        override fun json(): JSONObject = JSONObject().put("id", id).put("apiVersion", apiVersion)
    }
    data class Matter(override val id: String, override val apiVersion: String, val matterId: String, val expectedRevision: Long) : WorkspaceCommand {
        override fun json(): JSONObject = JSONObject().put("id", id).put("apiVersion", apiVersion).put("matterId", matterId).put("expectedRevision", expectedRevision)
    }
    data class MemoryCorrect(override val id: String, override val apiVersion: String, val memoryId: String, val version: Long) : WorkspaceCommand {
        override fun json(): JSONObject = JSONObject().put("id", id).put("apiVersion", apiVersion).put("memoryId", memoryId).put("version", version)
    }
}

data class WorkspaceDescriptor(
    val id: String,
    val kind: String,
    val apiVersion: String,
    val platforms: List<String>,
    val labelKey: String,
    val i18nNamespace: String,
    val commands: List<WorkspaceCommandRef>,
)

data class WorkspaceView(
    val request: WorkspaceRequest,
    val descriptor: WorkspaceDescriptor,
    val spec: DeclarativeSpec,
    val data: JSONObject,
    val commands: List<WorkspaceCommand>,
) {
    /** The exact producer-issued reference. A client never invents a target,
     * revision or implementation from a label or captured text. */
    fun command(id: String): WorkspaceCommand =
        commands.singleOrNull { it.id == id } ?: throw IllegalArgumentException("workspace command is not declared")
}

object WorkspaceDecode {
    private const val MAX_COMMANDS = 64
    private val token = Regex("^[\\x21-\\x7e]{1,256}$")
    private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    private fun keys(obj: JSONObject, allowed: Set<String>, path: String) {
        for (key in obj.keys()) require(key in allowed) { "$path: unknown field '$key'" }
    }
    private fun string(obj: JSONObject, name: String, path: String): String? =
        if (!obj.has(name)) null else (obj.opt(name) as? String ?: throw IllegalArgumentException("$path.$name: string required"))
    private fun token(obj: JSONObject, name: String, path: String): String =
        string(obj, name, path)?.takeIf { token.matches(it) } ?: throw IllegalArgumentException("$path.$name: token required")
    private fun uuid(obj: JSONObject, name: String, path: String): String {
        val value = string(obj, name, path) ?: throw IllegalArgumentException("$path.$name: string required")
        require(uuid.matches(value)) { "$path.$name: invalid" }
        return value.lowercase()
    }
    private fun positive(obj: JSONObject, name: String, path: String): Long {
        val raw = obj.opt(name) as? Number ?: throw IllegalArgumentException("$path.$name: number required")
        val value = raw.toLong()
        require(raw.toDouble() == value.toDouble() && value > 0 && value <= 9007199254740991L) { "$path.$name: positive integer required" }
        return value
    }
    private fun array(obj: JSONObject, name: String, path: String): JSONArray =
        obj.opt(name) as? JSONArray ?: throw IllegalArgumentException("$path.$name: array required")
    private fun boolean(obj: JSONObject, name: String, path: String): Boolean? =
        if (!obj.has(name)) null else (obj.opt(name) as? Boolean ?: throw IllegalArgumentException("$path.$name: boolean required"))

    private fun command(value: JSONObject, path: String): WorkspaceCommand {
        val id = token(value, "id", path)
        val apiVersion = token(value, "apiVersion", path)
        require(apiVersion == "1") { "$path.apiVersion: unsupported" }
        return when (id) {
            "refresh" -> {
                keys(value, setOf("id", "apiVersion"), path)
                WorkspaceCommand.Refresh(id, apiVersion)
            }
            "matter.edit", "matter.pause", "matter.resume", "matter.archive" -> {
                keys(value, setOf("id", "apiVersion", "matterId", "expectedRevision"), path)
                WorkspaceCommand.Matter(id, apiVersion, uuid(value, "matterId", path), positive(value, "expectedRevision", path))
            }
            "memory.correct" -> {
                keys(value, setOf("id", "apiVersion", "memoryId", "version"), path)
                WorkspaceCommand.MemoryCorrect(id, apiVersion, uuid(value, "memoryId", path), positive(value, "version", path))
            }
            else -> throw IllegalArgumentException("$path.id: unknown command")
        }
    }

    private fun descriptor(value: JSONObject): WorkspaceDescriptor {
        keys(value, setOf("id", "kind", "apiVersion", "platforms", "presentation", "commands"), "descriptor")
        val id = token(value, "id", "descriptor")
        val kind = token(value, "kind", "descriptor")
        require(kind == "declarative-view") { "descriptor.kind: only declarative-view is supported" }
        val apiVersion = token(value, "apiVersion", "descriptor")
        require(apiVersion == "1") { "descriptor.apiVersion: unsupported" }
        val platforms = array(value, "platforms", "descriptor")
        require(platforms.length() in 1..8) { "descriptor.platforms: invalid" }
        val platformList = (0 until platforms.length()).map { index ->
            (platforms.opt(index) as? String)?.takeIf { it in setOf("web", "mac", "android") }
                ?: throw IllegalArgumentException("descriptor.platforms[$index]: invalid")
        }
        require("android" in platformList) { "descriptor.platforms: android is not declared" }
        val presentation = value.opt("presentation") as? JSONObject ?: throw IllegalArgumentException("descriptor.presentation: object required")
        keys(presentation, setOf("labelKey", "glyphKey", "a11yKey", "i18nNamespace"), "descriptor.presentation")
        val labelKey = token(presentation, "labelKey", "descriptor.presentation")
        val namespace = token(presentation, "i18nNamespace", "descriptor.presentation")
        presentation.opt("glyphKey")?.let { require(it is String && token.matches(it)) { "descriptor.presentation.glyphKey: token required" } }
        presentation.opt("a11yKey")?.let { require(it is String && token.matches(it)) { "descriptor.presentation.a11yKey: token required" } }
        val commands = array(value, "commands", "descriptor")
        require(commands.length() <= MAX_COMMANDS) { "descriptor.commands: too large" }
        val refs = (0 until commands.length()).map { index ->
            val item = commands.opt(index) as? JSONObject ?: throw IllegalArgumentException("descriptor.commands[$index]: object required")
            keys(item, setOf("id", "apiVersion"), "descriptor.commands[$index]")
            WorkspaceCommandRef(token(item, "id", "descriptor.commands[$index]"), token(item, "apiVersion", "descriptor.commands[$index]").also {
                require(it == "1") { "descriptor.commands[$index].apiVersion: unsupported" }
            })
        }
        require(refs.map { it.id }.toSet().size == refs.size) { "descriptor.commands: duplicate id" }
        return WorkspaceDescriptor(id, kind, apiVersion, platformList, labelKey, namespace, refs)
    }

    fun read(raw: JSONObject): WorkspaceView {
        keys(raw, setOf("request", "descriptor", "spec", "data", "commands"), "workspace")
        val request = WorkspaceRequest.read(raw.opt("request") as? JSONObject ?: throw IllegalArgumentException("workspace.request: object required"))
        val descriptor = descriptor(raw.opt("descriptor") as? JSONObject ?: throw IllegalArgumentException("workspace.descriptor: object required"))
        val commandsJson = array(raw, "commands", "workspace")
        require(commandsJson.length() <= MAX_COMMANDS) { "workspace.commands: too large" }
        val commands = (0 until commandsJson.length()).map { index ->
            val item = commandsJson.opt(index) as? JSONObject ?: throw IllegalArgumentException("workspace.commands[$index]: object required")
            command(item, "workspace.commands[$index]")
        }
        require(commands.map { it.id }.toSet().size == commands.size) { "workspace.commands: duplicate id" }
        require(commands.map { it.id } == descriptor.commands.map { it.id } &&
            commands.map { it.apiVersion } == descriptor.commands.map { it.apiVersion }) {
            "workspace.commands: descriptor directory mismatch"
        }
        val specJson = raw.opt("spec") as? JSONObject ?: throw IllegalArgumentException("workspace.spec: object required")
        val spec = DeclarativePluginView.parse(specJson, commands.map { it.id }.toSet())
        val data = raw.opt("data") as? JSONObject ?: throw IllegalArgumentException("workspace.data: object required")
        return WorkspaceView(request, descriptor, spec, data, commands)
    }
}

/** Authored labels from the shared workspace template. Captured titles,
 * statements, paths and coverage text remain data and are never localized. */
object WorkspaceLabels {
    val labels: Map<String, String> = mapOf(
        "project" to "项目", "person" to "人物", "travel" to "旅行", "reading" to "阅读",
        "title" to "标题", "goal" to "目标", "statement" to "内容", "state" to "状态", "deadline" to "期限",
        "summary" to "内容", "observedAt" to "观察时间", "occurredAt" to "发生时间", "recordedAt" to "记录时间",
        "memory" to "记忆", "commitments" to "承诺", "files" to "文件", "source" to "来源",
        "extraction" to "提取", "semantic" to "语义理解", "embedding" to "向量索引", "original" to "原件",
        "reason" to "原因",
        "pause" to "暂停", "resume" to "恢复", "archive" to "归档事项", "refresh" to "刷新", "submit" to "保存",
        "empty" to "当前范围内没有可用资料。", "unavailable" to "资料已撤回或超出当前范围。",
        "pending" to "待处理", "error" to "部分资料读取失败，请刷新后重试。",
        "failed" to "部分资料读取失败，请刷新后重试。", "limited" to "每个列表最多显示当前范围内的 20 项。",
        "changed" to "操作已失效，请刷新后重试。",
        "matter.edit" to "保存", "matter.pause" to "暂停", "matter.resume" to "恢复", "matter.archive" to "归档事项",
        "memory.correct" to "保存",
    )
    private val states = mapOf(
        "active" to "进行中", "paused" to "已暂停", "archived" to "已归档", "published" to "有效",
        "pending_confirmation" to "待确认", "confirmed" to "已确认", "completed" to "已完成", "cancelled" to "已取消",
        "pending" to "待处理", "partial" to "部分可用", "ready" to "已就绪", "failed" to "失败", "unsupported" to "不支持",
        "succeeded" to "已完成", "uncertain" to "保存结果待核实", "stale" to "原文已更新或删除",
    )

    fun label(key: String): String = labels[key] ?: key

    /** The same display projection as the Web container: only known state
     * values and boolean original availability become authored labels. */
    fun present(data: JSONObject, translate: (String) -> String): JSONObject {
        fun row(source: JSONObject): JSONObject {
            val result = JSONObject()
            for (key in source.keys()) {
                val value = source.opt(key)
                result.put(key, when {
                    key == "original" && value is Boolean -> translate(if (value) "打开" else "不可用")
                    key in setOf("state", "extraction", "semantic", "embedding") && value is String && states.containsKey(value) -> translate(states.getValue(value))
                    else -> value
                })
            }
            return result
        }
        val result = JSONObject()
        for (key in data.keys()) {
            val value = data.opt(key)
            result.put(key, when {
                key == "original" && value is Boolean -> translate(if (value) "打开" else "不可用")
                key in setOf("state", "extraction", "semantic", "embedding") && value is String && states.containsKey(value) -> translate(states.getValue(value))
                value is JSONArray -> JSONArray().also { out ->
                    for (index in 0 until value.length()) {
                        val item = value.opt(index)
                        out.put(if (item is JSONObject) row(item) else item)
                    }
                }
                value is JSONObject -> row(value)
                else -> value
            })
        }
        return result
    }
}
