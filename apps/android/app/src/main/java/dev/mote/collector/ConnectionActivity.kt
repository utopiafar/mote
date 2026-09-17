package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.*
import java.time.Instant
import java.util.concurrent.Executors

class ConnectionActivity : MoteActivity() {
    private lateinit var input: EditText
    private lateinit var name: EditText
    private lateinit var allowHttp: CheckBox
    private lateinit var status: TextView
    private lateinit var preview: TextView
    private lateinit var currentNode: TextView
    private var parsed: ConnectionInvitation? = null
    private val executor = Executors.newSingleThreadExecutor()
    private val task by lazy { UiTask(this, executor, ownsExecutor = false) }
    private val refreshTask by lazy { UiTask(this, executor, ownsExecutor = false) }
    private lateinit var currentConfig: CollectorConfig
    private var deviceId = ""
    private var working = false
    private var applying = false
    private var refreshRequested = false
    private var connectionFinished: (() -> Unit)? = null
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            if (applying && ::status.isInitialized) status.text = RuntimeSettings.progressLabel()
            connectionFinished?.let { complete -> connectionFinished = null; complete() }
            if (refreshRequested && ::currentNode.isInitialized && !working && !task.busy && !refreshTask.busy) {
                refreshRequested = false
                refreshTask.start(MoteI18n.text("正在刷新已保存连接…"), { currentNode.text = it }, {
                    val settings = Settings(applicationContext); settings.read() to settings.deviceId
                }) { result ->
                    if (applying) return@start
                    result.onSuccess { (config, id) -> currentConfig = config; deviceId = id; refreshCurrentNode() }
                        .onFailure { currentNode.text = MoteI18n.text("读取当前连接失败，请重新打开此页重试") }
                }
            }
            handler.postDelayed(this, 500)
        }
    }
    private data class InitialConnection(val config: CollectorConfig, val deviceId: String, val status: String, val statusAt: Long)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val loading = moteDetailPage(); val label = TextView(this); loading.addView(label)
        task.start(MoteI18n.text("正在读取已保存连接…"), { label.text = it }, {
            val settings = Settings(applicationContext); val client = ConnectionClient(applicationContext)
            InitialConnection(settings.read(), settings.deviceId, client.status(), client.statusAt())
        }) { result ->
            result.onSuccess { initial -> currentConfig = initial.config; deviceId = initial.deviceId; buildUi(initial) }
                .onFailure { label.text = MoteI18n.text("无法读取已保存连接，请检查本机存储后重试") }
        }
    }
    private fun buildUi(initial: InitialConnection) {
        val config = initial.config
        val root = moteDetailPage()
        fun text(value: String, size: Float = 15f) = TextView(this).apply { text = value; textSize = size; setPadding(0, 16, 0, 16) }.also(root::addView)
        fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; setOnClickListener { if (!working && !task.busy) runCatching(action).onFailure { showFailure(it) } } }.also(root::addView)
        text(MoteI18n.text("连接中央节点"), 26f)
        text(MoteI18n.text("先在中央网页生成一次性邀请。扫码、选择 JSON 文件或粘贴邀请后，核对节点再确认连接；不会自动开始截图。邀请有效期 10 分钟，请勿分享。"))
        currentNode = text(""); refreshCurrentNode()
        button(MoteI18n.text("复制本设备 ID")) { getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(android.content.ClipData.newPlainText("Mote device ID", deviceId)); Toast.makeText(this, MoteI18n.text("已复制设备 ID，不含凭据"), Toast.LENGTH_SHORT).show() }
        button(MoteI18n.text("扫描连接二维码")) { startActivityForResult(Intent(this, ConnectionScanActivity::class.java), 1) }
        button(MoteI18n.text("选择连接 JSON 文件")) { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain")), 2) }
        input = EditText(this).apply { hint = MoteI18n.text("粘贴 JSON 或 mote://connect…"); minLines = 3; maxLines = 7; isSaveEnabled = false; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            filters = arrayOf(android.text.InputFilter.LengthFilter(ConnectionInvitation.MAX_BYTES * 2)) }; root.addView(input)
        name = EditText(this).apply { hint = MoteI18n.text("设备名称"); setSingleLine(); setText(config.deviceName); filters = arrayOf(android.text.InputFilter.LengthFilter(128)) }; root.addView(name)
        allowHttp = CheckBox(this).apply { text = MoteI18n.text("开发调试：允许本机 loopback HTTP 邀请"); isChecked = config.debugHttp; isEnabled = BuildConfig.DEBUG }; root.addView(allowHttp)
        button(MoteI18n.text("解析并核对节点")) { parseInput() }
        preview = text(MoteI18n.text("还没有解析邀请。外部链接只填入此页，不会自动连接。"))
        button(MoteI18n.text("确认连接此节点")) {
            val invite = parseInput()
            MoteDialogBuilder(this).setTitle(MoteI18n.text("确认连接节点")).setMessage(MoteI18n.text("{0}\n\n将使用已有设备 ID 和当前采集设置。只获取这台设备的采集凭据；设置、队列和模型不会清空。同节点重新配对将使用新凭据继续同步本机待上传截图、笔记和来源。首次连接将把尚未绑定的本机截图、笔记与来源记录绑定到上方节点，并按已选择的同步方式发送。请确认这是你自己的档案地址。已经绑定其他节点的待同步记录不能改投此处。", invite.serverUrl))
                .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("连接")) { _, _ ->
                    val chosenName = name.text.toString().trim(); val debugHttp = allowHttp.isChecked
                    changeConnection(invite.serverUrl, MoteI18n.text("正在兑换邀请并校验设备身份…"), connected = {
                        input.text.clear(); parsed = null; preview.text = MoteI18n.text("连接成功：{0}", invite.serverUrl)
                    }) {
                        ConnectionClient(applicationContext).connect(invite, chosenName, debugHttp, bindLocal = true)
                        MoteI18n.text("连接成功，已自动应用新连接并恢复原采集状态。")
                    }
                }.show()
        }
        button(MoteI18n.text("恢复中断的连接确认")) {
            working = true
            task.start(MoteI18n.text("正在读取待恢复连接…"), { status.text = it }, {
                ConnectionClient(applicationContext).pendingServer() ?: throw ConnectionFailure("no_pending")
            }) { result ->
                working = false
                result.onSuccess { server ->
                    MoteDialogBuilder(this).setTitle(MoteI18n.text("恢复已兑换连接")).setMessage(MoteI18n.text("{0}\n\n将重新联网校验已兑换并加密保存的凭据。确认后，尚未绑定的本机记录会绑定到上方节点并按同步设置发送。", server))
                        .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("恢复")) { _, _ ->
                            val chosenName = name.text.toString().trim(); val debug = allowHttp.isChecked
                            changeConnection(server, MoteI18n.text("正在重新校验设备连接…")) { ConnectionClient(applicationContext).resume(chosenName, debug, bindLocal = true); MoteI18n.text("中断的连接已恢复。") }
                        }.show()
                }.onFailure(::showFailure)
            }
        }
        button(MoteI18n.text("测试已保存的连接")) {
            run(MoteI18n.text("正在测试节点和设备凭据…"), work = { ConnectionClient(applicationContext).test() }) { scope ->
                MoteI18n.text("连接正常 · {0}", if (scope == "collector") MoteI18n.text("本设备采集权限") else MoteI18n.text("手工配置的管理员权限"))
            }
        }
        status = text(MoteI18n.text("{0}\n状态记录时间：{1}", message(initial.status), initial.statusAt.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it) } ?: MoteI18n.text("未测试")))
        text(MoteI18n.text("一次性码已被兑换但网络校验中断时，原配置保持不变；可重试同一邀请，或点击“恢复中断的连接确认”使用本机加密保存的兑换结果；若一次性码已消耗但未收到响应，请重新生成绑定设备的邀请。连接失败信息不会包含令牌或邀请内容。"))
        MoteUi.styleTree(root)
        intent.dataString?.let { raw -> if (raw.length <= ConnectionInvitation.MAX_BYTES * 2) input.setText(raw) else status.text = message("invitation") }
    }
    private fun parseInput(): ConnectionInvitation {
        parsed = null; preview.text = MoteI18n.text("还没有解析有效邀请。")
        val invite = ConnectionInvitation.parse(input.text.toString(), allowHttp.isChecked, BuildConfig.DEBUG)
        parsed = invite; preview.text = MoteI18n.text("将连接：{0}\n有效至：{1}\n确认前不会发送网络请求。", invite.serverUrl, invite.expiresAt)
        status.text = MoteI18n.text("邀请已解析，请核对节点并确认连接。当前连接尚未更改。")
        return invite
    }
    private fun <T> run(progress: String, work: () -> T, completed: (T) -> String) {
        if (working || task.busy) return
        working = true; status.text = progress
        task.start(progress, { status.text = it }, { work() }) { result ->
            working = false; result.onSuccess { status.text = completed(it) }.onFailure(::showFailure)
        }
    }
    private fun refreshCurrentNode() {
        currentNode.text = MoteI18n.text("当前节点：{0}\n设备 ID：{1}\n已有设备请让中央生成绑定此设备 ID 的邀请；设备身份不会重置。", currentConfig.server.ifBlank { MoteI18n.text("尚未配置") }, deviceId)
    }
    override fun onResume() { super.onResume(); refreshRequested = true; handler.post(refresh) }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }
    private fun changeConnection(server: String, progress: String, connected: () -> Unit = {}, work: () -> String) {
        if (working) return
        working = true; applying = true; status.text = progress
        var message = MoteI18n.text("连接已更新")
        RuntimeSettings.apply(this, currentConfig, bindLocal = true, change = { message = work() }, nextServer = server) { result ->
            if (isDestroyed || isFinishing) return@apply
            connectionFinished = {
                working = false; applying = false
                RuntimeSettings.currentConfiguration?.let { currentConfig = it }; refreshCurrentNode()
                result.onSuccess {
                    connected(); status.text = message
                    if (it.projectionConsentRequired) startActivity(Intent(this, MainActivity::class.java))
                }.onFailure(::showFailure)
            }
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
            val debugHttp = allowHttp.isChecked
            run(MoteI18n.text("正在读取所选连接文件…"), work = {
                val bytes = contentResolver.openInputStream(data.data!!)!!.use { stream ->
                    val buffer = ByteArray(ConnectionInvitation.MAX_BYTES + 1); var total = 0
                    while (total < buffer.size) { val count = stream.read(buffer, total, buffer.size - total); if (count < 0) break; total += count }; buffer.copyOf(total)
                }
                if (bytes.size > ConnectionInvitation.MAX_BYTES) throw ConnectionFailure("invitation")
                val raw = AppReleaseVerifier.utf8(bytes)
                val invite = ConnectionInvitation.parse(raw, debugHttp, BuildConfig.DEBUG)
                raw to invite
            }) { (raw, invite) ->
                input.setText(raw); parsed = invite; preview.text = MoteI18n.text("将连接：{0}\n有效至：{1}\n请确认后连接。", invite.serverUrl, invite.expiresAt)
                MoteI18n.text("连接文件已解析，尚未联网。")
            }
        }
    }
    override fun onDestroy() { connectionFinished = null; handler.removeCallbacks(refresh); executor.shutdown(); super.onDestroy() }
    companion object {
        fun message(code: String) = when (code) {
            "storage" -> MoteI18n.text("凭据持久保存失败，恢复记录仍保留。请释放空间后恢复连接，不要卸载应用。")
            "no_pending" -> MoteI18n.text("没有可恢复的兑换结果，请重新生成邀请。")
            "unchecked" -> MoteI18n.text("尚未测试连接"); "connected" -> MoteI18n.text("上次连接测试成功（不是持续在线保证）")
            "invitation" -> MoteI18n.text("邀请格式或节点不安全。请使用中央生成的 JSON/二维码；公网节点须为 HTTPS。")
            "expired", "invite_rejected" -> MoteI18n.text("邀请已失效、已使用或不匹配，请重新生成。")
            "device_conflict" -> MoteI18n.text("中央已有此设备 ID。请用上方设备 ID 生成绑定邀请，再试一次；不会更换设备身份。")
            "local_confirmation" -> MoteI18n.text("本机有尚未绑定节点的资料，请确认档案地址后再连接。")
            "pending" -> MoteI18n.text("仍有截图/笔记/来源待同步或已准备提交的草稿，不能切换节点。请先同步原节点。")
            "busy" -> MoteI18n.text("另一次设置操作尚未完成，请稍候再试。")
            "authentication" -> MoteI18n.text("节点拒绝当前凭据，请生成绑定本设备的邀请。")
            "identity", "response" -> MoteI18n.text("节点响应或设备身份校验失败，未确认连接；旧配置保留。")
            "rate_limit" -> MoteI18n.text("节点暂时限流，稍后重试。"); "network" -> MoteI18n.text("节点连接失败，请检查地址、网络与 TLS 证书后重试。")
            else -> MoteI18n.text("连接未完成，请检查邀请并重试。")
        }
    }
}
