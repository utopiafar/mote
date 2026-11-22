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
        "已确认范围。真实接入可能产生模型与 Embedding 费用，费用以实际服务用量为准。",
        "这台设备将可以访问你的全部资料和设置。\n新保存的记录将按当前发送设置同步到这里。",
        "将使用已有设备 ID 和当前采集设置，不会清空设置、队列或模型。首次连接会把尚未绑定的本机资料绑定到此节点；已绑定其他节点的待同步资料不能改投。",
        "会重发本机仍保留的截图、页面、应用活动、通知、设备事件、笔记及已启用来源的保留版本。中央核验相同 ID 去重，继续补齐缺失数据。\n\n已从手机清理的数据无法补传。中央已删除或内容冲突的记录不会覆盖或恢复，暂停的来源不会启用。此操作可能产生较多流量，仍遵守网络设置。",
        "只检查手机仍保留的采集记录在中央是否可见；不会把“中央存在”直接当作上传确认，也不会删除或恢复记录。",
        "需要处理时：\n• 网络或服务暂不可用：自动模式退避重试，手动模式再次点同步。\n• 授权失效：重新连接同一节点后同步。\n• 同 ID 内容冲突 / 中央已删除：保留本机副本，跳过该条继续其他记录，不自动覆盖。\n• 待复核：仅在逐条明确释放后允许上传，更改审查规则不会自动释放。\n\n中央显示的是上次联系时的状态，不是手机实时状态。",
        "{0}\n本机保留 {1} 条 · 待发 {2} 条\n需处理 {3} 条\n来源待发 {4} 个版本 / {5} 项设置\n\n{6}\n最后收到上传确认：{7}",
        "已安排补传 {0} 条本机采集记录及 {1} 个保留来源版本；实际上传进度见下方同步状态。冲突和中央已删除记录保持隔离。",
        "这场会议将同时录制麦克风与系统音频，结束后上传到你的中央并转写。请确认已告知在场的人并得到同意。该确认只在本机记住一次；取消则不会开始录音。",
        "仅清理已确认上传的本机副本；保留时间、来源和上传凭据，不影响中央归档或用户源文件。",
        "只有点击开始后才会录音；不会按日历或日程自动开始。第一次开始时先请告知在场的人。结束后音频进入中央已有转写，不会与记录页的语音附件或飞书妙记、钉钉闪记合并。",
        "已于 {0} 开始。麦克风与系统音频同时采集；仅在你点击结束后生成一场会议的音频。",
        "麦克风与系统音频权限将在开始时检查；缺少任一项都不会开始。",
        "Android 通过通知使用权开放通知与媒体会话。开启通知采集后，Mote 会保存应用公开的标题、正文、持续状态以及发布和更新事件，并按同步策略上传。设备事件单独记录亮屏、熄屏和锁定状态。各来源需单独开启并点击开始；应用的“不记录”和“仅活动”规则仍适用。系统可能隐藏敏感通知；Mote 不回复通知、不控制播放。",
        "迁移到{0}：\n{1}\n\n已有图片和队列记录会一起迁移。验证成功后切换位置并清理旧副本。中央归档位置保持不变。",
        "{0}\n\n本机已有尚未绑定的截图、笔记或来源资料。确认后会绑定到这个档案地址，并按你的同步策略发送。请核对这是你自己的节点。",
        "只清空累计数字和最近事件，并记录新起算时间。不会删除队列、模型、配置或中央资料。",
        "本机副本清理尚未完成；请重试，尚存输入不会用于重新上传。",
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
