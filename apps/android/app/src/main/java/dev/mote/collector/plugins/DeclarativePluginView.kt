package dev.mote.collector.plugins

import org.json.JSONArray
import org.json.JSONObject

/** Kotlin mirror of the frozen declarative-view contract: the same strict
 * wire parsing the TS decoders enforce — allowed keys per level, exact value
 * types (no coercion), declared commands only. Android-free so the contract
 * stays JVM-testable. */
enum class DeclarativeState { PENDING, ERROR, EMPTY, UNAVAILABLE }

sealed interface DeclarativeNode {
    data class Status(val state: DeclarativeState, val textKey: String? = null) : DeclarativeNode
    data class Listing(val itemKey: String, val fields: List<FieldRef>) : DeclarativeNode
    data class Detail(val fields: List<FieldRef>) : DeclarativeNode
    data class Form(val fields: List<FormFieldSpec>, val submitCommand: String? = null) : DeclarativeNode
    data class Action(val command: String, val labelKey: String?) : DeclarativeNode
}
data class FieldRef(val key: String, val labelKey: String? = null, val format: String = "text")
data class FormFieldSpec(val key: String, val labelKey: String? = null, val input: String = "text", val required: Boolean = false)
data class DeclarativeSpec(val components: List<DeclarativeNode>)

/** The real submission path used by declarativePluginView's onClick: the
 * declared controls are read through `read` (CheckBox->Boolean,
 * EditText->raw String), serialized per input type, gated on busy and
 * required — android-free so the production dispatch is JVM-verified.
 * Numbers must be finite: NaN/Infinity are rejected before JSONObject.put
 * could throw. */
sealed interface FormSubmit {
    data class Ready(val input: JSONObject) : FormSubmit
    data class Rejected(val field: String, val reason: String) : FormSubmit
    data object Busy : FormSubmit
}

object DeclarativeSubmit {
    fun dispatch(fields: List<FormFieldSpec>, read: (FormFieldSpec) -> Any?, busy: () -> Boolean): FormSubmit {
        if (busy()) return FormSubmit.Busy
        val input = JSONObject()
        for (f in fields) when (f.input) {
            "boolean" -> {
                val checked = read(f) as? Boolean ?: return FormSubmit.Rejected(f.key, "boolean required")
                if (f.required && !checked) return FormSubmit.Rejected(f.key, "required")
                input.put(f.key, checked)
            }
            "number" -> {
                val raw = (read(f) as? String) ?: return FormSubmit.Rejected(f.key, "text required")
                if (raw.isBlank()) {
                    if (f.required) return FormSubmit.Rejected(f.key, "required")
                } else {
                    val number = raw.toDoubleOrNull()?.takeIf { it.isFinite() }
                        ?: return FormSubmit.Rejected(f.key, "number required")
                    input.put(f.key, number)
                }
            }
            else -> {
                val raw = (read(f) as? String) ?: return FormSubmit.Rejected(f.key, "text required")
                if (f.required && raw.isBlank()) return FormSubmit.Rejected(f.key, "required")
                input.put(f.key, raw)
            }
        }
        return FormSubmit.Ready(input)
    }
}

object DeclarativePluginView {
    private const val MAX_COMPONENTS = 64
    private const val MAX_FIELDS = 32
    private val token = Regex("^[\\x21-\\x7e]{1,256}$")

    private fun keys(obj: JSONObject, allowed: Set<String>, path: String) {
        for (key in obj.keys()) require(key in allowed) { "$path: unknown field '$key'" }
    }
    private fun string(obj: JSONObject, name: String, path: String): String? =
        if (!obj.has(name)) null else (obj.opt(name) as? String ?: throw IllegalArgumentException("$path.$name: string required"))
    private fun token(obj: JSONObject, name: String, path: String): String =
        string(obj, name, path)?.takeIf { token.matches(it) } ?: throw IllegalArgumentException("$path.$name: token required")
    private fun optToken(obj: JSONObject, name: String, path: String): String? =
        string(obj, name, path)?.also { require(token.matches(it)) { "$path.$name: token required" } }
    private fun boolean(obj: JSONObject, name: String, path: String): Boolean? =
        if (!obj.has(name)) null else (obj.opt(name) as? Boolean ?: throw IllegalArgumentException("$path.$name: boolean required"))
    private fun array(obj: JSONObject, name: String, path: String): JSONArray =
        obj.opt(name) as? JSONArray ?: throw IllegalArgumentException("$path.$name: array required")

    fun parse(input: JSONObject, declaredCommands: Set<String>): DeclarativeSpec {
        keys(input, setOf("components"), "root")
        val components = array(input, "components", "root")
        require(components.length() <= MAX_COMPONENTS) { "components: too large" }
        return DeclarativeSpec(List(components.length()) { i ->
            val c = components.opt(i) as? JSONObject ?: throw IllegalArgumentException("components[$i]: object required")
            val path = "components[$i]"
            keys(c, setOf("type", "state", "textKey", "itemKey", "fields", "submitCommand", "command", "labelKey"), path)
            when (val type = token(c, "type", path)) {
                "status" -> when (val wire = token(c, "state", path)) {
                    // Exact wire casing only: 'PENDING' is not a valid state.
                    "pending" -> DeclarativeNode.Status(DeclarativeState.PENDING, optToken(c, "textKey", path))
                    "error" -> DeclarativeNode.Status(DeclarativeState.ERROR, optToken(c, "textKey", path))
                    "empty" -> DeclarativeNode.Status(DeclarativeState.EMPTY, optToken(c, "textKey", path))
                    "unavailable" -> DeclarativeNode.Status(DeclarativeState.UNAVAILABLE, optToken(c, "textKey", path))
                    else -> throw IllegalArgumentException("$path.state: unknown state '$wire'")
                }
                "list" -> DeclarativeNode.Listing(token(c, "itemKey", path), fields(array(c, "fields", path), "$path.fields"))
                "detail" -> DeclarativeNode.Detail(fields(array(c, "fields", path), "$path.fields"))
                "form" -> DeclarativeNode.Form(
                    formFields(array(c, "fields", path), "$path.fields"),
                    optToken(c, "submitCommand", path)?.also {
                        require(it in declaredCommands) { "$path.submitCommand: undeclared" } })
                "action" -> DeclarativeNode.Action(
                    token(c, "command", path).also { require(it in declaredCommands) { "$path.command: undeclared" } },
                    optToken(c, "labelKey", path))
                else -> throw IllegalArgumentException("$path: unknown component type '$type'")
            }
        })
    }

    private fun fields(array: JSONArray, path: String): List<FieldRef> {
        require(array.length() <= MAX_FIELDS) { "$path: too large" }
        return List(array.length()) { j ->
            val f = array.opt(j) as? JSONObject ?: throw IllegalArgumentException("$path[$j]: object required")
            keys(f, setOf("key", "labelKey", "format"), "$path[$j]")
            val format = string(f, "format", "$path[$j]") ?: "text"
            require(format in setOf("text", "number", "date", "badge")) { "$path[$j].format: unknown" }
            FieldRef(token(f, "key", "$path[$j]"), optToken(f, "labelKey", "$path[$j]"), format)
        }
    }

    private fun formFields(array: JSONArray, path: String): List<FormFieldSpec> {
        require(array.length() <= MAX_FIELDS) { "$path: too large" }
        return List(array.length()) { j ->
            val f = array.opt(j) as? JSONObject ?: throw IllegalArgumentException("$path[$j]: object required")
            keys(f, setOf("key", "labelKey", "input", "required"), "$path[$j]")
            // input is required by the wire contract — a missing input is
            // rejected, never silently defaulted like the TS decoders.
            val input = token(f, "input", "$path[$j]")
            require(input in setOf("text", "number", "boolean")) { "$path[$j].input: invalid" }
            FormFieldSpec(token(f, "key", "$path[$j]"), optToken(f, "labelKey", "$path[$j]"), input, boolean(f, "required", "$path[$j]") ?: false)
        }
    }
}
