package dev.mote.collector

import android.Manifest
import android.app.*
import android.content.ComponentName
import android.content.Intent
import android.text.Editable
import android.text.TextWatcher
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.*
import android.provider.Settings as SystemSettings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.*

class MainActivity : Activity() {
    private lateinit var settings: Settings
    private lateinit var content: LinearLayout
    private var loadedServer: String? = null
    private var loadedToken: String? = null
    private var projectionRequestStamp: String? = null
    private var applyingConnectionFields = false
    private lateinit var status: TextView
    private lateinit var server: EditText
    private lateinit var token: EditText
    private lateinit var name: EditText
    private lateinit var interval: EditText
    private lateinit var maxQueue: EditText
    private lateinit var excludes: EditText
    private lateinit var masks: EditText
    private lateinit var review: EditText
    private lateinit var wifi: CheckBox
    private lateinit var http: CheckBox
    private lateinit var projectionMode: CheckBox
    private lateinit var jpegQuality: EditText
    private lateinit var captureMaxSide: EditText
    private lateinit var batteryBelow: EditText
    private lateinit var chargingOnly: CheckBox
    private lateinit var diagnosticEnabled: CheckBox
    private lateinit var diagnosticInterval: EditText
    private lateinit var nsfwEnabled: CheckBox
    private lateinit var nsfwPolicy: EditText
    private lateinit var nsfwMaxTokens: EditText
    private lateinit var nsfwMaxSide: EditText
    private lateinit var nsfwThreads: EditText
    private lateinit var nsfwTimeout: EditText
    private lateinit var nsfwSource: Spinner
    private lateinit var nsfwCustom: EditText
    private lateinit var nsfwStatus: TextView
    private val nsfwSources = listOf("auto", "mirror", "official", "custom")
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() { refreshStatus(); handler.postDelayed(this, 2000) }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        settings = Settings(this)
        val config = runCatching { settings.read() }.getOrElse { CollectorConfig() }
        loadedServer = config.server; loadedToken = config.token
        val scroll = ScrollView(this).apply { setBackgroundColor(Color.rgb(245, 246, 242)); isFillViewport = true }
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(18), dp(22), dp(30)) }
        scroll.addView(content)
        setContentView(scroll)
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION") view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        text("MOTE", 13, Color.rgb(23, 110, 98))
        text("让经历留有线索", 29)
        text("你的 Android 采集端 · 本机隐私处理 · 自选中央节点", 14)
        text("环境：${BuildConfig.MOTE_PROFILE} · ${packageName}\n私有数据目录：${noBackupFilesDir.absolutePath}", 12)
        if (BuildConfig.MOTE_PROFILE == "dev") text("开发版与日常 Mote 独立安装，权限、设备 ID、令牌、草稿、队列和模型互不共享。默认测试端口 47842；模拟器使用 adb reverse tcp:47842 tcp:47842。不会继承日常节点或令牌。", 13)
        status = text("正在读取状态…", 14).apply { setPadding(dp(16), dp(16), dp(16), dp(16)); setBackgroundColor(Color.WHITE) }
        rowButtons("开始采集", { startCapture() }, "停止", { stopCapture() })
        button("立即重试同步") {
            runCatching { val c = settings.read(); c.validate(); UploadWorker.schedule(this, c, true); toast("已请求同步；仍遵守网络约束") }.onFailure { toast(it.message ?: "配置无效") }
        }
        button("连接中央节点（扫码 / JSON）") { startActivity(Intent(this, ConnectionActivity::class.java)) }
        button("采集统计、存储与结果详情") { startActivity(Intent(this, ActivityStatsActivity::class.java)) }
        button("日历与文件来源") { startActivity(Intent(this, SourcesActivity::class.java)) }
        button("应用更新") { startActivity(Intent(this, AppUpdatesActivity::class.java)) }
        section("01  中央节点")
        text("中央节点是独立服务，可在电脑、NAS 或服务器部署。手机的 localhost 指手机本身；请填节点局域网 IP 或 HTTPS 域名。", 13)
        server = field("节点 URL", config.server, "https://mote.example.com", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        token = field("手工访问令牌（也可用上方扫码连接）", config.token, "建议通过邀请获取本设备凭据", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        server.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun afterTextChanged(s: Editable?) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                if (!applyingConnectionFields && !loadedServer.isNullOrBlank() && s.toString().trim().trimEnd('/') != loadedServer!!.trimEnd('/') && token.text.isNotEmpty()) {
                    token.text.clear()
                    toast("节点地址已修改，请明确填写新节点令牌；队列未清空时不能换节点")
                }
            }
        })
        name = field("设备名称", config.deviceName, "我的 K90 Pro Max")
        wifi = check("仅非计费 Wi-Fi 上传（离线仍入队）", config.wifiOnly)
        http = check("允许调试局域网 HTTP（明文，仅私有 IP）", config.debugHttp).apply { isEnabled = BuildConfig.DEBUG }
        section("02  采集与存储")
        interval = field("截图间隔 / 秒（5–300）", config.intervalSeconds.toString(), "30", InputType.TYPE_CLASS_NUMBER)
        maxQueue = field("本机队列上限 / MiB（8–4096）", config.maxQueueMiB.toString(), "256", InputType.TYPE_CLASS_NUMBER)
        text("默认最长边 1280px、JPEG 75，可在下方调整；生效数值见统计详情。相同图片在队列中共用存储。队列 AES-GCM 加密，满后暂停，收到节点确认才删除。时间统计是采样设备时间。", 13)
        projectionMode = check("使用投屏模式（备用，每次需授权）", config.mode == "projection")
        text("默认无障碍截图模式适用 Android 11+：系统重新连接服务时可恢复你已启用的采集。投屏模式锁屏/被杀后必须重新授权。Android 10 请选投屏模式。", 13)
        section("采集优化与开发者选项")
        jpegQuality = field("JPEG 质量（40–95）", config.jpegQuality.toString(), "75", InputType.TYPE_CLASS_NUMBER)
        captureMaxSide = field("保存图最长边（640–2560）", config.captureMaxSide.toString(), "1280", InputType.TYPE_CLASS_NUMBER)
        chargingOnly = check("仅充电时截图", config.chargingOnly)
        batteryBelow = field("电量低于百分之几暂停（0 为关闭，最高 95）", config.batteryPauseBelowPct.toString(), "0", InputType.TYPE_CLASS_NUMBER)
        diagnosticEnabled = check("开发者：记录数值与事件诊断", config.diagnosticsEnabled)
        diagnosticInterval = field("诊断采样间隔 / 秒（15–3600）", config.diagnosticsIntervalSeconds.toString(), "60", InputType.TYPE_CLASS_NUMBER)
        text("仅在应用/采集运行时采样，最多 1440 条。记录整机电量、队列/模型空间、入队/拦截/失败计数、推理/OCR 耗时和上传字节，不包含截图、文字、笔记、令牌或审查理由。电量变化是整机变化，不能归因于 Mote。", 13)
        button("导出数值诊断 JSON") {
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "mote-diagnostics.json"), 103)
        }
        text("事件日志最多 500 条，只记录固定阶段、错误类别与数值。支持包不包含节点地址、设备名、截图、笔记、OCR、令牌、提示词或审查理由；关闭诊断后停止新增，已有记录保留。", 13)
        button("导出安全支持包 JSON") {
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "mote-${BuildConfig.MOTE_PROFILE}-support.json"), 104)
        }
        section("随手记")
        val drafts = QuickNotes.draft(this)
        val restored = runCatching { drafts.read() }
        val note = field("日常、心情或杂事（最多 100000 字符）", restored.getOrNull()?.text ?: "", "记下此刻的想法…", multiline = true)
        val mood = field("心情（可选，最多 80 字符）", restored.getOrNull()?.mood ?: "", "")
        note.filters = arrayOf(android.text.InputFilter.LengthFilter(100000)); mood.filters = arrayOf(android.text.InputFilter.LengthFilter(80))
        var changingDraft = false
        if (restored.isFailure) { note.isEnabled = false; mood.isEnabled = false; text("加密草稿读取失败，原文件保留。可先备份应用数据；明确点击新记才清除旧草稿。", 13) }
        val draftWatcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                if (!changingDraft) try { drafts.update(note.text.toString(), mood.text.toString()) }
                catch (_: Exception) { toast("草稿保存失败，请保持页面打开并检查可用空间") }
            }
        }
        note.addTextChangedListener(draftWatcher); mood.addTextChangedListener(draftWatcher)
        button("保存随手记并同步") {
            try {
                check(note.isEnabled) { "请先处理无法读取的旧草稿" }
                QuickNotes.save(this, note.text.toString(), mood.text.toString())
                changingDraft = true; note.text.clear(); mood.text.clear(); changingDraft = false
                toast("随手记已加密保存，联网后同步"); refreshStatus()
            } catch (error: Exception) { toast(error.message ?: "随手记保存失败，草稿已保留") }
        }
        button("明确新记 / 清除当前草稿") {
            try { drafts.clear(); changingDraft = true; note.text.clear(); mood.text.clear(); changingDraft = false; note.isEnabled = true; mood.isEnabled = true }
            catch (_: Exception) { toast("草稿清除失败") }
        }
        text("输入会加密保存为本机草稿，页面重建后恢复；同次提交失败重试复用 ID。使用已保存的节点配置。手动记录不需截图权限，也不受截图过滤模型阻塞；离线时保留在本机加密队列，节点确认后清除。", 13)
        section("03  隐私规则")
        excludes = field("不采集的应用包名（每行一个或逗号分隔）", config.excludedPackages, "com.example.private", multiline = true)
        text("没有内置应用黑名单。配置排除后，无法识别应用、多个应用窗口或系统遮挡时暂停。投屏模式需要同时启用无障碍服务才能可靠执行排除；仅使用情况权限不足以保证所有可见窗口。", 13)
        masks = field("固定遮罩（每行 left,top,right,bottom）", config.masks, "0,0,1,0.08", multiline = true)
        text("坐标均为 0..1、相对当前屏幕。例如 0,0,1,0.08 遮住顶部 8%。遮罩先于 OCR 和保存；旋转后仍按屏幕比例应用。默认不遮罩，请自行设置。", 13)
        text("内置本机 NSFW 过滤", 19)
        nsfwEnabled = check("启用 NSFW 过滤（默认启用，故障不放行）", config.nsfw.enabled)
        text("内置 Qwen3.5-0.8B 小视觉语言模型，CPU 离线审查，可编辑指令用于其它图片过滤。截图只在内存中送入独立进程。模型拒绝、缺失、输出无效、超时或进程退出时，该帧不会进入 OCR、存储或上传。模型可能误判。", 13)
        nsfwPolicy = field("本机图片审查指令", config.nsfw.policy, "", multiline = true)
        nsfwMaxTokens = field("输出上限 token（32–1024）", config.nsfw.maxTokens.toString(), "256", InputType.TYPE_CLASS_NUMBER)
        nsfwMaxSide = field("审查图最长边（256–1024）", config.nsfw.reviewMaxSide.toString(), "512", InputType.TYPE_CLASS_NUMBER)
        nsfwThreads = field("CPU 线程（1–8）", config.nsfw.threads.toString(), "2", InputType.TYPE_CLASS_NUMBER)
        nsfwTimeout = field("推理超时 / 毫秒（5000–180000，含首次加载）", config.nsfw.timeoutMs.toString(), "60000", InputType.TYPE_CLASS_NUMBER)
        text("模型下载来源", 13)
        nsfwSource = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf("自动：ModelScope → Hugging Face", "国内 ModelScope", "官方 Hugging Face", "自定义 HTTPS 目录"))
            setSelection(nsfwSources.indexOf(config.nsfw.source).coerceAtLeast(0))
            layoutParams = LinearLayout.LayoutParams(-1, dp(48)); content.addView(this)
        }
        nsfwCustom = field("自定义 HTTPS 目录（model.gguf / mmproj.gguf）", config.nsfw.customUrl, "https://your-nas.example/models/qwen", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        text("双模型共约 703 MiB。自动先尝试国内 ModelScope，失败回退 Hugging Face；支持断点续传，取消后保留断点。可在自定义目录托管两个固定文件，或分两次导入本地 GGUF；每次加载前核对完整 SHA-256。下载速度取决于网络。", 13)
        nsfwStatus = text("正在读取模型状态…", 13)
        rowButtons("下载 / 继续", {
            if (saveNsfw()) NsfwDownloadWorker.start(this, wifi.isChecked)
        }, "取消下载", { NsfwDownloadWorker.cancel(this) })
        rowButtons("重载推理进程", {
            NsfwClient.resetAll(); NsfwModelStore(this).inferenceStatus("已重置推理进程，下一帧重新校验并加载")
        }, "导入本地模型", {
            if (saveNsfw()) {
                NsfwDownloadWorker.cancel(this)
                @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), 102)
            }
        })
        review = field("可选本机隐私模型 URL", config.localReviewUrl, "http://127.0.0.1:47833/review", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        text("这是 NSFW 检查后的额外通用隐私审查。仅允许手机本机 loopback；模型拒绝、超时或格式错误时丢弃此帧。模型新增遮罩后重新 OCR。未填写则不调用此额外 HTTP 钩子。", 13)
        button("保存配置") { saveConfig() }
        section("04  权限与 HyperOS")
        button("启用无障碍截图服务") {
            AlertDialog.Builder(this).setTitle("屏幕采集权限说明")
                .setMessage(getString(R.string.accessibility_description) + "\n\n继续后请在系统设置中选择 Mote 屏幕采集。启用服务本身不会开始截图，仍需回到此处点击开始。")
                .setNegativeButton("取消", null).setPositiveButton("打开系统设置") { _, _ -> safeOpen(Intent(SystemSettings.ACTION_ACCESSIBILITY_SETTINGS)) }.show()
        }
        rowButtons("通知权限", { notifications() }, "使用情况权限", { safeOpen(Intent(SystemSettings.ACTION_USAGE_ACCESS_SETTINGS)) })
        rowButtons("电池优化设置", { safeOpen(Intent(SystemSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }, "自启动设置", { autostart() })
        button("应用详情 / 受限制设置") { safeOpen(detailsIntent()) }
        text("小米 / HyperOS：在系统应用设置中允许 Mote 自启动，将省电策略设为无限制，并允许通知；可在最近任务中锁定应用。菜单随系统版本变化。若侧载 APK 的无障碍开关受限，请在应用详情的菜单中检查“允许受限制的设置”。这些设置不能保证系统永不终止采集。", 13)
        text("本构建尚未在 K90 Pro Max 真机验证。无需 Root，不申请相册、麦克风权限；相机只在主动扫码连接时申请；安全窗口不绕过。配置页受 FLAG_SECURE 保护，避免把令牌截进队列。", 13)
        text("${BuildConfig.VERSION_NAME} · Android ${Build.VERSION.RELEASE} / API ${Build.VERSION.SDK_INT}\n${Build.MANUFACTURER} ${Build.MODEL}", 12)
    }
    private fun draft() = CollectorConfig(server.text.toString().trim(), token.text.toString().trim(), name.text.toString().trim(),
        interval.text.toString().toInt(), maxQueue.text.toString().toInt(), wifi.isChecked,
        excludes.text.toString(), masks.text.toString(), review.text.toString().trim(), http.isChecked,
        if (projectionMode.isChecked) "projection" else "accessibility", nsfwDraft(), jpegQuality.text.toString().toInt(), captureMaxSide.text.toString().toInt(), chargingOnly.isChecked, batteryBelow.text.toString().toInt(), diagnosticEnabled.isChecked, diagnosticInterval.text.toString().toInt())
    private fun nsfwDraft() = NsfwConfig(enabled = nsfwEnabled.isChecked, threads = nsfwThreads.text.toString().toInt(),
        timeoutMs = nsfwTimeout.text.toString().toLong(), source = nsfwSources[nsfwSource.selectedItemPosition], customUrl = nsfwCustom.text.toString().trim(),
        policy = nsfwPolicy.text.toString().trim(), maxTokens = nsfwMaxTokens.text.toString().toInt(), reviewMaxSide = nsfwMaxSide.text.toString().toInt())
    private fun saveNsfw(): Boolean = try {
        require(!settings.enabled) { "请先停止采集再修改模型设置" }
        settings.saveNsfw(nsfwDraft()); true
    } catch (error: Exception) { toast(error.message ?: "请检查 NSFW 配置"); false }
    private fun saveConfig(): Boolean = try {
        require(!settings.enabled) { "请先停止采集再修改配置" }
        val c = draft().also { it.validate() }
        val old = settings.read()
        require(queue().depth() == 0 || old.server.trimEnd('/') == c.server.trimEnd('/')) { "队列尚有数据，请先同步到原节点再更换地址，避免误传给另一节点" }
        ConnectionGuard.change(this, c.server) { settings.save(c) }
        UploadWorker.schedule(this, c, true)
        SourceWork.schedule(this, true)
        toast("配置已保存，规则对后续新截图生效")
        true
    } catch (e: Exception) { toast(e.message ?: "请检查配置输入"); false }
    private fun startCapture() {
        if (ConnectionGuard.changing()) { toast("正在连接节点，请稍后再开始采集"); return }
        if (settings.enabled) { toast("已启用，状态见上方"); return }
        if (!saveConfig()) return
        if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) { notifications(); toast("请先允许通知，然后再次点击开始"); return }
        val c = settings.read()
        if (c.mode == "accessibility") {
            if (Build.VERSION.SDK_INT < 30) { toast("Android 10 请勾选投屏模式"); return }
            if (!CaptureAccessibilityService.connected) { toast("请先启用无障碍截图服务，返回后再开始"); return }
            if (!ConnectionGuard.startCapture(this, SourceRules.hash(c.toString())) {
                Operations.record(this, OperationKind.CAPTURE_STARTED)
                settings.status("capturing", "采集已启用，等待首帧；配置页受系统安全保护")
            }) { toast("节点或配置已变化，请重新点击开始"); return }
        } else {
            if (PrivacyRules.exclusions(c.excludedPackages).isNotEmpty() && !CaptureAccessibilityService.connected) {
                toast("已配置应用排除，请先启用无障碍服务以可靠识别可见窗口"); return
            }
            val manager = getSystemService(MediaProjectionManager::class.java)
            val intent = if (Build.VERSION.SDK_INT >= 34) manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay()) else manager.createScreenCaptureIntent()
            projectionRequestStamp = SourceRules.hash(c.toString())
            @Suppress("DEPRECATION") startActivityForResult(intent, 100)
        }
        refreshStatus()
    }
    @Deprecated("Platform consent result API retained for the minimal native Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 103 && resultCode == RESULT_OK && data?.data != null) {
            try { contentResolver.openOutputStream(data.data!!)!!.use { it.write(Diagnostics(this).export().toByteArray()) }; toast("数值诊断已导出") }
            catch (_: Exception) { toast("诊断导出失败") }; return
        }
        if (requestCode == 104 && resultCode == RESULT_OK && data?.data != null) {
            try { contentResolver.openOutputStream(data.data!!)!!.use { it.write(SupportEvents.export(this).toByteArray()) }; SupportEvents.record(this, EventStage.SUPPORT, EventCode.OK); toast("安全支持包已导出") }
            catch (_: Exception) { SupportEvents.record(this, EventStage.SUPPORT, EventCode.STORAGE); toast("支持包导出失败") }; return
        }
        if (requestCode == 102 && resultCode == RESULT_OK && data?.data != null) {
            val uri = data.data!!
            Thread {
                val store = NsfwModelStore(this)
                try { contentResolver.openInputStream(uri)!!.use { store.importModel(it) }; NsfwClient.resetAll() }
                catch (_: Exception) { store.status("导入失败：请选择清单指定文件，并核对大小/SHA-256；原模型未替换") }
            }.start()
            return
        }
        if (requestCode == 100 && resultCode == RESULT_OK && data != null) {
            val stamp = projectionRequestStamp; projectionRequestStamp = null
            if (stamp == null || !ConnectionGuard.startCapture(this, stamp) {
                startForegroundService(Intent(this, ProjectionService::class.java).putExtra("result", resultCode).putExtra("consent", data).putExtra("configurationStamp", stamp))
                Operations.record(this, OperationKind.CAPTURE_STARTED)
            }) settings.status("permission_required", "节点或采集配置已变化，本次授权已丢弃；请重新点击开始")
        } else if (requestCode == 100) settings.status("permission_required", "你未授予投屏权限，未开始截图")
    }
    private fun stopCapture() {
        settings.enabled = false
        Operations.record(this, OperationKind.CAPTURE_STOPPED)
        SupportEvents.record(this, EventStage.CAPTURE, EventCode.STOPPED)
        settings.status("paused", "你已停止采集，已有队列继续同步")
        stopService(Intent(this, ProjectionService::class.java))
        CaptureAccessibilityService.instance?.stopCapture()
        Notifications.clear(this)
        runCatching { UploadWorker.schedule(this, settings.read(), true) }
        refreshStatus()
    }
    private fun refreshStatus() {
        if (!::status.isInitialized) return
        val c = runCatching { settings.read() }.getOrNull()
        if (c != null) runCatching { Diagnostics(this).sample(c) }
        val live = if (c?.mode == "projection") ProjectionService.running else CaptureAccessibilityService.connected
        val state = if (settings.enabled && !live) "采集服务未连接：请恢复权限" else settings.message()
        val stats = runCatching { Operations.ledger(this).read().getJSONObject("counts") }.getOrNull()
        val totals = if (stats == null) "统计暂不可读取" else "本周期保存截图 ${stats.optLong("SCREEN_QUEUED")} · 笔记 ${stats.optLong("NOTE_QUEUED")} · 已确认 ${stats.optLong("SCREEN_ACK") + stats.optLong("NOTE_ACK")}\n拦截 ${stats.optLong("FRAME_BLOCKED")} · 失败 ${stats.optLong("CAPTURE_FAILED")} · 重试结果 ${stats.optLong("UPLOAD_RETRY")}"
        val bytes = runCatching { queue().bytes() / 1024.0 / 1024 }.getOrDefault(0.0)
        status.text = "$state\n$totals\n待上传 ${queue().depth()} 条 · ${"%.1f".format(bytes)} MiB\n${settings.uploadStatus()}\n无障碍 ${if (CaptureAccessibilityService.connected) "已连接" else "未连接"} · 使用情况 ${if (ForegroundApps.usageAllowed(this)) "已授权" else "未授权"}\n最近采集 ${settings.lastCapture() ?: "无"}"
        if (::nsfwStatus.isInitialized) {
            val model = NsfwModelStore(this)
            nsfwStatus.text = "${model.status()}\n${model.inferenceStatus()}"
        }
    }
    private fun notifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
        else safeOpen(Intent(SystemSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SystemSettings.EXTRA_APP_PACKAGE, packageName))
    }
    private fun detailsIntent() = Intent(SystemSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
    private fun autostart() {
        val intent = Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"))
        safeOpen(intent)
    }
    private fun safeOpen(intent: Intent) {
        try { startActivity(intent) }
        catch (_: Exception) { try { startActivity(detailsIntent()); toast("此系统入口不同，请在应用详情或系统搜索中查找") } catch (_: Exception) { toast("请手动打开系统设置") } }
    }
    override fun onResume() {
        super.onResume()
        if (::server.isInitialized) {
            val c = settings.read()
            if (c.server != loadedServer || c.token != loadedToken) {
                applyingConnectionFields = true
                try { server.setText(c.server); token.setText(c.token); name.setText(c.deviceName); loadedServer = c.server; loadedToken = c.token } finally { applyingConnectionFields = false }
            }
        }
        handler.post(refresh)
    }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun text(value: String, size: Int, color: Int = Color.rgb(39, 54, 50)): TextView = TextView(this).apply {
        text = value; textSize = size.toFloat(); setTextColor(color); setLineSpacing(dp(3).toFloat(), 1f)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }
        content.addView(this)
    }
    private fun section(value: String) { text(value, 19).setPadding(0, dp(20), 0, 0) }
    private fun field(label: String, value: String, placeholder: String, type: Int = InputType.TYPE_CLASS_TEXT, multiline: Boolean = false): EditText {
        text(label, 13)
        return EditText(this).apply {
            inputType = if (multiline) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE else type
            setText(value); hint = placeholder; textSize = 15f; setPadding(dp(12), dp(10), dp(12), dp(10))
            setBackgroundColor(Color.WHITE); minHeight = dp(50); if (multiline) minLines = 2
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(15) }; content.addView(this)
        }
    }
    private fun check(label: String, selected: Boolean) = CheckBox(this).apply {
        text = label; isChecked = selected; textSize = 14f; minHeight = dp(48)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) }; content.addView(this)
    }
    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; minHeight = dp(48); setTextColor(Color.rgb(23, 110, 98)); setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(6) }; content.addView(this)
    }
    private fun rowButtons(left: String, leftAction: () -> Unit, right: String, rightAction: () -> Unit) {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        listOf(left to leftAction, right to rightAction).forEach { (label, action) -> row.addView(Button(this).apply {
            text = label; textSize = 14f; isAllCaps = false; setTextColor(Color.rgb(23, 110, 98)); setOnClickListener { action() }
        }, LinearLayout.LayoutParams(0, dp(52), 1f)) }
        content.addView(row)
    }
    private fun toast(message: String) { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
}
