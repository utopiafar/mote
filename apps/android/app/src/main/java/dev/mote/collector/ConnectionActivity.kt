package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.*
import java.time.Instant
import java.util.concurrent.Executors

class ConnectionActivity : Activity() {
    private lateinit var input: EditText
    private lateinit var name: EditText
    private lateinit var allowHttp: CheckBox
    private lateinit var status: TextView
    private lateinit var preview: TextView
    private lateinit var currentNode: TextView
    private var parsed: ConnectionInvitation? = null
    private val executor = Executors.newSingleThreadExecutor()
    private var working = false
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val settings = Settings(this); val config = settings.read()
        val root = moteDetailPage()
        fun text(value: String, size: Float = 15f) = TextView(this).apply { text = value; textSize = size; setPadding(0, 16, 0, 16) }.also(root::addView)
        fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; setOnClickListener { if (!working) runCatching(action).onFailure { showFailure(it) } } }.also(root::addView)
        text("连接中央节点", 26f)
        text("先在中央网页生成一次性邀请。扫码、选择 JSON 文件或粘贴邀请后，核对节点再确认连接；不会自动开始截图。邀请有效期 10 分钟，请勿分享。")
        currentNode = text(""); refreshCurrentNode()
        button("复制本设备 ID") { getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(android.content.ClipData.newPlainText("Mote device ID", settings.deviceId)); Toast.makeText(this, "已复制设备 ID，不含凭据", Toast.LENGTH_SHORT).show() }
        button("扫描连接二维码") { startActivityForResult(Intent(this, ConnectionScanActivity::class.java), 1) }
        button("选择连接 JSON 文件") { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain")), 2) }
        input = EditText(this).apply { hint = "粘贴 JSON 或 mote://connect…"; minLines = 3; maxLines = 7; isSaveEnabled = false; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            filters = arrayOf(android.text.InputFilter.LengthFilter(ConnectionInvitation.MAX_BYTES * 2)) }; root.addView(input)
        name = EditText(this).apply { hint = "设备名称"; setSingleLine(); setText(config.deviceName); filters = arrayOf(android.text.InputFilter.LengthFilter(128)) }; root.addView(name)
        allowHttp = CheckBox(this).apply { text = "开发调试：允许本机 loopback HTTP 邀请"; isChecked = config.debugHttp; isEnabled = BuildConfig.DEBUG }; root.addView(allowHttp)
        button("解析并核对节点") { parseInput() }
        preview = text("还没有解析邀请。外部链接只填入此页，不会自动连接。")
        button("确认连接此节点") {
            val invite = parseInput()
            AlertDialog.Builder(this).setTitle("确认连接节点").setMessage("${invite.serverUrl}\n\n将使用已有设备 ID 和当前采集设置。只获取这台设备的采集凭据；设置、队列和模型不会清空。同节点重新配对将使用新凭据继续同步本机待上传截图、笔记和来源。首次连接将把尚未绑定的本机截图、笔记与来源记录绑定到上方节点，并按已选择的同步方式发送。请确认这是你自己的档案地址。已经绑定其他节点的待同步记录不能改投此处。")
                .setNegativeButton("取消", null).setPositiveButton("连接") { _, _ ->
                    val chosenName = name.text.toString().trim(); val debugHttp = allowHttp.isChecked
                    changeConnection(invite.serverUrl, "正在兑换邀请并校验设备身份…") {
                        ConnectionClient(this).connect(invite, chosenName, debugHttp, bindLocal = true)
                        runOnUiThread { input.text.clear(); parsed = null; preview.text = "连接成功：${invite.serverUrl}" }
                        "连接成功，已自动应用新连接并恢复原采集状态。"
                    }
                }.show()
        }
        button("恢复中断的连接确认") {
            val client = ConnectionClient(this); val server = client.pendingServer() ?: throw ConnectionFailure("no_pending")
            AlertDialog.Builder(this).setTitle("恢复已兑换连接").setMessage("$server\n\n使用上次已兑换并加密保存的本设备凭据，不再使用一次性码；将重新联网校验。若存在尚未绑定的本机记录，确认后会绑定到上方节点，并按同步设置发送。")
                .setNegativeButton("取消", null).setPositiveButton("恢复") { _, _ ->
                    val chosenName = name.text.toString().trim(); val debug = allowHttp.isChecked
                    changeConnection(server, "正在重新校验设备连接…") { client.resume(chosenName, debug, bindLocal = true); "中断的连接已恢复。" }
                }.show()
        }
        button("测试已保存的连接") { run("正在测试节点和设备凭据…") { val scope = ConnectionClient(this).test(); "连接正常 · ${if (scope == "collector") "本设备采集权限" else "手工配置的管理员权限"}" } }
        status = text("${message(ConnectionClient(this).status())}\n状态记录时间：${ConnectionClient(this).statusAt().takeIf { it > 0 }?.let { Instant.ofEpochMilli(it) } ?: "未测试"}")
        text("一次性码已被兑换但网络校验中断时，原配置保持不变；可重试同一邀请，或点击“恢复中断的连接确认”使用本机加密保存的兑换结果；若一次性码已消耗但未收到响应，请重新生成绑定设备的邀请。连接失败信息不会包含令牌或邀请内容。")
        MoteUi.styleTree(root)
        intent.dataString?.let { raw -> if (raw.length <= ConnectionInvitation.MAX_BYTES * 2) input.setText(raw) else status.text = message("invitation") }
    }
    private fun parseInput(): ConnectionInvitation {
        parsed = null; preview.text = "还没有解析有效邀请。"
        val invite = ConnectionInvitation.parse(input.text.toString(), allowHttp.isChecked, BuildConfig.DEBUG)
        parsed = invite; preview.text = "将连接：${invite.serverUrl}\n有效至：${invite.expiresAt}\n确认前不会发送网络请求。"
        status.text = "邀请已解析，请核对节点并确认连接。当前连接尚未更改。"
        return invite
    }
    private fun run(progress: String, work: () -> String) {
        if (working) return
        working = true; status.text = progress
        executor.execute { try { val result = work(); runOnUiThread { if (!isDestroyed) status.text = result } }
            catch (e: Exception) { runOnUiThread { if (!isDestroyed) showFailure(e) } }
            finally { runOnUiThread { working = false } } }
    }
    private fun refreshCurrentNode() {
        val settings = Settings(this)
        currentNode.text = "当前节点：${settings.read().server.ifBlank { "尚未配置" }}\n设备 ID：${settings.deviceId}\n已有设备请让中央生成绑定此设备 ID 的邀请；设备身份不会重置。"
    }
    override fun onResume() { super.onResume(); refreshCurrentNode() }
    private fun changeConnection(server: String, progress: String, work: () -> String) {
        if (working) return
        working = true; status.text = "$progress"
        var message = "连接已更新"
        RuntimeSettings.apply(this, Settings(this).read(), bindLocal = true, change = { message = work() }, nextServer = server) { result ->
            working = false
            if (isDestroyed) return@apply
            refreshCurrentNode()
            result.onSuccess {
                status.text = message
                if (it.projectionConsentRequired) startActivity(Intent(this, MainActivity::class.java))
            }.onFailure(::showFailure)
        }
    }
    private fun showFailure(error: Throwable) { status.text = message((error as? ConnectionFailure)?.category ?: if (error is SettingsWriteFailure) "storage" else "response") }
    @Deprecated("Native Activity document result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data == null) return
        if (requestCode == 1) {
            val raw = data.getStringExtra("invitation") ?: return
            if (raw.length <= ConnectionInvitation.MAX_BYTES * 2) { input.setText(raw); runCatching { parseInput() }.onFailure(::showFailure) }
        } else if (requestCode == 2 && data.data != null) {
            run("正在读取所选连接文件…") {
                val bytes = contentResolver.openInputStream(data.data!!)!!.use { stream ->
                    val buffer = ByteArray(ConnectionInvitation.MAX_BYTES + 1); var total = 0
                    while (total < buffer.size) { val count = stream.read(buffer, total, buffer.size - total); if (count < 0) break; total += count }; buffer.copyOf(total)
                }
                if (bytes.size > ConnectionInvitation.MAX_BYTES) throw ConnectionFailure("invitation")
                val raw = AppReleaseVerifier.utf8(bytes)
                val invite = ConnectionInvitation.parse(raw, allowHttp.isChecked, BuildConfig.DEBUG)
                runOnUiThread { input.setText(raw); parsed = invite; preview.text = "将连接：${invite.serverUrl}\n有效至：${invite.expiresAt}\n请确认后连接。" }
                "连接文件已解析，尚未联网。"
            }
        }
    }
    override fun onDestroy() { executor.shutdown(); super.onDestroy() }
    companion object {
        fun message(code: String) = when (code) {
            "storage" -> "凭据持久保存失败，恢复记录仍保留。请释放空间后恢复连接，不要卸载应用。"
            "no_pending" -> "没有可恢复的兑换结果，请重新生成邀请。"
            "unchecked" -> "尚未测试连接"; "connected" -> "上次连接测试成功（不是持续在线保证）"
            "invitation" -> "邀请格式或节点不安全。请使用中央生成的 JSON/二维码；公网节点须为 HTTPS。"
            "expired", "invite_rejected" -> "邀请已失效、已使用或不匹配，请重新生成。"
            "device_conflict" -> "中央已有此设备 ID。请用上方设备 ID 生成绑定邀请，再试一次；不会更换设备身份。"
            "local_confirmation" -> "本机有尚未绑定节点的资料，请确认档案地址后再连接。"
            "pending" -> "仍有截图/笔记/来源待同步或已准备提交的草稿，不能切换节点。请先同步原节点。"
            "busy" -> "另一次设置操作尚未完成，请稍候再试。"
            "authentication" -> "节点拒绝当前凭据，请生成绑定本设备的邀请。"
            "identity", "response" -> "节点响应或设备身份校验失败，未确认连接；旧配置保留。"
            "rate_limit" -> "节点暂时限流，稍后重试。"; "network" -> "节点连接失败，请检查地址、网络与 TLS 证书后重试。"
            else -> "连接未完成，请检查邀请并重试。"
        }
    }
}
