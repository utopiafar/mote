package dev.mote.collector

import java.net.URI
import java.net.URLDecoder

/** SAF document IDs are provider-defined opaque values, not filesystem paths. */
internal object SafIdentity {
    private fun parts(value: String): Pair<String, List<String>>? = runCatching {
        val uri = URI(value)
        require(uri.scheme == "content" && !uri.authority.isNullOrBlank() && uri.rawQuery == null && uri.rawFragment == null)
        uri.authority to uri.rawPath.split('/').filter(String::isNotEmpty).map {
            URLDecoder.decode(it.replace("+", "%2B"), "UTF-8")
        }
    }.getOrNull()

    fun root(value: String?, tree: Boolean): Pair<String, String>? {
        val (authority, path) = parts(value ?: return null) ?: return null
        val index = if (tree && path.firstOrNull() == "tree") 0 else if (!tree) documentIndex(path) else -1
        return if (index >= 0 && index + 1 < path.size) authority to path[index + 1] else null
    }

    private fun documentIndex(path: List<String>) = when {
        path.size >= 2 && path[0] == "document" -> 0
        path.size >= 4 && path[0] == "tree" && path[2] == "document" -> 2
        else -> -1
    }
    fun document(value: String): Pair<String, String>? {
        val (authority, path) = parts(value) ?: return null
        val index = documentIndex(path)
        return if (index >= 0 && index + 1 < path.size) authority to path[index + 1] else null
    }
    /** A retained document URI can identify its original tree selection. */
    fun selection(value: String, tree: Boolean): String? = runCatching {
        val uri = URI(value)
        require(uri.scheme == "content" && !uri.rawAuthority.isNullOrBlank() && uri.rawQuery == null && uri.rawFragment == null)
        if (!tree) value else {
            val path = uri.rawPath.split('/').filter(String::isNotEmpty)
            require(path.size >= 2 && path[0] == "tree")
            "content://${uri.rawAuthority}/tree/${path[1]}"
        }
    }.getOrNull()
}
