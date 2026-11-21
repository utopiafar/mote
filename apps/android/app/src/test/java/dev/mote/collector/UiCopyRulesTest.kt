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

    /** Complete consequence copy owned by main; the shared checker freezes these catalog entries in the baseline. */
    private val consequential: Set<String> = setOf(
        "中央尚不支持两端检查。升级中央代码后重试；未修改本机状态",
        "所选 {0} 条。{1}保留图不会删除。已同步的中央副本不受影响。恢复后会继续原有同步与 OCR 流程。",
        "{0}\n\n将重新联网校验已兑换并加密保存的凭据。确认后，尚未绑定的本机记录会绑定到上方节点并按同步设置发送。",
        "请编辑来源并确认完整文件上传到中央处理，处理后不保留中央原件。",
        "断开会停止读取并暂停这些来源，保留已归档资料。飞书端授权及 CLI 凭据仍保留，可在飞书中单独撤销。",
    )

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
                message.replace(permittedQing, "").contains("请") && message !in consequential -> "polite request"
                trailingArrow.containsMatchIn(message) -> "trailing arrow"
                hanCount > 24 && message !in promises && message !in consequential && !protectedRecoveryStatus -> "too long ($hanCount)"
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
