package dev.mote.collector

import android.Manifest
import android.app.*
import android.content.ActivityNotFoundException
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
    private lateinit var captureTitle: TextView
    private lateinit var syncStatus: TextView
    private lateinit var totalsStatus: TextView
    private lateinit var technicalStatus: TextView
    private lateinit var captureAction: Button
    private lateinit var connectionSummary: TextView
    private lateinit var saveBar: LinearLayout
    private lateinit var saveHint: TextView
    private lateinit var pagesHost: FrameLayout
    private val pages = linkedMapOf<Page, ScrollView>()
    private val scrollPositions = mutableMapOf<Page, Int>()
    private val navigation = linkedMapOf<Page, TextView>()
    private val controls = mutableListOf<View>()
    private val controlPages = mutableMapOf<View, Page>()
    private val fieldLabels = mutableMapOf<EditText, TextView>()
    private var baseline = emptyMap<String, String>()
    private var initializing = true
    private var buildingPage = Page.OVERVIEW
    private var currentPage = Page.OVERVIEW
    private enum class Page(val title: String, val parent: String? = null) {
        OVERVIEW("概览"), NOTES("随手记"), SOURCES("来源"), SETTINGS("设置"),
        CONNECTION("连接与同步", "SETTINGS"), CAPTURE("采集与存储", "SETTINGS"),
        PRIVACY("隐私与应用规则", "SETTINGS"), PERMISSIONS("权限与后台运行", "SETTINGS"),
        ABOUT("关于与更新", "SETTINGS"), DEVELOPER("开发者选项", "ABOUT"),
        DIAGNOSTICS("诊断与支持", "DEVELOPER"), MODEL("模型高级设置", "DEVELOPER")
    }
    private data class RetainedDraft(val fields: Map<String, String>, val server: String?, val token: String?)
    private lateinit var server: EditText
    private lateinit var token: EditText
    private lateinit var name: EditText
    private lateinit var interval: EditText
    private lateinit var maxQueue: EditText
    private lateinit var excludes: EditText
    private lateinit var masks: EditText
    private lateinit var review: EditText
    private lateinit var syncMode: Spinner
    private lateinit var syncInterval: EditText
    private lateinit var syncBatch: EditText
    private val syncModes = listOf("realtime", "interval", "batch", "manual")
    private lateinit var appRuleRows: LinearLayout
    private lateinit var maskEditor: MaskEditorView
    private lateinit var wifi: CheckBox
    private lateinit var http: CheckBox
    private lateinit var projectionMode: CheckBox
    private lateinit var appDefault: Spinner
    private lateinit var appPolicies: EditText
    private lateinit var metadataEnabled: CheckBox
    private lateinit var jpegQuality: EditText
    private lateinit var captureMaxSide: EditText
    private lateinit var batteryBelow: EditText
    private lateinit var chargingOnly: CheckBox
    private lateinit var ocrChargingOnly: CheckBox
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
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { navigateBack() }
        settings = Settings(this)
        val config = runCatching { settings.read() }.getOrElse { CollectorConfig() }
        loadedServer = config.server; loadedToken = config.token
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setBackgroundColor(MoteUi.background); moteInsets()
        }
        pagesHost = FrameLayout(this)
        root.addView(pagesHost, LinearLayout.LayoutParams(-1, 0, 1f))
        saveBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(22), dp(10), dp(22), dp(10)); setBackgroundColor(Color.WHITE)
        }
        saveHint = TextView(this).apply { textSize = 12f; setTextColor(MoteUi.muted) }
        saveBar.addView(saveHint, LinearLayout.LayoutParams(0, -2, 1f))
        saveBar.addView(MoteUi.button(Button(this).apply {
            text = "保存设置"; setOnClickListener { saveConfig() }
        }, true), LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(12) })
        root.addView(saveBar)
        val nav = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(dp(12), dp(8), dp(12), dp(8)); setBackgroundColor(Color.WHITE)
            elevation = dp(2).toFloat()
        }
        listOf(Page.OVERVIEW, Page.NOTES, Page.SOURCES, Page.SETTINGS).forEach { page ->
            val item = TextView(this).apply {
                text = page.title; textSize = 11f; gravity = Gravity.CENTER; minHeight = dp(60)
                compoundDrawablePadding = dp(4); isFocusable = true
                contentDescription = page.title; setOnClickListener { showPage(page) }
            }
            navigation[page] = item
            nav.addView(item, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(3); marginEnd = dp(3) })
        }
        root.addView(nav)
        setContentView(root)
        buildOverview()
        buildNotes()
        buildSources()
        buildSettings()
        buildConnection(config)
        buildCapture(config)
        buildPrivacy(config)
        buildPermissions()
        buildAbout()
        buildDeveloper(config)
        buildDiagnostics(config)
        buildModel(config)
        baseline = controlValues()
        (lastNonConfigurationInstance as? RetainedDraft)?.let { retained ->
            applyingConnectionFields = true
            val connectionChanged = retained.server != config.server || retained.token != config.token
            try { controls.forEach { view -> retained.fields[view.tag as String]?.let { value ->
                if (!connectionChanged || view !in listOf(server, token, name, http)) when (view) {
                    is EditText -> view.setText(value)
                    is CheckBox -> view.isChecked = value.toBoolean()
                    is Spinner -> view.setSelection(value.toInt())
                }
            } } } finally { applyingConnectionFields = false }
        }
        initializing = false
        val restoredPage = savedInstanceState?.getString("page")?.let { value -> Page.entries.find { it.name == value } } ?: Page.OVERVIEW
        showPage(restoredPage)
        refreshStatus()
    }

    private fun buildOverview() {
        page(Page.OVERVIEW, "让经历留有线索")
        card(MoteUi.tint) {
            text("此刻的 Mote", 12, MoteUi.accent)
            captureTitle = text("采集已暂停", 26)
            status = text("正在读取状态…", 14, MoteUi.muted)
            captureAction = button("开始采集", true) { if (settings.enabled) stopCapture() else startCapture() }
            text("未连接节点也能采集；随时可以暂停。", 12, MoteUi.muted)
        }
        section("同步状态")
        card {
            syncStatus = text("正在读取同步状态…", 14)
            rowButtons("立即同步", { retrySync() }, "连接设置", { showPage(Page.CONNECTION) })
        }
        section("本机记录")
        totalsStatus = text("正在读取统计…", 15)
        menu("采集记录", "按天查看本机与中央归档的图片、OCR 状态和文字", "capture") { startActivity(Intent(this, CaptureRecordsActivity::class.java)) }
        menu("采集与存储详情", "查看累计结果、队列与使用空间", "chart") { startActivity(Intent(this, ActivityStatsActivity::class.java)) }
        menu("权限与后台运行", "管理采集权限和省电设置", "settings") { showPage(Page.PERMISSIONS) }
        text("本机采集与同步独立运行。记录加密保存在本机，空间达到上限会暂停新增。", 12, MoteUi.muted)
    }

    private fun buildSettings() {
        page(Page.SETTINGS, "按你的习惯，照顾好每一份记录")
        section("偏好设置")
        menu("连接与同步", "中央节点、设备名称与上传网络", "sync") { showPage(Page.CONNECTION) }
        menu("采集与存储", "采样频率、图像质量与电量策略", "capture") { showPage(Page.CAPTURE) }
        menu("隐私与应用规则", "应用采集级别、遮罩与本机过滤", "shield") { showPage(Page.PRIVACY) }
        section("应用")
        menu("权限与后台运行", "系统授权、电池优化与自启动", "settings") { showPage(Page.PERMISSIONS) }
        menu("关于与更新", "版本信息、应用更新与开发者选项", "info") { showPage(Page.ABOUT) }
        menu("反馈", "前往 GitHub，可附图片或诊断包", "note") { openFeedback() }
        text("设置在保存后生效。切换页面会保留尚未保存的输入。", 12, MoteUi.muted)
    }

    private fun openFeedback() {
        val uri = Uri.Builder().scheme("https").authority("github.com").path("/utopiafar/mote/issues/new")
            .appendQueryParameter("template", "bug_report.yml")
            .appendQueryParameter("version", "Mote ${BuildConfig.VERSION_NAME} · Android ${Build.VERSION.RELEASE} / API ${Build.VERSION.SDK_INT}")
            .appendQueryParameter("environment", "Android 客户端 · ${BuildConfig.MOTE_PROFILE}")
            .build()
        try { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
        catch (_: ActivityNotFoundException) { toast("无法打开 GitHub，请安装或启用浏览器后重试") }
        catch (_: SecurityException) { toast("系统未允许打开 GitHub，请检查浏览器设置后重试") }
    }

    private fun buildSources() {
        page(Page.SOURCES, "把你选择的生活线索，收进同一份档案")
        section("已支持的来源")
        menu("屏幕与应用活动", "按你的隐私规则采集，可随时暂停", "capture") { showPage(Page.PRIVACY) }
        menu("随手记", "保存此刻的想法，不需要截图权限", "note") { showPage(Page.NOTES) }
        menu("日历与文件", "连接日历、选择文件或授权目录", "folder") { startActivity(Intent(this, SourcesActivity::class.java)) }
        card(MoteUi.tint) {
            text("只连接你选择的内容", 17)
            text("日历和文件只在主动授权后读取；你可以为每个来源调整同步范围和保留方式。", 14, MoteUi.muted)
        }
    }

    private fun buildConnection(config: CollectorConfig) {
        page(Page.CONNECTION, "可先只在本机记录，需要时再连接中央档案")
        section("统一同步方式")
        text("截图、应用活动、笔记和日历/文件采用同一同步策略。", 13, MoteUi.muted)
        syncMode = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf("实时同步", "定时同步", "批量同步", "仅手动同步"))
            setSelection(syncModes.indexOf(config.syncMode).coerceAtLeast(0))
        }; content.addView(syncMode, LinearLayout.LayoutParams(-1, dp(56))); track(syncMode, "syncMode")
        syncInterval = presetNumber("同步间隔 / 分钟（批量模式下也是最长等待时间）", config.syncIntervalMinutes, "15", 15..1440, listOf(15, 30, 60, 180, 360, 720, 1440))
        syncBatch = presetNumber("批量达到多少条时同步", config.syncBatchSize, "20", 1..500, listOf(5, 10, 20, 50, 100, 200, 500))
        updateSyncFields()
        text("定时模式按所选间隔发送；批量模式达到数量或最长等待时间即发送。手动模式仅在点击“立即同步”后发送；网络条件始终有效。Android 省电可能推迟后台执行。", 13, MoteUi.muted)
        section("可选中央节点")
        menu("扫码或导入邀请", "推荐使用中央节点生成的一次性邀请", "sync") { startActivity(Intent(this, ConnectionActivity::class.java)) }
        section("节点与设备")
        connectionSummary = text("", 13, MoteUi.muted)
        server = field("节点 URL（可留空，仅在本机记录）", config.server, "https://mote.example.com", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        token = field("访问令牌（未连接时可留空）", config.token, "建议通过邀请获取本设备凭据", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
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
        text("中央节点可在电脑、NAS 或服务器部署。手机的 localhost 指手机本身；跨设备请填写局域网 IP 或 HTTPS 域名。", 13, MoteUi.muted)
        button("立即重试同步") { retrySync() }
    }

    private fun buildCapture(config: CollectorConfig) {
        page(Page.CAPTURE, "在记录密度、清晰度和耗电之间找到平衡")
        section("采样与空间")
        interval = presetNumber("采集间隔 / 秒", config.intervalSeconds, "30", 5..300, listOf(5, 15, 30, 60, 120, 300))
        maxQueue = presetNumber("本机存储上限 / MiB", config.maxQueueMiB, "256", 8..4096, listOf(64, 128, 256, 512, 1024, 2048, 4096))
        text("默认最长边 1280px、JPEG 75，生效数值可在统计详情查看。相同图片共用加密存储，满后暂停；收到节点确认且 OCR 已处理后才清理本机图片。时间统计是采样设备时间。", 13)
        projectionMode = check("使用投屏模式（备用，每次需授权）", config.mode == "projection")
        text("默认无障碍截图模式适用 Android 11+：系统重新连接服务时可恢复你已启用的采集。投屏模式锁屏/被杀后必须重新授权。Android 10 请选投屏模式。", 13)
        section("画面质量与电量")
        jpegQuality = presetNumber("图像质量 · 数值越高清晰度越高", config.jpegQuality, "75", 40..95, listOf(50, 65, 75, 85, 95))
        captureMaxSide = presetNumber("图片最长边 / px", config.captureMaxSide, "1280", 640..2560, listOf(640, 960, 1280, 1920, 2560))
        chargingOnly = check("仅充电时截图", config.chargingOnly)
        ocrChargingOnly = check("仅充电时 OCR", config.ocrChargingOnly)
        text("开启后，电池供电时继续采集、遮罩、保存和同步图片；充电后自动补做文字识别，并按同步设置更新中央归档。待识别图片在本机保留，并为识别文字预留空间，均计入存储上限。", 13, MoteUi.muted)
        batteryBelow = presetNumber("低于此电量暂停 / % · 0 为关闭", config.batteryPauseBelowPct, "0", 0..95, listOf(0, 10, 15, 20, 30, 50))
        menu("权限与后台运行", "调整系统授权与后台运行设置", "settings") { showPage(Page.PERMISSIONS) }
    }

    private fun buildDiagnostics(config: CollectorConfig) {
        page(Page.DIAGNOSTICS, "按需开启诊断，帮助定位采集和同步问题")
        technicalStatus = text("正在读取运行状态…", 13)
        diagnosticEnabled = check("记录数值与事件诊断", config.diagnosticsEnabled)
        diagnosticInterval = field("诊断采样间隔 / 秒（15–3600）", config.diagnosticsIntervalSeconds.toString(), "60", InputType.TYPE_CLASS_NUMBER)
        text("仅在应用/采集运行时采样，最多 1440 条。记录整机电量、队列/模型空间、入队/拦截/失败计数、推理/OCR 耗时和上传字节，不包含截图、文字、笔记、令牌或审查理由。电量变化是整机变化，不能归因于 Mote。", 13)
        button("导出数值诊断 JSON") {
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "mote-diagnostics.json"), 103)
        }
        text("事件日志最多 500 条，只记录固定阶段、错误类别与数值。支持包不包含节点地址、设备名、截图、笔记、OCR、令牌、提示词或审查理由；关闭诊断后停止新增，已有记录保留。", 13)
        button("导出安全支持包 JSON") {
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "mote-${BuildConfig.MOTE_PROFILE}-support.json"), 104)
        }
    }

    private fun buildNotes() {
        page(Page.NOTES, "为此刻，留下一句话")
        val drafts = QuickNotes.draft(this)
        val restored = runCatching { drafts.read() }
        val note = field("正在想什么", restored.getOrNull()?.text ?: "", "记下此刻的想法…", multiline = true)
        note.minLines = 7; note.gravity = Gravity.TOP
        val mood = field("此刻心情 · 可选", restored.getOrNull()?.mood ?: "", "")
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
        button("保存随手记", true) {
            try {
                check(note.isEnabled) { "请先处理无法读取的旧草稿" }
                QuickNotes.save(this, note.text.toString(), mood.text.toString())
                changingDraft = true; note.text.clear(); mood.text.clear(); changingDraft = false
                toast("随手记已加密保存；同步按你的设置运行"); refreshStatus()
            } catch (error: Exception) { toast(error.message ?: "随手记保存失败，草稿已保留") }
        }
        button("新建一条 · 清除草稿") {
            AlertDialog.Builder(this).setTitle("清除当前草稿？").setMessage("此操作仅清除正在编辑的本机草稿。已保存的随手记不受影响。")
                .setNegativeButton("继续编辑", null).setPositiveButton("清除并新建") { _, _ ->
                    try { drafts.clear(); changingDraft = true; note.text.clear(); mood.text.clear(); changingDraft = false; note.isEnabled = true; mood.isEnabled = true }
                    catch (_: Exception) { toast("草稿清除失败") }
                }.show()
        }
        text("输入自动加密保存为本机草稿。无需节点或截图权限即可保存；已配置节点时按同步设置发送。正文最多 100000 字符，心情最多 80 字符。", 13, MoteUi.muted)
    }

    private fun buildPrivacy(config: CollectorConfig) {
        page(Page.PRIVACY, "由你决定，哪些内容可以留下")
        section("应用采集级别")
        text("完整内容会保存经过本机过滤的截图；仅应用活动只记应用与时长，不需要截图或模型；不记录不会保存该应用。", 13, MoteUi.muted)
        val appRules = AppCollectionRules.parse(config.appCollectionRules)
        appDefault = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf("其他应用：完整内容", "其他应用：仅应用活动", "其他应用：不记录"))
            setSelection(AppCollectionMode.entries.indexOf(appRules.defaultMode))
        }; content.addView(appDefault, LinearLayout.LayoutParams(-1, dp(56))); track(appDefault, "appDefault")
        appRuleRows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; content.addView(appRuleRows)
        button("从已安装应用中选择") { chooseInstalledApp() }
        val regular = content
        val rawRules = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        button("高级：手工编辑包名规则") { rawRules.visibility = if (rawRules.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        regular.addView(rawRules); content = rawRules
        excludes = field("不采集的应用包名（每行一个或逗号分隔）", config.excludedPackages, "com.example.private", multiline = true)
        appPolicies = field("应用级别（每行 包名=content/activity/off）", appRules.apps.entries.joinToString("\n") { "${it.key}=${it.value.wire}" }, "com.example.chat=activity\ncom.example.private=off", multiline = true)
        appPolicies.filters = arrayOf(android.text.InputFilter.LengthFilter(32768))
        content = regular
        val rulesWatcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { renderAppRules() }
        }
        appPolicies.addTextChangedListener(rulesWatcher); excludes.addTextChangedListener(rulesWatcher); renderAppRules()
        metadataEnabled = check("上传设备与采集状态元数据", config.metadataEnabled)
        text("开启后附带实际系统/机型、采集器版本、语言/时区、电量/充电、网络类型、锁屏与可用空间；不取设备序列号、IMEI、MAC、SSID或定位。关闭只影响新记录和心跳，已入队内容不追溯修改。授权文件来源自身的大小/修改时间不受此开关影响。", 13)
        text("没有内置应用黑名单。配置排除后，无法识别应用、多个应用窗口或系统遮挡时暂停。投屏模式需要同时启用无障碍服务才能可靠执行排除；仅使用情况权限不足以保证所有可见窗口。", 13)
        section("固定遮罩")
        text("拖动示意图添加矩形；绿色区域会在 OCR 和保存前被遮住。这里不会读取你的屏幕。", 13, MoteUi.muted)
        val maskFields = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        val mainContent = content; content.addView(maskFields); content = maskFields
        masks = field("固定遮罩（每行 left,top,right,bottom）", config.masks, "0,0,1,0.08", multiline = true)
        content = mainContent
        maskEditor = MaskEditorView(this) { values -> masks.setText(values.joinToString("\n") { "${it.left},${it.top},${it.right},${it.bottom}" }) }
        maskEditor.setMasks(Mask.parse(config.masks)); content.addView(maskEditor, LinearLayout.LayoutParams(-1, dp(260)).apply { bottomMargin = dp(12) })
        masks.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { runCatching { maskEditor.setMasks(Mask.parse(s.toString())) } }
        })
        rowButtons("遮住顶部 8%", { maskEditor.add(Mask(0f, 0f, 1f, .08f)) }, "遮住底部 12%", { maskEditor.add(Mask(0f, .88f, 1f, 1f)) })
        rowButtons("调整所选区域", { editSelectedMask() }, "移除所选区域", { maskEditor.removeSelected() })
        button("高级：编辑精确坐标") { maskFields.visibility = if (maskFields.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        text("内置本机 NSFW 过滤", 19)
        nsfwEnabled = check("启用 NSFW 过滤（默认启用，故障不放行）", config.nsfw.enabled)
        text("内置 Qwen3.5-0.8B 小视觉语言模型，CPU 离线审查，可编辑指令用于其它图片过滤。截图只在内存中送入独立进程。模型拒绝、缺失、输出无效、超时或进程退出时，该帧不会进入 OCR、存储或上传。模型可能误判。", 13)
        nsfwStatus = text("正在读取模型状态…", 13, MoteUi.muted)
        rowButtons("下载 / 继续", {
            if (saveNsfw()) NsfwDownloadWorker.start(this, wifi.isChecked)
        }, "取消下载", { NsfwDownloadWorker.cancel(this) })
        button("导入本地模型") {
            if (saveNsfw()) {
                NsfwDownloadWorker.cancel(this)
                @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), 102)
            }
        }
        text("模型约 703 MiB，支持断点下载；每次加载前校验完整 SHA-256。下载来源、审查指令和性能参数可在开发者选项中调整。", 13, MoteUi.muted)
        menu("模型高级设置", "下载来源、审查指令与推理参数", "settings") { showPage(Page.MODEL) }
    }

    private fun buildModel(config: CollectorConfig) {
        page(Page.MODEL, "修改前先停止采集；参数影响本机过滤行为")
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
        track(nsfwSource, "nsfwSource")
        nsfwCustom = field("自定义 HTTPS 目录（model.gguf / mmproj.gguf）", config.nsfw.customUrl, "https://your-nas.example/models/qwen", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        text("双模型共约 703 MiB。自动先尝试国内 ModelScope，失败回退 Hugging Face；支持断点续传，取消后保留断点。可在自定义目录托管两个固定文件，或分两次导入本地 GGUF；每次加载前核对完整 SHA-256。下载速度取决于网络。", 13)
        button("重载推理进程") {
            NsfwClient.resetAll(); NsfwModelStore(this).inferenceStatus("已重置推理进程，下一帧重新校验并加载")
        }
        review = field("可选本机隐私模型 URL", config.localReviewUrl, "http://127.0.0.1:47833/review", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        text("这是 NSFW 检查后的额外通用隐私审查。仅允许手机本机 loopback；模型拒绝、超时或格式错误时丢弃此帧。模型新增遮罩后重新 OCR。未填写则不调用此额外 HTTP 钩子。", 13)
    }

    private fun buildDeveloper(config: CollectorConfig) {
        page(Page.DEVELOPER, "用于排查问题和调整本机高级行为")
        menu("诊断与支持", "运行状态、数值采样与安全支持包", "chart") { showPage(Page.DIAGNOSTICS) }
        menu("模型高级设置", "审查指令、下载来源与推理参数", "settings") { showPage(Page.MODEL) }
        section("调试连接")
        http = check("允许调试局域网 HTTP（明文，仅私有 IP）", config.debugHttp).apply { isEnabled = BuildConfig.DEBUG }
        section("构建与运行环境")
        text("环境：${BuildConfig.MOTE_PROFILE} · ${packageName}\n私有数据目录：${noBackupFilesDir.absolutePath}", 12, MoteUi.muted)
        if (BuildConfig.MOTE_PROFILE == "dev") text("开发版与日常 Mote 独立安装，权限、设备 ID、令牌、草稿、队列和模型互不共享。默认测试端口 47842；模拟器使用 adb reverse tcp:47842 tcp:47842。", 13, MoteUi.muted)
    }

    private fun buildAbout() {
        page(Page.ABOUT, "Mote · 让经历留有线索")
        card(MoteUi.tint) {
            text("Mote", 30)
            text("你的个人上下文档案", 15)
            text("版本 ${BuildConfig.VERSION_NAME}", 13, MoteUi.muted)
        }
        menu("应用更新", "检查新版本与安装更新", "sync") { startActivity(Intent(this, AppUpdatesActivity::class.java)) }
        menu("开发者选项", "诊断、模型高级参数与构建信息", "settings") { showPage(Page.DEVELOPER) }
        text("Android ${Build.VERSION.RELEASE} / API ${Build.VERSION.SDK_INT} · ${Build.MANUFACTURER} ${Build.MODEL}", 12, MoteUi.muted)
        text("无需 Root，不申请相册和麦克风权限；相机仅在主动扫码时申请。应用页面受到系统安全保护，不会把令牌截进采集队列。", 13, MoteUi.muted)
        text("本构建尚未在 K90 Pro Max 真机验证。", 12, MoteUi.muted)
    }

    private fun buildPermissions() {
        page(Page.PERMISSIONS, "按需授权，让记录稳定运行")
        button("启用无障碍截图服务") {
            AlertDialog.Builder(this).setTitle("屏幕采集权限说明")
                .setMessage(getString(R.string.accessibility_description) + "\n\n继续后请在系统设置中选择 Mote 屏幕采集。启用服务本身不会开始截图，仍需回到此处点击开始。")
                .setNegativeButton("取消", null).setPositiveButton("打开系统设置") { _, _ -> safeOpen(Intent(SystemSettings.ACTION_ACCESSIBILITY_SETTINGS)) }.show()
        }
        rowButtons("通知权限", { notifications() }, "使用情况权限", { safeOpen(Intent(SystemSettings.ACTION_USAGE_ACCESS_SETTINGS)) })
        rowButtons("电池优化设置", { safeOpen(Intent(SystemSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }, "自启动设置", { autostart() })
        button("应用详情 / 受限制设置") { safeOpen(detailsIntent()) }
        text("小米 / HyperOS：在系统应用设置中允许 Mote 自启动，将省电策略设为无限制，并允许通知；可在最近任务中锁定应用。菜单随系统版本变化。若侧载 APK 的无障碍开关受限，请在应用详情的菜单中检查“允许受限制的设置”。这些设置不能保证系统永不终止采集。", 13)
    }

    private fun retrySync() {
        runCatching {
            val c = settings.read()
            if (!c.hasSyncConnection()) { showPage(Page.CONNECTION); toast("记录已保存在本机；连接节点后才可以同步") }
            else { c.validateConnection(); if (localSources().sources().any { it.enabled }) SourceWork.schedule(this, true, syncExplicit = true) else UploadWorker.schedule(this, c, true); toast("已请求同步；仍遵守网络约束") }
        }
            .onFailure { toast(it.message ?: "配置无效") }
    }

    private fun draft() = CollectorConfig(
        checked(server) { server.text.toString().trim().let { if (it.isBlank()) "" else PrivacyRules.validateEndpoint(it, http.isChecked, BuildConfig.DEBUG) } },
        checked(token) { token.text.toString().trim().also { require(it.isBlank() || it.length >= 32) { "令牌至少需要 32 个字符；未连接时可留空" } } },
        checked(name) { name.text.toString().trim().also { require(it.isNotBlank() && it.length <= 128) { "请填写 1..128 字符的设备名称" } } },
        number(interval, 5..300), number(maxQueue, 8..4096), wifi.isChecked,
        excludes.text.toString(), checked(masks) { masks.text.toString().also { Mask.parse(it) } },
        checked(review) { review.text.toString().trim().also { PrivacyRules.validateLocalReview(it) } }, http.isChecked,
        if (projectionMode.isChecked) "projection" else "accessibility", nsfwDraft(), number(jpegQuality, 40..95), number(captureMaxSide, 640..2560),
        chargingOnly.isChecked, number(batteryBelow, 0..95), diagnosticEnabled.isChecked, number(diagnosticInterval, 15..3600),
        checked(appPolicies) { AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString()).json() }, metadataEnabled.isChecked, syncModes[syncMode.selectedItemPosition], number(syncInterval, 15..1440), number(syncBatch, 1..500), ocrChargingOnly.isChecked)
    private fun nsfwDraft(): NsfwConfig {
        val value = NsfwConfig(enabled = nsfwEnabled.isChecked, threads = number(nsfwThreads, 1..8),
            timeoutMs = number(nsfwTimeout, 5000..180000).toLong(), source = nsfwSources[nsfwSource.selectedItemPosition],
            customUrl = checked(nsfwCustom) { nsfwCustom.text.toString().trim().also { if (nsfwSource.selectedItemPosition == 3) {
                require(NsfwConfig.validateModelUrl(it).rawQuery == null) { "自定义来源应为不带查询参数的 HTTPS 目录" }
            } } },
            policy = checked(nsfwPolicy) { nsfwPolicy.text.toString().trim().also { require(it.isNotBlank() && it.length <= 4000) { "审查指令须为 1..4000 字符" } } },
            maxTokens = number(nsfwMaxTokens, 32..1024), reviewMaxSide = number(nsfwMaxSide, 256..1024))
        return value.also { it.validate() }
    }
    private fun number(field: EditText, range: IntRange): Int = checked(field) {
        val value = field.text.toString().trim().toIntOrNull()
        require(value != null && value in range) { "请输入 ${range.first}–${range.last} 之间的整数" }
        value
    }
    private fun <T> checked(field: EditText, read: () -> T): T = try {
        read().also { field.error = null }
    } catch (error: Exception) {
        val message = if (error is java.net.URISyntaxException || error is NumberFormatException) "请检查此项的输入格式" else error.message ?: "请检查此项设置"
        showPage(controlPages.getValue(field))
        var ancestor = field.parent
        while (ancestor is View && ancestor !is ScrollView) { ancestor.visibility = View.VISIBLE; ancestor = ancestor.parent }
        field.error = message; field.requestFocus()
        field.post { field.requestRectangleOnScreen(android.graphics.Rect(0, 0, field.width, field.height), false) }
        throw IllegalArgumentException(message, error)
    }
    private fun saveNsfw(): Boolean = try {
        require(!settings.enabled) { "请先停止采集再修改模型设置" }
        settings.saveNsfw(nsfwDraft())
        val saved = controlValues(); baseline = baseline + listOf(nsfwEnabled, nsfwThreads, nsfwTimeout, nsfwSource, nsfwCustom, nsfwPolicy, nsfwMaxTokens, nsfwMaxSide)
            .associate { it.tag as String to saved.getValue(it.tag as String) }
        updateSaveBar(); true
    } catch (error: Exception) { toast(error.message ?: "请检查 NSFW 配置"); false }
    private fun saveConfig(bindLocal: Boolean = false): Boolean = try {
        require(!settings.enabled) { "请先停止采集再修改配置" }
        val c = draft().also { it.validate() }
        if (c.hasSyncConnection() && settings.dataOrigin().isBlank() && settings.hasPendingData() && !bindLocal) {
            AlertDialog.Builder(this).setTitle("将本机资料绑定到此节点？")
                .setMessage("${c.server}\n\n本机已有尚未绑定的截图、笔记或来源资料。确认后会绑定到这个档案地址，并按你的同步策略发送。请核对这是你自己的节点。")
                .setNegativeButton("继续保存在本机", null).setPositiveButton("确认绑定并保存") { _, _ -> saveConfig(true) }.show()
            false
        } else {
            ConnectionGuard.change(this, if (c.hasSyncConnection()) c.server else "", bindLocal) { settings.save(c) }
            UploadWorker.schedule(this, c)
            CaptureOcrWorker.schedule(this, c, replace = true)
            SourceWork.schedule(this, true)
            loadedServer = c.server; loadedToken = c.token
            baseline = controlValues(); updateSaveBar(); refreshStatus()
            toast("设置已保存，规则对后续新记录生效")
            true
        }
    } catch (e: Exception) { toast(e.message ?: "请检查配置输入"); false }
    private fun startCapture() {
        if (ConnectionGuard.changing()) { toast("正在连接节点，请稍后再开始采集"); return }
        if (settings.enabled) { toast("已启用，状态见上方"); return }
        if (!saveConfig()) return
        if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) { notifications(); toast("请先允许通知，然后再次点击开始"); return }
        val c = settings.read()
        if (c.effectiveMode() == "accessibility") {
            if (Build.VERSION.SDK_INT < 30 && AppCollectionRules.parse(c.appCollectionRules).mayCollectContent()) { toast("Android 10 内容截图请勾选投屏模式；仅活动无需投屏"); return }
            if (!CaptureAccessibilityService.connected) { showPage(Page.PERMISSIONS); toast("请先启用无障碍截图服务，返回后再开始"); return }
            if (!ConnectionGuard.startCapture(this, SourceRules.hash(c.toString())) {
                Operations.record(this, OperationKind.CAPTURE_STARTED)
                settings.status("capturing", "采集已启用，等待首帧；配置页受系统安全保护")
            }) { toast("节点或配置已变化，请重新点击开始"); return }
        } else {
            if (!CaptureAccessibilityService.connected && AppCollectionRules.parse(c.appCollectionRules).requiresWindowIdentity(PrivacyRules.exclusions(c.excludedPackages))) {
                showPage(Page.PERMISSIONS); toast("分级采集需要可靠窗口身份，请先启用无障碍服务；不会读取控件文字"); return
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
        settings.status("paused", "你已停止采集，已有记录保留，同步按所选策略运行")
        stopService(Intent(this, ProjectionService::class.java))
        CaptureAccessibilityService.instance?.stopCapture()
        Notifications.clear(this)
        runCatching { UploadWorker.schedule(this, settings.read()) }
        refreshStatus()
    }
    private fun refreshStatus() {
        if (!::status.isInitialized) return
        val c = runCatching { settings.read() }.getOrNull()
        if (c != null) runCatching { Diagnostics(this).sample(c) }
        val live = if (c?.effectiveMode() == "projection") ProjectionService.running else CaptureAccessibilityService.connected
        val state = if (settings.enabled && !live) "采集服务未连接：请恢复权限" else settings.message()
        val stats = runCatching { Operations.ledger(this).read().getJSONObject("counts") }.getOrNull()
        val totals = if (stats == null) "统计暂不可读取" else "本周期保存截图 ${stats.optLong("SCREEN_QUEUED")} · 应用活动 ${stats.optLong("ACTIVITY_QUEUED")} · 笔记 ${stats.optLong("NOTE_QUEUED")} · 已确认 ${stats.optLong("SCREEN_ACK") + stats.optLong("NOTE_ACK") + stats.optLong("ACTIVITY_ACK")}\n拦截 ${stats.optLong("FRAME_BLOCKED")} · 失败 ${stats.optLong("CAPTURE_FAILED") + stats.optLong("ACTIVITY_FAILED")} · 重试结果 ${stats.optLong("UPLOAD_RETRY")}"
        val pending = runCatching { SyncSchedule.pending(this).count }.getOrNull()
        val bytes = runCatching { queue().bytes() / 1024.0 / 1024 }.getOrNull()
        val modelMissing = c != null && c.nsfw.enabled && AppCollectionRules.parse(c.appCollectionRules).mayCollectContent() && !NsfwModelStore(this).hasFile()
        val queueFull = c != null && queue().bytes() >= c.maxQueueMiB * 1024L * 1024L
        captureTitle.text = when {
            settings.enabled && !live -> "等待采集权限"
            settings.enabled && queueFull -> "本机空间已满"
            settings.enabled && modelMissing -> "等待本机过滤模型"
            settings.enabled && settings.state() == "paused" -> "采集暂时等待"
            settings.enabled -> "正在本机采集"
            else -> "采集已暂停"
        }
        captureAction.text = if (settings.enabled) "暂停采集" else "开始采集"
        status.text = state
        val syncMessage = when {
            c == null -> "无法读取同步配置"
            !c.hasSyncConnection() -> "仅保存在本机 · 尚未连接节点"
            c.syncMode == "manual" && settings.syncState() !in setOf("uploading", "error", "waiting") -> "手动同步 · 点击立即同步才会发送"
            c.syncMode in setOf("interval", "batch") && settings.syncState() !in setOf("uploading", "error") ->
                if (c.syncMode == "interval") "约每 ${c.syncIntervalMinutes} 分钟同步" else "满 ${c.syncBatchSize} 条或等待 ${c.syncIntervalMinutes} 分钟同步"
            else -> settings.uploadStatus()
        }
        syncStatus.text = "${pending?.let { "待同步 $it 条" } ?: "队列暂不可读取"}${bytes?.let { " · ${"%.1f".format(it)} MiB" } ?: ""}\n$syncMessage"
        totalsStatus.text = if (stats == null) "统计暂不可读取" else "截图 ${stats.optLong("SCREEN_QUEUED")}    活动 ${stats.optLong("ACTIVITY_QUEUED")}    随手记 ${stats.optLong("NOTE_QUEUED")}\n本周期已同步 ${stats.optLong("SCREEN_ACK") + stats.optLong("NOTE_ACK") + stats.optLong("ACTIVITY_ACK")} 条"
        technicalStatus.text = "$state\n$totals\n${syncStatus.text}\n${settings.uploadStatus()}\n无障碍 ${if (CaptureAccessibilityService.connected) "已连接" else "未连接"} · 使用情况 ${if (ForegroundApps.usageAllowed(this)) "已授权" else "未授权"}\n最近采集 ${settings.lastCapture() ?: "无"}"
        connectionSummary.text = if (c?.server.isNullOrBlank()) "尚未连接中央节点，请导入邀请或填写下方设置。" else "已保存节点：${c?.server}"
        updateSaveBar()
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
                try {
                    server.setText(c.server); token.setText(c.token); name.setText(c.deviceName); http.isChecked = c.debugHttp; loadedServer = c.server; loadedToken = c.token
                    baseline = baseline + listOf(server, token, name).associate { it.tag as String to it.text.toString() } + (http.tag as String to http.isChecked.toString())
                } finally { applyingConnectionFields = false }
            }
        }
        handler.post(refresh)
    }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }
    private fun dp(value: Int) = moteDp(value)

    private fun page(page: Page, subtitle: String) {
        buildingPage = page
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(18), dp(22), dp(28)) }
        val scroll = ScrollView(this).apply {
            isFillViewport = true; clipToPadding = false; visibility = View.GONE
            addView(content); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        pages[page] = scroll; pagesHost.addView(scroll, FrameLayout.LayoutParams(-1, -1))
        if (page.parent != null) {
            text("‹  ${Page.valueOf(page.parent).title}", 14, MoteUi.accent).apply {
                minHeight = dp(44); gravity = Gravity.CENTER_VERTICAL; isFocusable = true
                contentDescription = "返回${Page.valueOf(page.parent).title}"; setOnClickListener { showPage(Page.valueOf(page.parent)) }
            }
        } else text("MOTE", 11, MoteUi.accent).apply { letterSpacing = .18f }
        text(page.title, 30).apply { typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL) }
        text(subtitle, 14, MoteUi.muted)
    }

    private fun showPage(page: Page) {
        if (currentPage != page) {
            pages[currentPage]?.let { scrollPositions[currentPage] = it.scrollY }
            currentFocus?.clearFocus()
            getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(pagesHost.windowToken, 0)
        }
        currentPage = page
        pages.forEach { (key, view) ->
            view.visibility = if (key == page) View.VISIBLE else View.GONE
            view.importantForAccessibility = if (key == page) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        val selected = if (page.parent == null) page else Page.SETTINGS
        navigation.forEach { (key, view) ->
            val active = key == selected
            view.isSelected = active
            view.setTextColor(if (active) MoteUi.accent else MoteUi.muted)
            view.background = MoteUi.clickable(this, if (active) MoteUi.tint else Color.WHITE, 16)
            view.setCompoundDrawablesWithIntrinsicBounds(null, MoteNavigationIcon(this, key.name.lowercase(), active), null, null)
        }
        navigation[selected]?.requestFocus()
        pages[page]?.let { scroll -> scroll.post { scroll.scrollTo(0, scrollPositions[page] ?: 0) } }
        updateSaveBar()
    }

    // API 33+ uses the native OnBackInvokedDispatcher registered in onCreate; this is the API 29–32 fallback.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Deprecated("Native Activity back navigation")
    override fun onBackPressed() = navigateBack()

    private fun navigateBack() {
        when {
            currentPage.parent != null -> showPage(Page.valueOf(currentPage.parent!!))
            currentPage != Page.OVERVIEW -> showPage(Page.OVERVIEW)
            controlValues() != baseline -> AlertDialog.Builder(this).setTitle("设置尚未保存")
                .setMessage("继续编辑，或放弃本次设置更改并退出。随手记草稿已单独加密保存。")
                .setNegativeButton("继续编辑") { _, _ -> showPage(Page.SETTINGS) }
                .setPositiveButton("放弃并退出") { _, _ -> finish() }.show()
            else -> finish()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("page", currentPage.name)
        super.onSaveInstanceState(outState)
    }

    // Keep unsaved sensitive settings in memory across rotation; never serialize credentials to a Bundle.
    @Deprecated("Native Activity in-memory configuration retention")
    override fun onRetainNonConfigurationInstance(): Any = RetainedDraft(controlValues(), loadedServer, loadedToken)

    private fun updateSaveBar() {
        if (!::saveBar.isInitialized || initializing) return
        val dirty = controlValues() != baseline
        saveBar.visibility = if (dirty) View.VISIBLE else View.GONE
        saveHint.text = if (settings.enabled) "有更改待保存\n请先暂停采集" else "设置有更改\n保存后生效"
    }

    private fun controlValues() = controls.associate { view ->
        view.tag as String to when (view) {
            is EditText -> view.text.toString()
            is CheckBox -> view.isChecked.toString()
            is Spinner -> view.selectedItemPosition.toString()
            else -> ""
        }
    }

    private fun track(view: View, key: String) {
        view.tag = key; controls.add(view); controlPages[view] = buildingPage
        when (view) {
            is EditText -> view.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: Editable?) { updateSaveBar() }
            })
            is CheckBox -> view.setOnCheckedChangeListener { _, _ -> updateSaveBar() }
            is Spinner -> view.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, selected: View?, position: Int, id: Long) { updateSaveBar(); if (::syncMode.isInitialized && view === syncMode) updateSyncFields() }
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            }
        }
    }
    private fun updateSyncFields() {
        if (!::syncInterval.isInitialized || !::syncBatch.isInitialized) return
        listOf(syncInterval to (syncMode.selectedItemPosition in 1..2), syncBatch to (syncMode.selectedItemPosition == 2)).forEach { (field, visible) ->
            field.visibility = if (visible) View.VISIBLE else View.GONE
            fieldLabels[field]?.visibility = field.visibility
        }
    }

    private fun text(value: String, size: Int, color: Int = MoteUi.ink): TextView = TextView(this).apply {
        text = value; textSize = size.toFloat(); setTextColor(color); setLineSpacing(dp(4).toFloat(), 1f)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }
        content.addView(this)
    }
    private fun section(value: String) {
        text(value, 16).apply {
            typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
            setPadding(0, dp(16), 0, dp(2))
        }
    }
    private fun card(color: Int = Color.WHITE, body: () -> Unit) {
        val parent = content
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(18), dp(18), dp(18), dp(8)); background = MoteUi.shape(this@MainActivity, color, 22)
        }
        parent.addView(card, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8); bottomMargin = dp(14) })
        content = card
        try { body() } finally { content = parent }
    }
    private fun menu(label: String, description: String, icon: String, action: () -> Unit) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(15), dp(16), dp(15), dp(16)); background = MoteUi.clickable(this@MainActivity)
            tag = "menu:$label"; isFocusable = true; contentDescription = "$label，$description"; setOnClickListener { action() }
        }
        row.addView(ImageView(this).apply {
            setImageDrawable(MoteNavigationIcon(this@MainActivity, icon, true)); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(25), dp(25)).apply { marginEnd = dp(14) })
        val labels = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS }
        labels.addView(TextView(this).apply { text = label; textSize = 15f; setTextColor(MoteUi.ink); typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL) })
        labels.addView(TextView(this).apply { text = description; textSize = 12f; setTextColor(MoteUi.muted); setPadding(0, dp(5), 0, 0); setLineSpacing(dp(3).toFloat(), 1f) })
        row.addView(labels, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(TextView(this).apply { text = "›"; textSize = 25f; setTextColor(MoteUi.muted); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, LinearLayout.LayoutParams(dp(18), -2))
        content.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) })
    }
    private fun renderAppRules() {
        if (!::appPolicies.isInitialized || !::excludes.isInitialized) return
        appRuleRows.removeAllViews()
        val rules = runCatching { AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString()) }.getOrNull()
        if (rules == null) { appRuleRows.addView(TextView(this).apply { text = "手工规则格式有误，请展开高级规则修正。" }); return }
        val excluded = PrivacyRules.exclusions(excludes.text.toString())
        val ids = (rules.apps.keys + excluded).sorted()
        if (ids.isEmpty()) appRuleRows.addView(TextView(this).apply { text = "尚无单独规则，所有应用沿用上方设置。"; textSize = 13f; setTextColor(MoteUi.muted); setPadding(0, dp(10), 0, dp(14)) })
        ids.forEach { id ->
            val label = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(id, 0)).toString() }.getOrDefault(id)
            val mode = if (id in excluded) AppCollectionMode.OFF else rules.apps.getValue(id)
            appRuleRows.addView(MoteUi.button(Button(this)).apply {
                text = "$label · ${appModeLabel(mode)}"; contentDescription = "$label，$id，${appModeLabel(mode)}，点击更改"
                setOnClickListener { chooseAppMode(id, label) }
            }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        }
    }
    private fun appModeLabel(mode: AppCollectionMode) = when (mode) { AppCollectionMode.CONTENT -> "完整内容"; AppCollectionMode.ACTIVITY -> "仅应用活动"; AppCollectionMode.OFF -> "不记录" }
    private fun chooseAppMode(id: String, label: String) {
        AlertDialog.Builder(this).setTitle(label).setItems(arrayOf("完整内容", "仅应用活动", "不记录", "跟随其他应用")) { _, index ->
            runCatching {
                val rules = AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString())
                val selected = rules.apps.toMutableMap()
                if (index == 3) selected.remove(id) else selected[id] = AppCollectionMode.entries[index]
                AppCollectionRules.parse(AppCollectionRules(rules.defaultMode, selected).json())
                excludes.setText(PrivacyRules.exclusions(excludes.text.toString()).filterNot { it == id }.joinToString("\n"))
                appPolicies.setText(selected.entries.joinToString("\n") { "${it.key}=${it.value.wire}" })
            }.onFailure { toast(it.message ?: "请检查应用规则") }
        }.setNegativeButton("取消", null).show()
    }
    private fun chooseInstalledApp() {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = packageManager.queryIntentActivities(intent, 0).map { it.activityInfo.packageName to it.loadLabel(packageManager).toString() }.distinctBy { it.first }.sortedBy { it.second }
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(8)) }
        val search = MoteUi.field(EditText(this)).apply { hint = "搜索应用名称"; setSingleLine() }; body.addView(search)
        val list = ListView(this); body.addView(list, LinearLayout.LayoutParams(-1, dp(340)))
        var shown = apps
        fun filter() {
            val query = search.text.toString().trim()
            shown = apps.filter { query.isEmpty() || it.second.contains(query, true) || it.first.contains(query, true) }
            list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, shown.map { it.second })
        }
        val dialog = AlertDialog.Builder(this).setTitle("选择应用").setView(body).setNegativeButton("取消", null).create()
        list.setOnItemClickListener { _, _, position, _ -> val app = shown[position]; dialog.dismiss(); chooseAppMode(app.first, app.second) }
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { filter() }
        }); filter(); dialog.show()
    }
    private fun editSelectedMask() {
        val chosen = maskEditor.value().getOrNull(maskEditor.selectedIndex) ?: run { toast("请先在示意图中点选一个绿色区域"); return }
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(8)) }
        val sliders = listOf("左边界" to chosen.left, "上边界" to chosen.top, "右边界" to chosen.right, "下边界" to chosen.bottom).map { (name, value) ->
            val label = TextView(this); form.addView(label)
            SeekBar(this).apply {
                max = 100; progress = (value * 100).toInt(); label.text = "$name：$progress%"; form.addView(this)
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(bar: SeekBar?, progress: Int, fromUser: Boolean) { label.text = "$name：$progress%" }
                    override fun onStartTrackingTouch(bar: SeekBar?) = Unit
                    override fun onStopTrackingTouch(bar: SeekBar?) = Unit
                })
            }
        }
        val dialog = AlertDialog.Builder(this).setTitle("调整遮罩区域").setView(form).setNegativeButton("取消", null).setPositiveButton("应用", null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            runCatching { maskEditor.updateSelected(Mask(sliders[0].progress / 100f, sliders[1].progress / 100f, sliders[2].progress / 100f, sliders[3].progress / 100f)); dialog.dismiss() }
                .onFailure { toast("右边界应大于左边界，下边界应大于上边界") }
        } }; dialog.show()
    }

    private fun presetNumber(label: String, value: Int, placeholder: String, range: IntRange, presets: List<Int>): EditText {
        val result = field(label, value.toString(), placeholder, InputType.TYPE_CLASS_NUMBER)
        result.keyListener = null; result.isFocusable = false; result.isClickable = true
        result.setCompoundDrawablesWithIntrinsicBounds(null, null, MoteNavigationIcon(this, "dropdown", true), null)
        result.contentDescription = "$label，点按选择"
        result.setOnClickListener {
            val current = result.text.toString().toIntOrNull()
            val choices = (presets + listOfNotNull(current)).distinct().sorted()
            val labels = choices.map { it.toString() } + "自定义…"
            AlertDialog.Builder(this).setTitle(label).setSingleChoiceItems(labels.toTypedArray(), choices.indexOf(current)) { dialog, index ->
                dialog.dismiss()
                if (index < choices.size) { result.setText(choices[index].toString()); result.error = null }
                else {
                    val custom = MoteUi.field(EditText(this)).apply { inputType = InputType.TYPE_CLASS_NUMBER; setText(result.text); selectAll() }
                    val customDialog = AlertDialog.Builder(this).setTitle("自定义数值").setMessage("范围 ${range.first}–${range.last}")
                        .setView(custom).setNegativeButton("取消", null).setPositiveButton("确定", null).create()
                    customDialog.setOnShowListener { customDialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                        val number = custom.text.toString().toIntOrNull()
                        if (number == null || number !in range) custom.error = "请输入 ${range.first}–${range.last} 之间的整数"
                        else { result.setText(number.toString()); result.error = null; customDialog.dismiss() }
                    } }; customDialog.show()
                }
            }.setNegativeButton("取消", null).show()
        }
        return result
    }

    private fun field(label: String, value: String, placeholder: String, type: Int = InputType.TYPE_CLASS_TEXT, multiline: Boolean = false): EditText {
        val labelView = text(label, 13, MoteUi.muted)
        return MoteUi.field(EditText(this)).apply {
            fieldLabels[this] = labelView
            inputType = if (multiline) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE else type
            setText(value); hint = placeholder; if (multiline) { minLines = 2; gravity = Gravity.TOP } else setSingleLine()
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO; isSaveEnabled = false
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(18) }; content.addView(this)
            if (buildingPage != Page.NOTES) track(this, label)
        }
    }
    private fun check(label: String, selected: Boolean) = CheckBox(this).apply {
        text = label; isChecked = selected; textSize = 14f; minHeight = dp(52); setTextColor(MoteUi.ink)
        buttonTintList = android.content.res.ColorStateList.valueOf(MoteUi.accent)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }; content.addView(this); track(this, label)
    }
    private fun button(label: String, primary: Boolean = false, action: () -> Unit) = MoteUi.button(Button(this), primary).apply {
        text = label; setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) }; content.addView(this)
    }
    private fun rowButtons(left: String, leftAction: () -> Unit, right: String, rightAction: () -> Unit) {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        listOf(left to leftAction, right to rightAction).forEachIndexed { index, (label, action) ->
            row.addView(MoteUi.button(Button(this)).apply { text = label; setOnClickListener { action() } },
                LinearLayout.LayoutParams(0, -2, 1f).apply { if (index == 0) marginEnd = dp(8) })
        }
        content.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) })
    }
    private fun toast(message: String) { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
}
