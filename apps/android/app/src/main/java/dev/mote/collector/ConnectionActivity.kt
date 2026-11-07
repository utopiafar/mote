package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.plugins.AdministrationConnection
import dev.mote.collector.plugins.NativeAdministrationPlugin
import java.time.Instant
import java.util.concurrent.Executors

class ConnectionActivity : MoteActivity() {
    private lateinit var input: EditText
    private lateinit var name: EditText
    private lateinit var allowHttp: CheckBox
    private lateinit var status: TextView
    private lateinit var preview: TextView
    private lateinit var currentNode: TextView
    private lateinit var confirmAction: Button
    private lateinit var invitationForm: LinearLayout
    private lateinit var reviewForm: LinearLayout
    private lateinit var reviewName: EditText
    private lateinit var inviteNotice: TextView
    private lateinit var pendingCountView: TextView
    private var parsed: ConnectionInvitation? = null
    private data class PickerSelection(val stamp: String, val requestCode: Int)
    private class RetainedPicker(val selection: PickerSelection?, val result: Pair<Int, String>?, val input: String, val name: String, val debugHttp: Boolean, val reviewing: Boolean)
    private var retainedEditor: RetainedPicker? = null
    private var selection: PickerSelection? = null
    private var pendingPicker: Pair<Int, String>? = null
    private val executor = Executors.newSingleThreadExecutor()
    private val administration by lazy { NativeAdministrationPlugin.owner(this) }
    private val connection by lazy { administration.connection(applicationContext) }
    private val task by lazy { UiTask(this, executor, ownsExecutor = false) }
    private val refreshTask by lazy { UiTask(this, executor, ownsExecutor = false) }
    private lateinit var currentConfig: CollectorConfig
    private var deviceId = ""
    private var working = false
    private var applying = false
    private var connectingInvite = false
    private var refreshRequested = false
    private var connectionFinished: (() -> Unit)? = null
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            if (applying && ::status.isInitialized) status.text = if (connectingInvite) ConnectionPresentation.connecting else administration.progressLabel()
            connectionFinished?.let { complete -> connectionFinished = null; complete() }
            if (::input.isInitialized && !working && !task.busy) pendingPicker?.let { receivePickerResult(it) }
            if (refreshRequested && ::currentNode.isInitialized && !working && !task.busy && !refreshTask.busy) {
                refreshRequested = false
                refreshTask.start(MoteI18n.text("正在刷新已保存连接…"), { currentNode.text = it }, {
                    administration.current(applicationContext)
                }) { result ->
                    if (applying) return@start
                    result.onSuccess { (config, id) -> currentConfig = config; deviceId = id; refreshCurrentNode() }
                        .onFailure { currentNode.text = MoteI18n.text("读取当前连接失败，请重新打开此页重试") }
                }
            }
            handler.postDelayed(this, 500)
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        savedInstanceState?.getString(SELECTION_STAMP)?.let { stamp ->
            val request = savedInstanceState.getInt(SELECTION_REQUEST)
            if (stamp.matches(Regex("[a-f0-9]{64}")) && request in 1..2) selection = PickerSelection(stamp, request)
        }
        (lastNonConfigurationInstance as? RetainedPicker)?.let { retained -> retainedEditor = retained; selection = retained.selection; pendingPicker = retained.result }
        val loading = moteDetailPage(title = MoteI18n.text("连接你的 Mote")); val label = TextView(this); loading.addView(label)
        task.start(MoteI18n.text("正在读取已保存连接…"), { label.text = it }, {
            administration.initialConnection(applicationContext)
        }) { result ->
            result.onSuccess { initial -> currentConfig = initial.config; deviceId = initial.deviceId; buildUi(initial) }
                .onFailure { label.text = MoteI18n.text("无法读取已保存连接，请检查本机存储后重试") }
        }
    }
    private fun buildUi(initial: AdministrationConnection.Initial) {
        val config = initial.config
        val root = moteDetailPage(title = MoteI18n.text("连接你的 Mote"),onBack = { onBackPressed() })
        fun text(value: String, size: Float = MoteTheme.fontBody.toFloat()) = TextView(this).apply { text = value; MoteUi.type(this, size.toInt()); setPadding(0, moteDp(MoteTheme.spaceInline), 0, moteDp(MoteTheme.spaceInline)) }.also(root::addView)
        fun button(label: String, primary: Boolean = false, action: () -> Unit) = MoteUi.button(Button(this).apply { text = label; setOnClickListener { if (!working && !task.busy) runCatching(action).onFailure { showFailure(it) } } }, primary).also(root::addView)
        text(MoteI18n.text("先在中央网页生成一次性邀请。扫码、选择 JSON 文件或粘贴邀请后，核对节点再确认连接；不会自动开始截图。邀请有效期 10 分钟，请勿分享。"))
        currentNode = text(""); refreshCurrentNode()
        button(MoteI18n.text("复制本设备 ID")) { getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(android.content.ClipData.newPlainText("Mote device ID", deviceId)); Toast.makeText(this, MoteI18n.text("已复制设备 ID，不含凭据"), Toast.LENGTH_SHORT).show() }
        text(MoteI18n.text("设备名称"))
        name = EditText(this).apply { hint = MoteI18n.text("设备名称"); setSingleLine(); setText(config.deviceName); filters = arrayOf(android.text.InputFilter.LengthFilter(128)) }
        root.addView(name, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(MoteTheme.spaceInline) })
        button(MoteI18n.text("保存设备名称"), primary = true) {
            val chosen = name.text.toString().trim()
            require(chosen.isNotBlank() && chosen.length <= 128)
            val expected = currentConfig
            working = true; applying = true
            administration.saveDeviceName(this, expected, chosen) { result ->
                connectionFinished = {
                    working = false; applying = false
                    administration.currentConfiguration()?.let { currentConfig = it }; refreshCurrentNode()
                    result.onSuccess { status.text = MoteI18n.text("设备名称已保存") }.onFailure(::showFailure)
                }
            }
        }
        val scan = button(MoteI18n.text("扫描二维码")) { armPicker(1); startActivityForResult(Intent(this, ConnectionScanActivity::class.java), 1) }
        val choose = button(MoteI18n.text("选择邀请文件")) { armPicker(2); startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain")), 2) }
        input = EditText(this).apply { hint = MoteI18n.text("粘贴 JSON 或 mote://connect…"); MoteUi.textInput(this,android.text.InputType.TYPE_CLASS_TEXT,multiline = true); minLines = 3; maxLines = 7; isSaveEnabled = false; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            filters = arrayOf(android.text.InputFilter.LengthFilter(ConnectionInvitation.MAX_BYTES * 2)) }; root.addView(input)
        allowHttp = CheckBox(this).apply { text = MoteI18n.text("开发调试：允许本机 loopback HTTP 邀请"); isChecked = config.debugHttp; isEnabled = BuildConfig.DEBUG }; root.addView(allowHttp)
        val inspect = button(MoteI18n.text("核对连接"),primary = true) { parseInput() }
        preview = text(MoteI18n.text("还没有解析邀请。外部链接只填入此页，不会自动连接。"))
        confirmAction = button(MoteI18n.text("确认连接"),primary = true) {
            val invite = connection.stage(input.text.toString(), allowHttp.isChecked)
            val chosenName = reviewName.text.toString().trim(); val debugHttp = allowHttp.isChecked
            name.setText(chosenName)
            working = true; applying = true; connectingInvite = true
            confirmAction.text = ConnectionPresentation.connecting
            status.text = ConnectionPresentation.connecting
            connection.confirm(currentConfig, chosenName, debugHttp) { result ->
                if (isDestroyed || isFinishing) return@confirm
                connectionFinished = {
                    working = false; applying = false; connectingInvite = false
                    administration.currentConfiguration()?.let { currentConfig = it }; refreshCurrentNode()
                    result.onSuccess {
                        input.text.clear(); parsed = null; preview.text = MoteI18n.text("连接成功：{0}", invite.serverUrl); confirmAction.visibility = View.GONE
                        status.text = MoteI18n.text("连接成功，已自动应用新连接并恢复原采集状态。")
                        if (it.projectionConsentRequired) startActivity(Intent(this, MainActivity::class.java))
                    }.onFailure(::showFailure)
                }
            }
        }
        button(MoteI18n.text("恢复中断的连接确认")) {
            working = true
            task.start(MoteI18n.text("正在读取待恢复连接…"), { status.text = it }, {
                administration.pendingServer(applicationContext) ?: throw ConnectionFailure("no_pending")
            }) { result ->
                working = false
                result.onSuccess { server ->
                    MoteDialogBuilder(this).setTitle(MoteI18n.text("恢复已兑换连接")).setMessage(MoteI18n.text("{0}\n\n将重新联网校验已兑换并加密保存的凭据。确认后，尚未绑定的本机记录会绑定到上方节点并按同步设置发送。", server))
                        .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("恢复")) { _, _ ->
                            val chosenName = name.text.toString().trim(); val debug = allowHttp.isChecked
                            working = true; applying = true; status.text = MoteI18n.text("正在重新校验设备连接…")
                            administration.resumeConnection(applicationContext, currentConfig, server, chosenName, debug) { resumed ->
                                if (isDestroyed || isFinishing) return@resumeConnection
                                connectionFinished = {
                                    working = false; applying = false
                                    administration.currentConfiguration()?.let { currentConfig = it }; refreshCurrentNode()
                                    resumed.onSuccess {
                                        status.text = MoteI18n.text("中断的连接已恢复。")
                                        if (it.projectionConsentRequired) startActivity(Intent(this, MainActivity::class.java))
                                    }.onFailure(::showFailure)
                                }
                            }
                        }.show()
                }.onFailure(::showFailure)
            }
        }
        button(MoteI18n.text("测试已保存的连接")) {
            run(MoteI18n.text("正在测试节点和设备凭据…"), work = { administration.testConnection(applicationContext) }) {
                MoteI18n.text("连接正常 · {0}", MoteI18n.text("节点所有者"))
            }
        }
        status = text(MoteI18n.text("{0}\n状态记录时间：{1}", message(initial.status), initial.statusAt.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it) } ?: MoteI18n.text("未测试")))
        // The invitation path is primary; all existing identity/recovery tools stay in a disclosure.
        val advanced = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE; tag = "connection-advanced" }
        val primaryViews = setOf(scan,choose,input,inspect,preview,confirmAction,status)
        val old = (0 until root.childCount).map(root::getChildAt)
        root.removeAllViews(); old.filter { it !in primaryViews }.forEach(advanced::addView)
        root.setPadding(moteDp(20),moteDp(28),moteDp(20),moteDp(28))
        text(MoteI18n.text("把记录接到一起"),22f).apply { MoteUi.type(this,NativeFontRole.TITLE_MOBILE); MoteUi.textColor(this,NativeColorRole.INK) }
        text(MoteI18n.text("在中央工作台的「设备」里获取连接邀请。"),13f).apply { MoteUi.textColor(this,NativeColorRole.MUTED); setPadding(0,moteDp(6),0,moteDp(24)) }
        inviteNotice = TextView(this).apply {
            visibility = View.GONE
            text = ConnectionPresentation.invalidInvitation
            MoteUi.type(this, NativeFontRole.SUPPORT)
            MoteUi.textColor(this, NativeColorRole.INK)
            setPadding(moteDp(16), moteDp(12), moteDp(16), moteDp(12))
        }
        root.addView(inviteNotice, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = moteDp(14) })
        val choices = LinearLayout(this).apply { gravity = android.view.Gravity.CENTER_VERTICAL; isBaselineAligned = false }
        choices.addView(scan,LinearLayout.LayoutParams(0,-2,1f).apply { marginEnd = moteDp(8) })
        choices.addView(choose,LinearLayout.LayoutParams(0,-2,1f)); root.addView(choices)
        text(MoteI18n.text("或粘贴邀请"),11f).apply { MoteUi.textColor(this,NativeColorRole.MUTED); setPadding(0,moteDp(24),0,moteDp(10)) }
        MoteUi.field(input); root.addView(input,LinearLayout.LayoutParams(-1,moteDp(130)))
        val actions = SecondaryUi.actions(root).apply { setPadding(0,moteDp(12),0,moteDp(20)) }
        actions.addView(inspect,android.view.ViewGroup.MarginLayoutParams(-2,-2))
        actions.addView(MoteUi.action(Button(this).apply { text = MoteI18n.text("稍后连接"); setOnClickListener { if (!working && !task.busy) finish() } },MoteUi.ButtonRole.TEXT),android.view.ViewGroup.MarginLayoutParams(-2,-2).apply { marginStart = moteDp(8) })
        preview.visibility = View.GONE; confirmAction.visibility = View.GONE
        root.addView(preview); root.addView(confirmAction); root.addView(status)
        if (initial.status == "unchecked" && !config.hasSyncConnection()) status.text = ""
        root.addView(View(this).apply { MoteUi.backgroundColor(this,NativeColorRole.DIVIDER) },LinearLayout.LayoutParams(-1,moteDp(1)))
        MoteUi.action(button(MoteI18n.text("还没有自己的 Mote？")) { startActivity(Intent(this,StartUsingActivity::class.java).putExtra("firstUse",intent.getBooleanExtra("firstUse",false))) },MoteUi.ButtonRole.TEXT)
        MoteUi.action(button(MoteI18n.text("连接管理与设备信息")) { advanced.visibility = if (advanced.visibility == View.VISIBLE) View.GONE else View.VISIBLE },MoteUi.ButtonRole.TEXT)
        root.addView(advanced)
        val entryViews = (0 until root.childCount).map(root::getChildAt).filter { it !in setOf(preview,confirmAction,status) }
        root.removeAllViews()
        invitationForm = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; isFocusableInTouchMode = true; entryViews.forEach(::addView) }
        reviewForm = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; isFocusableInTouchMode = true; visibility = View.GONE }
        fun reviewText(value: String, role: NativeFontRole) = TextView(this).apply { text = value; MoteUi.type(this,role); MoteUi.textColor(this,if (role == NativeFontRole.SUPPORT) NativeColorRole.MUTED else NativeColorRole.INK); setPadding(0,moteDp(8),0,moteDp(12)) }.also(reviewForm::addView)
        reviewText(MoteI18n.text("核对连接"),NativeFontRole.META)
        reviewText(MoteI18n.text("这是你的 Mote 吗？"),NativeFontRole.TITLE_MOBILE)
        preview.background = MoteUi.shape(this); preview.setPadding(moteDp(20),moteDp(20),moteDp(20),moteDp(20)); reviewForm.addView(preview)
        reviewText(ConnectionPresentation.selfDevice, NativeFontRole.SUPPORT)
        reviewText(MoteI18n.text("设备名称"),NativeFontRole.SUPPORT)
        reviewName = MoteUi.field(EditText(this).apply { isSingleLine = true; isSaveEnabled = false; filters = arrayOf(android.text.InputFilter.LengthFilter(128)); contentDescription = MoteI18n.text("设备名称") })
        reviewForm.addView(reviewName)
        val pendingRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(0, moteDp(8), 0, moteDp(12)) }
        pendingRow.addView(TextView(this).apply {
            text = ConnectionPresentation.pendingSend
            MoteUi.type(this, NativeFontRole.SUPPORT)
            MoteUi.textColor(this, NativeColorRole.INK)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        pendingCountView = TextView(this).apply {
            text = ConnectionPresentation.pendingCountLabel(null)
            MoteUi.type(this, NativeFontRole.SUPPORT)
            MoteUi.textColor(this, NativeColorRole.MUTED)
        }
        pendingRow.addView(pendingCountView)
        reviewForm.addView(pendingRow)
        reviewText(MoteI18n.text("这台设备将可以访问你的全部资料和设置。\n新保存的记录将按当前发送设置同步到这里。"),NativeFontRole.SUPPORT)
        val consent = reviewText(MoteI18n.text("将使用已有设备 ID 和当前采集设置，不会清空设置、队列或模型。首次连接会把尚未绑定的本机资料绑定到此节点；已绑定其他节点的待同步资料不能改投。"),NativeFontRole.SUPPORT)
        consent.textSize = 11f
        val reviewActions = SecondaryUi.actions(reviewForm)
        reviewActions.addView(confirmAction,android.view.ViewGroup.MarginLayoutParams(-2,-2))
        reviewActions.addView(MoteUi.action(Button(this).apply { text = MoteI18n.text("返回修改"); setOnClickListener { if (!working && !task.busy) showInvitation() } },MoteUi.ButtonRole.SECONDARY),android.view.ViewGroup.MarginLayoutParams(-2,-2).apply { marginStart = moteDp(8) })
        root.addView(invitationForm); root.addView(reviewForm); root.addView(status)
        MoteUi.styleTree(root)
        retainedEditor?.let { retained ->
            input.setText(retained.input); name.setText(retained.name); allowHttp.isChecked = retained.debugHttp; retainedEditor = null
            if (retained.reviewing) runCatching { parseInput() }.onFailure(::showFailure)
        }
            ?: intent.dataString?.let { raw -> if (raw.length <= ConnectionInvitation.MAX_BYTES * 2) input.setText(raw) else showInvalidInvitation() }
    }
    private fun parseInput(): ConnectionInvitation {
        parsed = null; confirmAction.visibility = View.GONE; preview.visibility = View.VISIBLE; preview.text = MoteI18n.text("还没有解析有效邀请。")
        val invite = connection.stage(input.text.toString(), allowHttp.isChecked)
        parsed = invite; preview.text = MoteI18n.text("将连接：{0}\n有效至：{1}\n确认前不会发送网络请求。", invite.serverUrl, invite.expiresAt)
        confirmAction.visibility = View.VISIBLE
        status.text = ""
        showReview()
        return invite
    }
    private fun showReview() {
        if (::inviteNotice.isInitialized) inviteNotice.visibility = View.GONE
        invitationForm.visibility = View.GONE; reviewForm.visibility = View.VISIBLE; reviewName.setText(name.text)
        preview.visibility = View.VISIBLE; confirmAction.visibility = View.VISIBLE
        confirmAction.text = ConnectionPresentation.confirm
        resetPagePosition(reviewForm)
        refreshPendingCount()
    }
    private fun showInvitation(clearNotice: Boolean = true) {
        name.setText(reviewName.text); reviewForm.visibility = View.GONE; invitationForm.visibility = View.VISIBLE
        if (clearNotice) {
            if (::inviteNotice.isInitialized) inviteNotice.visibility = View.GONE
            status.text = ""
        }
        resetPagePosition(invitationForm)
    }
    private fun showInvalidInvitation() {
        showInvitation(clearNotice = false)
        inviteNotice.text = ConnectionPresentation.invalidInvitation
        inviteNotice.visibility = View.VISIBLE
        status.text = ""
        confirmAction.text = ConnectionPresentation.confirm
    }
    private fun refreshPendingCount() {
        if (!::pendingCountView.isInitialized) return
        pendingCountView.text = ConnectionPresentation.pendingCountLabel(null)
        executor.execute {
            val count = runCatching { SyncSchedule.pending(this).count }.getOrNull()
            handler.post {
                if (!isDestroyed && !isFinishing && ::pendingCountView.isInitialized)
                    pendingCountView.text = ConnectionPresentation.pendingCountLabel(count)
            }
        }
    }
    private fun resetPagePosition(form: View) {
        currentFocus?.clearFocus(); form.requestFocus()
        getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(form.windowToken,0)
        form.post { if (!isDestroyed && !isFinishing) {
            var ancestor = form.parent
            while (ancestor is View) { if (ancestor is ScrollView) ancestor.scrollTo(0,0); ancestor = ancestor.parent }
        } }
    }
    @Deprecated("Native Activity back navigation")
    override fun onBackPressed() { if (::reviewForm.isInitialized && reviewForm.visibility == View.VISIBLE && !working) showInvitation() else super.onBackPressed() }
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
    private fun showFailure(error: Throwable) {
        connectingInvite = false
        if (error is SettingsChangedFailure) {
            status.text = error.message
            focusStatus(status)
            return
        }
        val category = (error as? ConnectionFailure)?.category ?: if (error is SettingsWriteFailure) "storage" else "response"
        if (ConnectionPresentation.isInvalidInvitation(category) && ::inviteNotice.isInitialized) {
            showInvalidInvitation()
            focusStatus(inviteNotice)
            return
        }
        status.text = ConnectionPresentation.visibleNotice(category)
        if (::reviewForm.isInitialized && reviewForm.visibility == View.VISIBLE) {
            confirmAction.text = ConnectionPresentation.retry
            confirmAction.visibility = View.VISIBLE
        }
        focusStatus(status)
    }
    private fun focusStatus(target: View) {
        target.post { if (!isDestroyed && !isFinishing) target.requestRectangleOnScreen(Rect(0, 0, target.width, target.height), false) }
    }
    private fun armPicker(requestCode: Int) {
        selection = PickerSelection(SourceRules.hash(currentConfig.toString()), requestCode)
        pendingPicker = null
    }
    @Deprecated("Native Activity document result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode !in 1..2 || selection?.requestCode != requestCode) return
        if (resultCode != RESULT_OK || data == null) {
            if (pendingPicker == null) selection = null
            return
        }
        val payload = when (requestCode) {
            1 -> data.getStringExtra("invitation").orEmpty().takeIf { it.length <= ConnectionInvitation.MAX_BYTES * 2 }.orEmpty()
            else -> data.data?.toString().orEmpty()
        }
        pendingPicker = requestCode to payload
        if (::input.isInitialized && !working && !task.busy) receivePickerResult(requestCode to payload)
    }
    private fun receivePickerResult(result: Pair<Int, String>) {
        val expected = selection ?: return
        if (expected.requestCode != result.first || working || task.busy) return
        val debugHttp = allowHttp.isChecked
        parsed = null; preview.text = MoteI18n.text("还没有解析有效邀请。")
        working = true
        task.start(MoteI18n.text("正在读取所选连接文件…"), { status.text = it }, {
            if (SourceRules.hash(administration.settings(applicationContext).read().toString()) != expected.stamp) throw SettingsChangedFailure()
            val bytes = if (result.first == 1) result.second.toByteArray(Charsets.UTF_8) else contentResolver.openInputStream(Uri.parse(result.second))!!.use { stream ->
                val buffer = ByteArray(ConnectionInvitation.MAX_BYTES + 1); var total = 0
                while (total < buffer.size) { val count = stream.read(buffer, total, buffer.size - total); if (count < 0) break; total += count }; buffer.copyOf(total)
            }
            if (bytes.size > ConnectionInvitation.MAX_BYTES) throw ConnectionFailure("invitation")
            val raw = AppReleaseVerifier.utf8(bytes)
            val invite = connection.stage(raw, debugHttp)
            if (SourceRules.hash(administration.settings(applicationContext).read().toString()) != expected.stamp) throw SettingsChangedFailure()
            raw to invite
        }) { outcome ->
            working = false
            if (isDestroyed || isFinishing || pendingPicker != result || selection != expected) return@start
            // Preserve both fields until this callback: a destroyed UiTask cannot deliver it.
            pendingPicker = null; selection = null
            outcome.onSuccess { (raw, invite) ->
                if (SourceRules.hash(currentConfig.toString()) != expected.stamp) { showFailure(SettingsChangedFailure()); return@onSuccess }
                input.setText(raw); parsed = invite
                preview.visibility = View.VISIBLE; confirmAction.visibility = View.VISIBLE
                preview.text = MoteI18n.text("将连接：{0}\n有效至：{1}\n请确认后连接。", invite.serverUrl, invite.expiresAt)
                status.text = MoteI18n.text("连接文件已解析，尚未联网。")
                showReview()
            }.onFailure(::showFailure)
        }
    }
    override fun onSaveInstanceState(outState: Bundle) {
        selection?.let { outState.putString(SELECTION_STAMP, it.stamp); outState.putInt(SELECTION_REQUEST, it.requestCode) }
        super.onSaveInstanceState(outState)
    }
    @Deprecated("Native in-memory configuration retention")
    override fun onRetainNonConfigurationInstance(): Any? = if (::input.isInitialized) {
        val reviewing = ::reviewForm.isInitialized && reviewForm.visibility == View.VISIBLE
        RetainedPicker(selection,pendingPicker,input.text.toString(),if (reviewing) reviewName.text.toString() else name.text.toString(),allowHttp.isChecked,reviewing)
    } else retainedEditor
    override fun onDestroy() { connectionFinished = null; handler.removeCallbacks(refresh); executor.shutdown(); super.onDestroy() }
    companion object {
        private const val SELECTION_STAMP = "pickerSelectionStamp"
        private const val SELECTION_REQUEST = "pickerSelectionRequest"
        fun message(code: String) = ConnectionPresentation.message(code)
    }
}
