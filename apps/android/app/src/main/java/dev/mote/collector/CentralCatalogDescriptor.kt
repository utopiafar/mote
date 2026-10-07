package dev.mote.collector

import org.json.JSONObject

/** Data-only presentation anchors. New kinds use the native generic reader without downloading code. */
internal data class CentralCatalogType(val id: String, val kind: String, val schemaVersion: Int, val label: String)
internal class CentralCatalogDescriptor private constructor(private val types: List<CentralCatalogType>) {
    fun type(kind: String, schemaVersion: Int): CentralCatalogType? = types.singleOrNull { it.kind == kind && it.schemaVersion == schemaVersion }
    companion object {
        fun read(value: JSONObject): CentralCatalogDescriptor {
            require(value.optInt("schemaVersion") == 1) { "Unsupported library descriptor" }
            val entries = value.optJSONArray("types")
            require((entries?.length() ?: 0) <= 256)
            val anchor = Regex("^[a-zA-Z0-9_.:/-]{1,128}$")
            val types = (0 until (entries?.length() ?: 0)).map { index ->
                val row = entries!!.getJSONObject(index)
                val id = row.getString("id"); val kind = row.getString("kind"); val version = row.getInt("schemaVersion"); val label = row.getString("label")
                require(anchor.matches(id) && !id.contains("://") && !id.startsWith("/") && anchor.matches(kind) && !kind.contains("://") && !kind.startsWith("/") && version > 0 && label.length in 1..120)
                CentralCatalogType(id, kind, version, label)
            }
            require(types.distinctBy { it.id }.size == types.size && types.distinctBy { it.kind to it.schemaVersion }.size == types.size)
            return CentralCatalogDescriptor(types)
        }
    }
}
