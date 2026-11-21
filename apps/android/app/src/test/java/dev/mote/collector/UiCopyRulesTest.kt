package dev.mote.collector

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** CP2-01: authored Android messages follow the interface copy rules. */
class UiCopyRulesTest {
    private val banned = listOf("不代表", "不等于", "只表示", "并不意味着")
    private val notInsteadOfBut = Regex("不是[^。！？\\n]*而是")
    private val permittedQing = Regex("请求|申请|邀请")
    private val trailingArrow = Regex("[\\u2192\\u2197]\\s*$")
    private val han = Regex("\\p{IsHan}")
    private val call = Regex("MoteI18n\\.text\\(\"((?:[^\"\\\\\\n]|\\\\.)*)\"")

    /** Promise copy keeps its exact meaning and is exempt from the length limit, as in the shared checker. */
    private val promises: Set<String> = run {
        var directory: File? = File(".").absoluteFile
        while (directory != null && !File(directory, "scripts/ui-copy-promises.json").isFile) directory = directory.parentFile
        val file = directory?.let { File(it, "scripts/ui-copy-promises.json") }
        assertTrue("scripts/ui-copy-promises.json must be reachable", file != null)
        val array = org.json.JSONArray(file!!.readText())
        (0 until array.length()).map(array::getString).toSet()
    }

    @Test fun androidMessagesPassTheInterfaceCopyRules() {
        val sourceRoot = File("src/main/java")
        val sources = sourceRoot.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue("Android sources must be present", sources.size > 100)
        val messages = linkedSetOf<Pair<String, String>>()
        for (file in sources) {
            val path = file.relativeTo(sourceRoot).invariantSeparatorsPath
            for (match in call.findAll(file.readText())) messages += path to unescape(match.groupValues[1])
        }
        assertTrue("Authored Android messages must be discoverable", messages.map { it.second }.toSet().size > 2000)
        val violations = messages.filter { (_, message) -> han.containsMatchIn(message) }.mapNotNull { (path, message) ->
            val hanCount = han.findAll(message).count()
            // Keep the existing length baseline for the status in the protected transport file.
            val protectedRecoveryStatus = path == "dev/mote/collector/plugins/DurableTransportPlugin.kt" &&
                message == "操作已请求；重复点击会合并，等待网络条件或当前操作完成"
            val problem = when {
                banned.any(message::contains) || notInsteadOfBut.containsMatchIn(message) -> "banned phrase"
                message.replace(permittedQing, "").contains("请") -> "polite request"
                trailingArrow.containsMatchIn(message) -> "trailing arrow"
                hanCount > 24 && message !in promises && !protectedRecoveryStatus -> "too long ($hanCount)"
                else -> null
            }
            problem?.let { "$path: $it: \"$message\"" }
        }
        assertTrue("Android interface copy must pass the rules:\n${violations.joinToString("\n")}", violations.isEmpty())
    }

    private fun unescape(value: String): String = buildString {
        var index = 0
        while (index < value.length) {
            val character = value[index++]
            if (character != '\\' || index >= value.length) { append(character); continue }
            when (val escaped = value[index++]) {
                'n' -> append('\n')
                't' -> append('\t')
                'r' -> append('\r')
                '"' -> append('"')
                '\\' -> append('\\')
                '$' -> append('$')
                else -> append(escaped)
            }
        }
    }
}
