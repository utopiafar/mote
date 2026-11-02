package dev.mote.collector.plugins

import org.json.JSONArray
import org.json.JSONObject

/** Kotlin mirror of the frozen declarative-view contract: strictly parsed
 * declared components only — never executable callbacks, SQL or URLs. This
 * model stays android-free so the contract is JVM-testable; the consumer
 * maps nodes into native widgets later. */
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

object DeclarativePluginView {
    private const val MAX_COMPONENTS = 64
    private const val MAX_FIELDS = 32
    private val token = Regex("^[\\x21-\\x7e]{1,256}$")
    private fun token(value: Any?, path: String): String =
        (value as? String)?.takeIf { token.matches(it) } ?: throw IllegalArgumentException("$path: token required")

    fun parse(input: JSONObject, declaredCommands: Set<String>): DeclarativeSpec {
        val components = input.optJSONArray("components")
            ?: throw IllegalArgumentException("components: array required")
        require(components.length() <= MAX_COMPONENTS) { "components: too large" }
        return DeclarativeSpec(List(components.length()) { i ->
            val c = components.optJSONObject(i) ?: throw IllegalArgumentException("components[$i]: object required")
            val path = "components[$i]"
            when (c.optString("type")) {
                "status" -> DeclarativeNode.Status(
                    runCatching { DeclarativeState.valueOf(c.getString("state").uppercase()) }
                        .getOrElse { throw IllegalArgumentException("$path: unknown state") },
                    c.optString("textKey").ifEmpty { null })
                "list" -> DeclarativeNode.Listing(token(c.opt("itemKey"), "$path.itemKey"), fields(c.optJSONArray("fields"), "$path"))
                "detail" -> DeclarativeNode.Detail(fields(c.optJSONArray("fields"), "$path"))
                "form" -> DeclarativeNode.Form(
                    formFields(c.optJSONArray("fields"), "$path"),
                    c.optString("submitCommand").ifEmpty { null }?.also {
                        require(it in declaredCommands) { "$path: undeclared submitCommand" } })
                "action" -> DeclarativeNode.Action(
                    token(c.opt("command"), "$path.command").also {
                        require(it in declaredCommands) { "$path: undeclared action command" } },
                    c.optString("labelKey").ifEmpty { null })
                else -> throw IllegalArgumentException("$path: unknown component type")
            }
        })
    }

    private fun fields(array: JSONArray?, path: String): List<FieldRef> {
        array ?: throw IllegalArgumentException("$path.fields: array required")
        require(array.length() <= MAX_FIELDS) { "$path.fields: too large" }
        return List(array.length()) { j ->
            val f = array.optJSONObject(j) ?: throw IllegalArgumentException("$path.fields[$j]: object required")
            val format = f.optString("format", "text")
            require(format in setOf("text", "number", "date", "badge")) { "$path.fields[$j]: unknown format" }
            FieldRef(token(f.opt("key"), "$path.fields[$j].key"), f.optString("labelKey").ifEmpty { null }, format)
        }
    }

    private fun formFields(array: JSONArray?, path: String): List<FormFieldSpec> {
        array ?: throw IllegalArgumentException("$path.fields: array required")
        require(array.length() <= MAX_FIELDS) { "$path.fields: too large" }
        return List(array.length()) { j ->
            val f = array.optJSONObject(j) ?: throw IllegalArgumentException("$path.fields[$j]: object required")
            val input = f.optString("input", "text")
            require(input in setOf("text", "number", "boolean")) { "$path.fields[$j]: invalid input" }
            FormFieldSpec(token(f.opt("key"), "$path.fields[$j].key"), f.optString("labelKey").ifEmpty { null }, input, f.optBoolean("required"))
        }
    }
}
