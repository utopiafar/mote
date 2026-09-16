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
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.*
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var settings: Settings
    private lateinit var content: LinearLayout
    private var loadedServer: String? = null
    private lateinit var loadedConfig: CollectorConfig
    private var projectionRequestStamp: String? = null
    private var applyingConnectionFields = false
    private lateinit var status: TextView
    private lateinit var captureTitle: TextView
    private lateinit var captureProgress: ProgressBar
    private lateinit var syncStatus: TextView
    private lateinit var totalsStatus: TextView
    private lateinit var technicalStatus: TextView
    private lateinit var captureAction: Button
    private lateinit var connectionSummary: TextView
    private lateinit var saveBar: LinearLayout
    private var applyingSettings = false
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
    private var draftGeneration = 0
    private enum class Page(val title: String, val parent: String? = null) {
        OVERVIEW("概览"), NOTES("随手记"), SOURCES("来源"), SETTINGS("设置"),
        CONNECTION("连接与同步", "SETTINGS"), CAPTURE("采集与存储", "SETTINGS"),
        PROCESSING("图像与文字识别", "CAPTURE"), STORAGE("本机存储", "CAPTURE"),
        PRIVACY("隐私与应用规则", "SETTINGS"), PERMISSIONS("权限与后台运行", "SETTINGS"),
        ABOUT("关于与更新", "SETTINGS"), DEVELOPER("开发者选项", "ABOUT"),
        DIAGNOSTICS("诊断与支持", "DEVELOPER"), MODEL("模型高级设置", "DEVELOPER")
    }
    private data class RetainedDraft(val fields: Map<String, String>, val config: CollectorConfig)
    private lateinit var server: EditText
    private lateinit var token: EditText
    private lateinit var name: EditText
    private lateinit var interval: EditText
    private lateinit var uploadedRetention: EditText
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
    private lateinit var mediaCollectionEnabled: CheckBox
    private lateinit var notificationCollectionEnabled: CheckBox
    private lateinit var deviceEventCollectionEnabled: CheckBox
    private lateinit var screenCollectionEnabled: CheckBox
    private lateinit var mediaStatus: TextView
    private lateinit var imageDedupeMode: Spinner
    private val imageDedupeModes = listOf("off", "exact", "conservative", "balanced", "aggressive")
    private lateinit var jpegQuality: EditText
    private lateinit var captureMaxSide: EditText
    private lateinit var batteryBelow: EditText
    private lateinit var syncChargingOnly: CheckBox
    private lateinit var syncBatteryNotLow: CheckBox
    private lateinit var chargingOnly: CheckBox
    private lateinit var ocrMode: Spinner
    private lateinit var ocrAppModes: EditText
    private lateinit var ocrChargingOnly: CheckBox
    private lateinit var diagnosticEnabled: CheckBox
    private lateinit var imageDedupeDiagnosticsEnabled: CheckBox
    private lateinit var contentEncryptionEnabled: CheckBox
    private lateinit var decryptStatus: TextView
    private lateinit var decryptProgress: ProgressBar
    private lateinit var decryptAction: Button
    private lateinit var decryptCancel: Button
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
    private lateinit var permissionsSummary: TextView
    private lateinit var accessibilityButton: Button
    private lateinit var notificationButton: Button
    private lateinit var usageButton: Button
    private lateinit var batteryButton: Button
    private val nsfwSources = listOf("auto", "mirror", "official", "custom")
    private var notePoll: Runnable? = null
    private val handler = Handler(Looper.getMainLooper())
    private val uiTask by lazy { UiTask(this) }
    private val statusExecutor = Executors.newSingleThreadExecutor()
    private var statusLoading = false
    private var statusRefreshPending = false
    private var resumed = false
    private var localStateJob: kotlinx.coroutines.Job? = null
    private data class StatusSnapshot(val title: String, val action: String, val status: String, val sync: String,
        val totals: String, val technical: String, val connection: String, val model: String, val media: String, val config: CollectorConfig?)
    private val refresh = object : Runnable {
        override fun run() { refreshStatus(); handler.postDelayed(this, 2000) }
    }
    private val decryptPoll = object : Runnable {
        override fun run() { refreshContentDecryption(); handler.postDelayed(this, 500) }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { navigateBack() }
        settings = Settings(this)
        val retained = lastNonConfigurationInstance as? RetainedDraft
        val loading = moteDetailPage()
        val label = TextView(this).apply { text = "正在读取本机设置…" }; loading.addView(label); loading.addView(ProgressBar(this))
        uiTask.start("正在读取本机设置…", { label.text = it }, { settings.read() }) { result ->
            result.onSuccess { buildUi(it, savedInstanceState, retained); if (resumed) { updatePermissionSummary(); refreshStatus() } }
                .onFailure { label.text = "设置无法读取，原数据保留。请退出后检查存储或重试。" }
        }
    }
    private fun buildUi(config: CollectorConfig, savedInstanceState: Bundle?, retained: RetainedDraft?) {
        loadedServer = config.server; loadedConfig = config
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
        buildProcessing(config)
        buildStorage(config)
        buildPrivacy(config)
        buildPermissions()
        buildAbout()
        buildDeveloper(config)
        buildDiagnostics(config)
        buildModel(config)
        baseline = controlValues()
        retained?.let { retained ->
            if (retained.config == config) restoreControlValues(retained.fields)
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
            status = text(settings.message(), 14, MoteUi.muted)
            captureProgress = ProgressBar(this@MainActivity, null, android.R.attr.progressBarStyleHorizontal).apply { isIndeterminate = true; visibility = View.GONE }
            content.addView(captureProgress)
            captureAction = button("开始采集", true) { if (settings.enabled) stopCapture() else startCapture() }
            text("未连接节点也能采集；随时可以暂停。", 12, MoteUi.muted)
        }
        section("同步状态")
        card {
            syncStatus = text("正在读取同步状态…", 14)
            rowButtons("立即同步", { retrySync() }, "待上传队列", { startActivity(Intent(this, SyncQueueActivity::class.java)) })
        }
        section("本机记录")
        totalsStatus = text("正在读取统计…", 15)
        menu("采集记录", "按天查看本机与中央归档的图片、OCR 状态和文字", "capture") { startActivity(Intent(this, CaptureRecordsActivity::class.java)) }
        menu("采集与存储详情", "查看累计结果、队列与使用空间", "chart") { startActivity(Intent(this, ActivityStatsActivity::class.java)) }
        menu("权限与后台运行", "管理采集权限和省电设置", "settings") { showPage(Page.PERMISSIONS) }
    }

    private fun buildSettings() {
        page(Page.SETTINGS, "按你的习惯，照顾好每一份记录")
        section("记录与数据")
        menu("连接与同步", "中央节点、设备名称与上传网络", "sync") { showPage(Page.CONNECTION) }
        menu("采集与存储", "采样频率、图像质量与电量策略", "capture") { showPage(Page.CAPTURE) }
        menu("本机存储", "保留时间、空间上限与保存位置", "folder") { showPage(Page.STORAGE) }
        menu("导入与导出", "迁移配置、备份与恢复本机记录", "folder") { startActivity(Intent(this, BackupActivity::class.java)) }
        menu("隐私与应用规则", "应用采集级别、遮罩与本机过滤", "shield") { showPage(Page.PRIVACY) }
        section("应用")
        menu("权限与后台运行", "系统授权、电池优化与自启动", "settings") { showPage(Page.PERMISSIONS) }
        menu("关于与更新", "版本信息、应用更新与开发者选项", "info") { showPage(Page.ABOUT) }
        menu("反馈", "前往 GitHub，可附图片或诊断包", "note") { openFeedback() }
        text("修改后请保存，再切换页面。", 12, MoteUi.muted)
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
        menu("屏幕与应用活动", "采集来源、频率与电量策略", "capture") { showPage(Page.CAPTURE) }
        menu("应用采集规则", "为普通与系统应用设置记录方式", "shield") { showPage(Page.PRIVACY) }
        menu("随手记", "记录此刻的想法", "note") { showPage(Page.NOTES) }
        menu("日历与文件", "连接日历、选择文件或授权目录", "folder") { startActivity(Intent(this, SourcesActivity::class.java)) }
        card(MoteUi.tint) {
            text("只连接你选择的内容", 17)
            text("日历和文件只在主动授权后读取；你可以为每个来源调整同步范围和保留方式。", 14, MoteUi.muted)
        }
    }

    private fun buildConnection(config: CollectorConfig) {
        page(Page.CONNECTION, "可先只在本机记录，需要时再连接中央档案")
        section("统一同步方式")
        text("所有采集记录和来源文件共用以下同步设置。", 13, MoteUi.muted)
        syncMode = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf("实时同步", "定时同步", "批量同步", "仅手动同步"))
            setSelection(syncModes.indexOf(config.syncMode).coerceAtLeast(0))
        }; content.addView(syncMode, LinearLayout.LayoutParams(-1, dp(56))); track(syncMode, "syncMode")
        syncInterval = presetNumber("同步间隔 / 分钟（批量模式下也是最长等待时间）", config.syncIntervalMinutes, "15", 15..1440, listOf(15, 30, 60, 180, 360, 720, 1440))
        syncBatch = presetNumber("批量达到多少条时同步", config.syncBatchSize, "20", 1..500, listOf(5, 10, 20, 50, 100, 200, 500))
        updateSyncFields()
        help("同步方式说明", "定时模式按所选间隔发送；批量模式达到数量或最长等待时间即发送。手动模式仅在点击“立即同步”后发送；同步条件始终有效。Android 省电可能推迟后台执行。")
        section("同步条件")
        wifi = check("仅非计费 Wi-Fi 同步", config.wifiOnly)
        syncChargingOnly = check("仅充电时同步", config.syncChargingOnly)
        syncBatteryNotLow = check("低电量时暂停同步", config.syncBatteryNotLow)
        text("适用于记录、来源文件和 OCR 结果。立即同步与全量补传也遵守这些条件；低电量由系统判定。", 13, MoteUi.muted)
        section("中央节点")
        menu("扫码或导入邀请", "推荐使用中央节点生成的一次性邀请", "sync") { discardPageDraft(); startActivity(Intent(this, ConnectionActivity::class.java)) }
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
        text("中央节点可在电脑、NAS 或服务器部署。手机的 localhost 指手机本身；跨设备请填写局域网 IP 或 HTTPS 域名。", 13, MoteUi.muted)
        button("立即重试同步") { retrySync() }
        menu("待上传队列", "查看采集、随手记和来源待发条目", "sync") { startActivity(Intent(this, SyncQueueActivity::class.java)) }
        menu("同步与恢复", "两端检查、补传与冲突处理", "sync") { startActivity(Intent(this, SyncRecoveryActivity::class.java)) }
    }

    private fun buildCapture(config: CollectorConfig) {
        page(Page.CAPTURE, "在记录密度、清晰度和耗电之间找到平衡")
        section("采集来源")
        screenCollectionEnabled = check("采集屏幕与前台应用活动", config.screenCollectionEnabled)
        notificationCollectionEnabled = check("采集通知（正文、持续状态、更新与移除）", config.notificationCollectionEnabled)
        deviceEventCollectionEnabled = check("采集亮屏、熄屏与锁定 / 解锁事件", config.deviceEventCollectionEnabled)
        help("通知与设备事件说明", "通知与设备事件可独立开启，通过系统通知服务观察，按同步策略上传。通知遵循应用规则：仅活动不读取正文，不记录会完全跳过。系统可能隐藏敏感内容；熄屏不等同于锁定。")
        mediaCollectionEnabled = check("采集媒体播放状态（需通知使用权）", config.mediaCollectionEnabled)
        help("媒体采集说明", "媒体采集可单独开启，在前台、后台和锁屏时观察播放器公开的状态、应用及曲目/章节信息；不录音、不控制播放。普通通知由单独的通知采集开关控制。使用概览页的开始/暂停控制采集。媒体沿用应用隐私规则、电量限制和同步策略；关闭元数据会同时暂停媒体。")
        mediaStatus = text("媒体状态正在读取…", 13, MoteUi.muted)
        button("授权通知、媒体与设备事件") { mediaPermission() }
        button("重新授权投屏（已开启的媒体可继续）") {
            val c = loadedConfig
            if (!c.screenCollectionEnabled || c.effectiveMode() != "projection") toast("请先启用屏幕采集并保存投屏模式")
            else if (ProjectionService.running) toast("投屏会话正在运行")
            else if (!settings.enabled) startCapture()
            else requestProjectionConsent()
        }
        help("播放时间如何计算", "约每30秒及状态变化时记录。系统休眠、终止服务或播放器未公开媒体会话时可能缺失；仅统计连续观测的播放时段。")
        section("采样与空间")
        interval = presetNumber("采集间隔 / 秒", config.intervalSeconds, "30", 5..300, listOf(5, 15, 30, 60, 120, 300))
        projectionMode = check("使用投屏模式（备用，每次需授权）", config.mode == "projection")
        help("截图模式说明", "默认无障碍截图模式适用 Android 11+：系统重新连接服务时可恢复你已启用的采集。投屏模式锁屏/被杀后必须重新授权。Android 10 请选投屏模式。")
        section("电量策略")
        chargingOnly = check("仅充电时采集屏幕、活动和媒体", config.chargingOnly)
        batteryBelow = presetNumber("低于此电量暂停 / % · 0 为关闭", config.batteryPauseBelowPct, "0", 0..95, listOf(0, 10, 15, 20, 30, 50))
        section("更多采集设置")
        menu("图像与文字识别", "清晰度、图片去重与 OCR", "capture") { showPage(Page.PROCESSING) }
        menu("本机存储", "上传后保留时间、空间上限与保存位置", "folder") { showPage(Page.STORAGE) }
    }
    private fun buildStorage(config: CollectorConfig) {
        page(Page.STORAGE, "保留你需要回看的本机副本")
        menu("图片保存位置", "选择应用存储空间并迁移已有记录", "folder") { startActivity(Intent(this, StorageActivity::class.java)) }
        uploadedRetention = presetNumber("上传后本机保留 / 天（0 为立即清理）", config.uploadedRetentionDays, "7", 0..365, listOf(0, 1, 7, 14, 30, 90, 365))
        maxQueue = presetNumber("本机存储上限 / MiB", config.maxQueueMiB, "256", 8..4096, listOf(64, 128, 256, 512, 1024, 2048, 4096))
        text("完成上传与 OCR 后开始计时，到期自动清理本机副本；中央归档继续保留。未上传和冲突记录不会自动删除。", 13, MoteUi.muted)
        menu("导入与导出", "备份配置与本机记录", "folder") { startActivity(Intent(this, BackupActivity::class.java)) }
    }
    private fun buildProcessing(config: CollectorConfig) {
        page(Page.PROCESSING, "图像质量与 OCR")
        section("图像质量")
        jpegQuality = presetNumber("图像质量 · 数值越高清晰度越高", config.jpegQuality, "75", 40..95, listOf(50, 65, 75, 85, 95))
        captureMaxSide = presetNumber("图片最长边 / px", config.captureMaxSide, "1280", 640..2560, listOf(640, 960, 1280, 1920, 2560))
        text("图片去重", 15)
        imageDedupeMode = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf("关闭", "精确", "保守", "均衡", "激进"))
            setSelection(imageDedupeModes.indexOf(config.imageDedupeMode).coerceAtLeast(0))
        }
        content.addView(imageDedupeMode, LinearLayout.LayoutParams(-1, dp(56))); track(imageDedupeMode, "imageDedupeMode")
        help("图片去重说明", "与同一应用最近保存的画面比较。重处理前命中时仅记录应用活动，不保存或审查当前图片，也不沿用旧文字。开启图片对比诊断时保留审查后的对比链路。近似档位可能忽略细小变化；重启后重新建立基准。")
        text("OCR 识别方式", 15)
        ocrMode = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf("中文与拉丁文（单引擎）", "仅拉丁文", "双引擎（高质量）"))
            setSelection(OcrPolicy.modes.indexOf(config.ocrMode).coerceAtLeast(0))
        }
        content.addView(ocrMode); track(ocrMode, "ocrMode")
        ocrAppModes = field("按应用指定 OCR（JSON）", config.ocrAppModes, "{}")
        text("可填写包名到 chinese、latin 或 dual 的映射；未指定的应用使用上方模式。", 13, MoteUi.muted)
        ocrChargingOnly = check("仅充电时 OCR", config.ocrChargingOnly)
        text("使用电池时保存图片，充电后识别文字；图片和识别结果按同步设置上传。待识别图片与文字预留空间计入存储上限。", 13, MoteUi.muted)
    }

    private fun buildDiagnostics(config: CollectorConfig) {
        page(Page.DIAGNOSTICS, "按需开启诊断，帮助定位采集和同步问题")
        technicalStatus = text("正在读取运行状态…", 13)
        diagnosticEnabled = check("记录数值与事件诊断", config.diagnosticsEnabled)
        diagnosticInterval = field("诊断采样间隔 / 秒（15–3600）", config.diagnosticsIntervalSeconds.toString(), "60", InputType.TYPE_CLASS_NUMBER)
        help("数值诊断说明", "仅在应用/采集运行时采样，最多 1440 条。记录整机电量、队列/模型空间、入队/拦截/失败计数、推理/OCR 耗时和上传字节，不包含截图、文字、笔记、令牌或审查理由。电量变化是整机变化，不能归因于 Mote。")
        button("导出数值诊断 JSON") {
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "mote-diagnostics.json"), 103)
        }
        button("打开本地日志查看器") { startActivity(Intent(this, LogViewerActivity::class.java)) }
        help("支持包包含什么", "事件日志最多 500 条，只记录固定阶段、错误类别与数值。支持包不包含节点地址、设备名、截图、笔记、OCR、令牌、提示词或审查理由；关闭诊断后停止新增，已有记录保留。")
        button("导出安全支持包 JSON") {
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "mote-${BuildConfig.MOTE_PROFILE}-support.json"), 104)
        }
    }

    private fun buildNotes() {
        page(Page.NOTES, "为此刻，留下一句话")
        val app = applicationContext
        val io = QuickNotes.io
        val task = UiTask(this, io, ownsExecutor = false)
        val note = field("正在想什么", "", "记下此刻的想法…", multiline = true)
        note.minLines = 7; note.gravity = Gravity.TOP
        val mood = field("此刻心情 · 可选", "", "")
        note.filters = arrayOf(android.text.InputFilter.LengthFilter(100000)); mood.filters = arrayOf(android.text.InputFilter.LengthFilter(80))
        val progress = text("正在读取草稿…", 13, MoteUi.muted)
        var changingDraft = false
        var readable = false
        var editRevision = 0
        val persisted = java.util.concurrent.atomic.AtomicReference<Pair<Int, Boolean>?>(null)
        val writer = LatestWriter<Pair<Int, Pair<String, String>>>(io) { (revision, value) ->
            val result = runCatching { QuickNotes.draft(app).update(value.first, value.second) }
            persisted.set(revision to result.isSuccess)
        }
        fun replace(value: NoteDraft) {
            changingDraft = true; note.setText(value.text); mood.setText(value.mood); changingDraft = false
        }
        fun editable(value: Boolean) { note.isEnabled = value; mood.isEnabled = value }
        val draftWatcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                if (!changingDraft && readable) {
                    writer.submit(++editRevision to (note.text.toString() to mood.text.toString()))
                    progress.text = "正在保存草稿…"
                }
            }
        }
        note.addTextChangedListener(draftWatcher); mood.addTextChangedListener(draftWatcher)
        // Persistence is independent of this Activity; only the lightweight observer stops on pause.
        val draftPoll = object : Runnable {
            override fun run() {
                if (isDestroyed) return
                if (resumed && !task.busy) persisted.get()?.takeIf { it.first == editRevision }?.let {
                    progress.text = if (it.second) "草稿已保存" else "草稿保存失败，请保持页面打开并检查可用空间"
                }
                handler.postDelayed(this, 500)
            }
        }
        notePoll = draftPoll; if (resumed) handler.post(draftPoll)
        editable(false)
        task.start("正在读取草稿…", { progress.text = it }, { QuickNotes.draft(app).read() }) { result ->
            result.onSuccess { replace(it); readable = true; editable(true); progress.text = "草稿已载入" }
                .onFailure { progress.text = "草稿读取失败，原文件保留。明确点击新建才清除旧草稿。" }
        }
        button("保存随手记", true) {
            if (!task.busy && readable) {
                val value = note.text.toString() to mood.text.toString()
                editable(false)
                task.start("正在保存随手记…", { progress.text = it }, { QuickNotes.save(app, value.first, value.second) }) { result ->
                    editable(true); persisted.set(null)
                    result.onSuccess { replace(NoteDraft()); persisted.set(null); progress.text = "随手记已保存；同步按你的设置运行"; refreshStatus() }
                        .onFailure { progress.text = it.message ?: "随手记保存失败，草稿已保留" }
                }
            }
        }
        button("新建一条 · 清除草稿") {
            if (!task.busy) AlertDialog.Builder(this).setTitle("清除当前草稿？").setMessage("此操作仅清除正在编辑的本机草稿。已保存的随手记不受影响。")
                .setNegativeButton("继续编辑", null).setPositiveButton("清除并新建") { _, _ ->
                    if (!task.busy) {
                        editable(false)
                        task.start("正在清除草稿…", { progress.text = it }, { QuickNotes.draft(app).clear() }) { result ->
                            result.onSuccess { replace(NoteDraft()); persisted.set(null); readable = true; progress.text = "可以开始新随手记" }
                                .onFailure { progress.text = "草稿清除失败" }
                            editable(readable)
                        }
                    }
                }.show()
        }
        text("草稿自动保存在本机，保存后按同步设置上传。正文最多 100000 字符，心情最多 80 字符。", 13, MoteUi.muted)
    }

    private fun buildPrivacy(config: CollectorConfig) {
        page(Page.PRIVACY, "由你决定，哪些内容可以留下")
        section("选择要记录的应用")
        text("完整内容：保存经过隐私过滤的截图。仅应用活动：记录应用与时长。不记录：跳过该应用。", 13, MoteUi.muted)
        val appRules = AppCollectionRules.parse(config.appCollectionRules)
        appDefault = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf("默认：记录截图与内容", "默认：只记应用和时长", "默认：不记录（仅记录单独开启的应用）"))
            setSelection(AppCollectionMode.entries.indexOf(appRules.defaultMode))
        }; content.addView(appDefault, LinearLayout.LayoutParams(-1, dp(56))); track(appDefault, "appDefault")
        appRuleRows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; content.addView(appRuleRows)
        text("默认方式适用于没有单独设置的应用，也适用于以后安装的应用。下方显示单独设置；修改后点击保存生效。", 13, MoteUi.muted)
        button("管理应用 · 查看每个应用的记录方式") { chooseInstalledApp() }
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
            saveNsfw { NsfwDownloadWorker.start(this, wifi.isChecked) }
        }, "取消下载", { NsfwDownloadWorker.cancel(this) })
        button("导入本地模型") {
            saveNsfw {
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
        help("模型下载说明", "双模型共约 703 MiB。自动先尝试国内 ModelScope，失败回退 Hugging Face；支持断点续传，取消后保留断点。可在自定义目录托管两个固定文件，或分两次导入本地 GGUF；每次加载前核对完整 SHA-256。下载速度取决于网络。")
        button("重载推理进程") {
            uiTask.start("正在重载推理进程…", { nsfwStatus.text = it }, {
                NsfwClient.resetAll(); NsfwModelStore(applicationContext).inferenceStatus("已重置推理进程，下一帧重新校验并加载")
            }) { result -> result.onFailure { toast("重载失败，请重试") }; refreshStatus() }
        }
        review = field("可选本机隐私模型 URL", config.localReviewUrl, "http://127.0.0.1:47833/review", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        text("这是 NSFW 检查后的额外通用隐私审查。仅允许手机本机 loopback；模型拒绝、超时或格式错误时丢弃此帧。模型新增遮罩后重新 OCR。未填写则不调用此额外 HTTP 钩子。", 13)
    }

    private fun buildDeveloper(config: CollectorConfig) {
        page(Page.DEVELOPER, "用于排查问题和调整本机高级行为")
        menu("诊断与支持", "运行状态、数值采样与安全支持包", "chart") { showPage(Page.DIAGNOSTICS) }
        section("本地内容存储")
        contentEncryptionEnabled = check("加密保存本地内容（默认关闭）", config.contentEncryptionEnabled)
        text("保存后应用于新写入的图片、记录、索引、草稿和来源资料。已有加密文件仍可读取；关闭开关后不会自动改写全部旧文件。连接令牌始终使用系统安全存储。", 13, MoteUi.muted)
        decryptStatus = text("关闭内容加密并保存后，可一次性解密已有本地数据。", 13, MoteUi.muted)
        decryptProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { visibility = View.GONE }
        content.addView(decryptProgress)
        decryptAction = button("批量解密已有本地数据") {
            if (contentEncryptionEnabled.isChecked || loadedConfig.contentEncryptionEnabled) toast("请先关闭本地内容加密并保存设置")
            else {
                LocalContentDecryptor.start(applicationContext)
                refreshContentDecryption()
            }
        }
        decryptCancel = button("取消批量解密") { LocalContentDecryptor.cancel(); refreshContentDecryption() }
        text("在后台逐个转换图片、记录、索引和来源文件，可继续浏览与采集。取消会保留已完成结果，未完成文件仍可正常读取；再次运行可继续处理。", 13, MoteUi.muted)
        refreshContentDecryption()
        menu("图片压缩预览", "质量、文件大小、缩放比例与放大对比", "chart") {
            @Suppress("DEPRECATION") startActivityForResult(Intent(this, CompressionPreviewActivity::class.java), 105)
        }
        section("图片去重排查")
        imageDedupeDiagnosticsEnabled = check("临时保留图片去重对比记录", config.imageDedupeDiagnosticsEnabled)
        help("图片对比诊断说明", "默认关闭。开启并保存后，将已去重图片及对比原图临时保存在本机，供核对分数与判断依据。最多 20 组、32 MiB，24 小时后到期；读取时清理，系统可能延后后台清理。关闭并保存后清空。保留的都是通过隐私检查和遮罩后的图片。")
        menu("本机图片批量去重", "全量扫描、对比预览、移入待决定区或删除", "chart") { startActivity(Intent(this, BulkDedupeActivity::class.java)) }
        menu("查看图片去重记录", "对比两张图片、分数与依据，可随时清空", "chart") { startActivity(Intent(this, ImageDedupeDiagnosticsActivity::class.java)) }
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
    }

    private fun refreshContentDecryption() {
        if (!::decryptStatus.isInitialized) return
        val snapshot = LocalContentDecryptor.snapshot
        decryptStatus.text = snapshot.message
        decryptProgress.visibility = if (snapshot.running) View.VISIBLE else View.GONE
        decryptProgress.isIndeterminate = snapshot.total == 0
        decryptProgress.max = maxOf(1, snapshot.total); decryptProgress.progress = snapshot.checked
        decryptAction.isEnabled = !snapshot.running && !loadedConfig.contentEncryptionEnabled && !ConnectionGuard.reconfiguring()
        decryptCancel.visibility = if (snapshot.running) View.VISIBLE else View.GONE
        contentEncryptionEnabled.isEnabled = !snapshot.running
    }

    private fun buildPermissions() {
        page(Page.PERMISSIONS, "按需授权，让记录稳定运行")
        section("当前状态")
        permissionsSummary = text("正在检查系统权限…", 14, MoteUi.muted)
        accessibilityButton = button("启用无障碍截图服务") {
            AlertDialog.Builder(this).setTitle("屏幕采集权限说明")
                .setMessage(getString(R.string.accessibility_description) + "\n\n继续后请在系统设置中选择 Mote 屏幕采集。启用服务本身不会开始截图，仍需回到此处点击开始。")
                .setNegativeButton("取消", null).setPositiveButton("打开系统设置") { _, _ -> safeOpen(Intent(SystemSettings.ACTION_ACCESSIBILITY_SETTINGS)) }.show()
        }
        button("授权通知与媒体（通知使用权）") { mediaPermission() }
        help("HyperOS 通知设置帮助", "HyperOS 通知使用权：请按需打开实时、对话、通知、静音类别。旧版曾禁用这些类别；更新后若仍是灰色，可关闭再重新授予通知使用权。类别和应用级开关会影响可接收的事件。")
        notificationButton = button("通知权限") { notifications() }
        usageButton = button("使用情况权限") { safeOpen(Intent(SystemSettings.ACTION_USAGE_ACCESS_SETTINGS)) }
        batteryButton = button("电池优化设置") { safeOpen(Intent(SystemSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        button("自启动设置 · 需在系统确认") { autostart() }
        button("应用详情 / 受限制设置") { safeOpen(detailsIntent()) }
        help("HyperOS 后台设置帮助", "小米 / HyperOS：在系统应用设置中允许 Mote 自启动，将省电策略设为无限制，并允许通知；可在最近任务中锁定应用。菜单随系统版本变化。若侧载 APK 的无障碍开关受限，请在应用详情的菜单中检查“允许受限制的设置”。这些设置不能保证系统永不终止采集。")
    }

    private fun updatePermissionSummary() {
        if (!::permissionsSummary.isInitialized) return
        val accessibility = runCatching { SystemSettings.Secure.getString(contentResolver, SystemSettings.Secure.ENABLED_ACCESSIBILITY_SERVICES)?.split(':')?.any { ComponentName.unflattenFromString(it) == ComponentName(this, CaptureAccessibilityService::class.java) } == true }.getOrDefault(false)
        val notifications = getSystemService(NotificationManager::class.java).areNotificationsEnabled()
        val usage = ForegroundApps.usageAllowed(this)
        val power = runCatching { getSystemService(android.os.PowerManager::class.java).isIgnoringBatteryOptimizations(packageName) }.getOrDefault(false)
        accessibilityButton.text = if (accessibility) "无障碍截图已授权 · 管理" else "无障碍截图未授权 · 去授权"
        notificationButton.text = if (notifications) "通知已允许 · 管理" else "通知未允许 · 去授权"
        usageButton.text = if (usage) "使用情况已授权 · 管理" else "使用情况未授权 · 去授权"
        batteryButton.text = if (power) "电池优化已豁免 · 管理" else "电池优化未豁免 · 设置"
        permissionsSummary.text = "无障碍截图：${if (accessibility) if (CaptureAccessibilityService.connected) "已授权 · 服务已连接" else "已授权 · 等待系统连接服务" else "未授权"}\n媒体通知使用权：${if (MediaCollection.permissionAllowed(this)) "已授权" else "未授权"}\n投屏：${if (ProjectionService.running) "本次会话正在运行" else "未运行 · 开始时需系统授权"}\n通知：${if (notifications) "已允许" else "未允许"}\n使用情况：${if (usage) "已授权" else "未授权"}\n电池优化：${if (power) "已豁免" else "系统可能限制后台运行"}\n自启动：系统未提供可靠查询，请在系统设置确认。"
    }

    private fun retrySync() {
        val app = applicationContext
        uiTask.start("正在提交同步任务…", { syncStatus.text = it }, {
            ConnectionGuard.sync {
                val c = Settings(app).read()
                if (!c.hasSyncConnection()) false else {
                    c.validateConnection()
                    if (app.localSources().sources().any { it.enabled }) SourceWork.schedule(app, true, syncExplicit = true)
                    else UploadWorker.schedule(app, c, true)
                    true
                }
            } ?: error("正在应用设置，请稍后重试")
        }) { result ->
            result.onSuccess { connected ->
                if (!connected) { showPage(Page.CONNECTION); toast("记录已保存在本机；连接节点后才可以同步") }
                else toast("已请求同步；仍遵守网络约束")
            }.onFailure { toast(it.message ?: "配置无效") }
        }
    }

    /** A settings page can only change its own fields in the latest saved snapshot. */
    private fun draft(current: CollectorConfig = loadedConfig): CollectorConfig = when (currentPage) {
        Page.CONNECTION -> current.copy(
            server = checked(server) { server.text.toString().trim().let { if (it.isBlank()) "" else PrivacyRules.validateEndpoint(it, current.debugHttp, BuildConfig.DEBUG) } },
            token = checked(token) { token.text.toString().trim().also { require(it.isBlank() || it.length >= 32) { "令牌至少需要 32 个字符；未连接时可留空" } } },
            deviceName = checked(name) { name.text.toString().trim().also { require(it.isNotBlank() && it.length <= 128) { "请填写 1..128 字符的设备名称" } } },
            wifiOnly = wifi.isChecked, syncMode = syncModes[syncMode.selectedItemPosition], syncIntervalMinutes = number(syncInterval, 15..1440),
            syncBatchSize = number(syncBatch, 1..500), syncChargingOnly = syncChargingOnly.isChecked, syncBatteryNotLow = syncBatteryNotLow.isChecked)
        Page.CAPTURE -> current.copy(
            intervalSeconds = number(interval, 5..300), mode = if (projectionMode.isChecked) "projection" else "accessibility",
            chargingOnly = chargingOnly.isChecked, batteryPauseBelowPct = number(batteryBelow, 0..95),
            mediaCollectionEnabled = mediaCollectionEnabled.isChecked, screenCollectionEnabled = screenCollectionEnabled.isChecked,
            notificationCollectionEnabled = notificationCollectionEnabled.isChecked, deviceEventCollectionEnabled = deviceEventCollectionEnabled.isChecked)
        Page.STORAGE -> current.copy(maxQueueMiB = number(maxQueue, 8..4096), uploadedRetentionDays = number(uploadedRetention, 0..365))
        Page.PROCESSING -> current.copy(
            jpegQuality = number(jpegQuality, 40..95), captureMaxSide = number(captureMaxSide, 640..2560),
            ocrMode = OcrPolicy.modes[ocrMode.selectedItemPosition], ocrAppModes = ocrAppModes.text.toString(),
            ocrChargingOnly = ocrChargingOnly.isChecked, imageDedupeMode = imageDedupeModes[imageDedupeMode.selectedItemPosition])
        Page.PRIVACY -> current.copy(
            excludedPackages = excludes.text.toString(), masks = checked(masks) { masks.text.toString().also { Mask.parse(it) } },
            appCollectionRules = checked(appPolicies) { AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString()).json() },
            metadataEnabled = metadataEnabled.isChecked, nsfw = current.nsfw.copy(enabled = nsfwEnabled.isChecked))
        Page.MODEL -> current.copy(nsfw = nsfwDraft().copy(enabled = current.nsfw.enabled),
            localReviewUrl = checked(review) { review.text.toString().trim().also { PrivacyRules.validateLocalReview(it) } })
        Page.DIAGNOSTICS -> current.copy(diagnosticsEnabled = diagnosticEnabled.isChecked, diagnosticsIntervalSeconds = number(diagnosticInterval, 15..3600))
        Page.DEVELOPER -> current.copy(debugHttp = http.isChecked, imageDedupeDiagnosticsEnabled = imageDedupeDiagnosticsEnabled.isChecked,
            contentEncryptionEnabled = contentEncryptionEnabled.isChecked)
        else -> current
    }
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
    private fun saveNsfw(after: () -> Unit) = try {
        val current = freshConfig()
        val next = current.copy(nsfw = current.nsfw.copy(enabled = nsfwEnabled.isChecked))
        applySettings(next, expected = current, appliedFields = setOf(nsfwEnabled.tag as String), saved = after)
    } catch (error: Exception) { toast(error.message ?: "请检查 NSFW 配置") }
    private fun saveConfig(bindLocal: Boolean = false, after: () -> Unit = {}): Unit {
        if (applyingSettings || uiTask.busy) return
        val current = loadedConfig
        val c = runCatching { draft(current).also { it.validate() } }.getOrElse { toast(it.message ?: "请检查配置输入"); return }
        val savedFields = pageControlValues().keys
        val submitted = baseline + controlValues().filterKeys { it in savedFields }; val generation = draftGeneration
        if (c.server == current.server && c.token == current.token) {
            applySettings(c, bindLocal, expected = current, appliedFields = savedFields, submitted = submitted, generation = generation, saved = after)
            return
        }
        applyingSettings = true; updateSaveBar()
        val app = applicationContext
        // The accepted save must survive rotation while preflight is waiting on storage.
        // This handler only continues the operation; UiTask still owns all progress polling.
        val completion = Handler(Looper.getMainLooper())
        uiTask.start("正在检查本机待同步资料…", { saveHint.text = it }, {
            val result = runCatching {
                if (settings.read() != current) throw SettingsChangedFailure()
                c.hasSyncConnection() && settings.dataOrigin().isBlank() && settings.hasPendingData() && !bindLocal
            }
            completion.post {
                applyingSettings = false
                if (isDestroyed || isFinishing) {
                    // Binding still requires a visible confirmation; preserve that draft for review.
                    if (result.getOrNull() == false) RuntimeSettings.apply(app, c, bindLocal, expected = current) { }
                    return@post
                }
                updateSaveBar()
                result.onSuccess { needsBinding ->
                    if (needsBinding) AlertDialog.Builder(this).setTitle("将本机资料绑定到此节点？")
                        .setMessage("${c.server}\n\n本机已有尚未绑定的截图、笔记或来源资料。确认后会绑定到这个档案地址，并按你的同步策略发送。请核对这是你自己的节点。")
                        .setNegativeButton("继续保存在本机", null).setPositiveButton("确认绑定并保存") { _, _ -> applySettings(c, true, expected = current, appliedFields = savedFields, submitted = submitted, generation = generation, saved = after) }.show()
                    else applySettings(c, bindLocal, expected = current, appliedFields = savedFields, submitted = submitted, generation = generation, saved = after)
                }.onFailure { toast(it.message ?: "无法检查设置，请重试"); refreshStatus() }
            }
        }) { }
    }
    private fun freshConfig(): CollectorConfig {
        return loadedConfig
    }
    private fun applySettings(config: CollectorConfig, bindLocal: Boolean = false, expected: CollectorConfig,
        appliedFields: Set<String> = pageControlValues().keys,
        submitted: Map<String, String> = baseline + controlValues().filterKeys { it in appliedFields },
        generation: Int = draftGeneration, saved: () -> Unit) {
        if (applyingSettings) return
        applyingSettings = true; updateSaveBar()
        RuntimeSettings.apply(this, config, bindLocal, expected = expected) { result ->
            applyingSettings = false
            if (isDestroyed) return@apply
            result.onSuccess {
                // Keep edits made after this save started, including edits on a newly opened page.
                val comparison = if (generation == draftGeneration) submitted else baseline
                val laterEdits = pageControlValues().filter { (key, value) -> comparison[key] != value }
                reloadSettings(RuntimeSettings.currentConfiguration ?: loadedConfig); restoreControlValues(laterEdits)
                saved(); toast("设置已保存"); resumeProjectionAfterSettings()
            }.onFailure {
                RuntimeSettings.currentConfiguration?.let { if (it != loadedConfig) reloadSettings(it) }
                toast(it.message ?: "设置未保存，请重试")
            }
            updateSaveBar(); refreshStatus()
        }
    }
    private fun startCapture() {
        if (ConnectionGuard.changing() || RuntimeSettings.stopping) { toast("正在连接节点，请稍后再开始采集"); return }
        if (settings.enabled) { toast("已启用，状态见上方"); return }
        val next = runCatching { draft().also { it.validate() } }.getOrElse { toast(it.message ?: "请检查设置"); return }
        if (next == loadedConfig) startConfiguredCapture() else saveConfig(after = { startConfiguredCapture() })
    }
    private fun startConfiguredCapture() {
        if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) { notifications(); toast("请先允许通知，然后再次点击开始"); return }
        val c = loadedConfig
        if (!c.screenCollectionEnabled) {
            if (!c.observesSystem()) { showPage(Page.CAPTURE); toast("请至少启用一种采集来源"); return }
            if (!MediaCollection.permissionAllowed(this)) { mediaPermission(); return }
            enableCapture(c, "通知、设备事件或媒体采集已启用；等待系统事件") {
                MediaCollectionService.refresh()
                if (!MediaCollectionService.connected) android.service.notification.NotificationListenerService.requestRebind(ComponentName(this, MediaCollectionService::class.java))
            }
            return
        }
        if (c.effectiveMode() == "accessibility") {
            if (Build.VERSION.SDK_INT < 30 && AppCollectionRules.parse(c.appCollectionRules).mayCollectContent()) { toast("Android 10 内容截图请勾选投屏模式；仅活动无需投屏"); return }
            if (!CaptureAccessibilityService.connected) { showPage(Page.PERMISSIONS); toast("请先启用无障碍截图服务，返回后再开始"); return }
            enableCapture(c, "采集已启用，等待首帧；配置页受系统安全保护") {}
        } else {
            if (!CaptureAccessibilityService.connected && AppCollectionRules.parse(c.appCollectionRules).requiresWindowIdentity(PrivacyRules.exclusions(c.excludedPackages))) {
                showPage(Page.PERMISSIONS); toast("分级采集需要可靠窗口身份，请先启用无障碍服务；不会读取控件文字"); return
            }
            requestProjectionConsent()
        }
        refreshStatus()
    }
    private fun enableCapture(config: CollectorConfig, message: String, after: () -> Unit) {
        uiTask.start("正在启用采集…", { status.text = it }, {
            ConnectionGuard.startCapture(applicationContext, SourceRules.hash(config.toString())) {
                Operations.record(applicationContext, OperationKind.CAPTURE_STARTED); settings.status("capturing", message)
            }
        }) { result ->
            if (result.getOrDefault(false)) after() else toast("节点或配置已变化，请重新点击开始")
            refreshStatus()
        }
    }
    private fun requestProjectionConsent() {
        val c = loadedConfig
        if (!CaptureAccessibilityService.connected && AppCollectionRules.parse(c.appCollectionRules).requiresWindowIdentity(PrivacyRules.exclusions(c.excludedPackages))) {
            showPage(Page.PERMISSIONS); toast("分级采集需要可靠窗口身份，请先启用无障碍服务"); return
        }
        val manager = getSystemService(MediaProjectionManager::class.java)
        val intent = if (Build.VERSION.SDK_INT >= 34) manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay()) else manager.createScreenCaptureIntent()
        projectionRequestStamp = SourceRules.hash(c.toString())
        @Suppress("DEPRECATION") startActivityForResult(intent, 100)
    }
    private fun resumeProjectionAfterSettings() {
        if (RuntimeSettings.takeProjectionConsentRequest()) startConfiguredCapture()
    }
    @Deprecated("Platform consent result API retained for the minimal native Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 105 && resultCode == RESULT_OK && data != null) {
            val quality = data.getIntExtra("quality", 75); val side = data.getIntExtra("maxSide", 1280)
            if (quality in 40..95 && side in 640..2560) {
                showPage(Page.CAPTURE); jpegQuality.setText(quality.toString()); captureMaxSide.setText(side.toString())
                toast("参数已带回采集设置，请点击保存后应用")
            }
            return
        }
        if (requestCode in setOf(103, 104) && resultCode == RESULT_OK && data?.data != null) {
            val uri = data.data!!; val app = applicationContext
            uiTask.start("正在导出诊断包…", { technicalStatus.text = it }, {
                val body = if (requestCode == 104) SupportEvents.export(app) else Diagnostics(app).export()
                app.contentResolver.openOutputStream(uri)!!.use { it.write(body.toByteArray()) }
            }) { result -> toast(if (result.isSuccess) "诊断包已导出" else "诊断导出失败") }
            return
        }
        if (requestCode == 102 && resultCode == RESULT_OK && data?.data != null) {
            val uri = data.data!!; val app = applicationContext
            uiTask.start("正在导入并校验模型…", { nsfwStatus.text = it }, {
                val store = NsfwModelStore(app)
                app.contentResolver.openInputStream(uri)!!.use { store.importModel(it) }; NsfwClient.resetAll()
            }) { result -> toast(if (result.isSuccess) "模型导入完成" else "导入失败，请核对模型大小与 SHA-256；原模型保留"); refreshStatus() }
            return
        }
        if (requestCode == 100 && resultCode == RESULT_OK && data != null) {
            val stamp = projectionRequestStamp; projectionRequestStamp = null
            val startProjection = {
                startForegroundService(Intent(this, ProjectionService::class.java).putExtra("result", resultCode).putExtra("consent", data).putExtra("configurationStamp", stamp))
                Operations.record(this, OperationKind.CAPTURE_STARTED)
            }
            uiTask.start("正在启用投屏采集…", { status.text = it }, {
                stamp != null && if (settings.enabled) ConnectionGuard.sync {
                    val c = settings.read()
                    if (stamp == SourceRules.hash(c.toString()) && c.screenCollectionEnabled && c.effectiveMode() == "projection" && c.observesSystem() && !ProjectionService.running) {
                        startProjection(); true
                    } else false
                } == true else ConnectionGuard.startCapture(applicationContext, stamp, startProjection)
            }) { result ->
                if (!result.getOrDefault(false)) settings.status(if (settings.enabled) "capturing" else "permission_required", "节点或采集配置已变化，本次授权已丢弃；请重新点击开始")
                refreshStatus()
            }
        } else if (requestCode == 100) settings.status(if (settings.enabled) "capturing" else "permission_required", "你未授予投屏权限，未开始截图" + if (settings.enabled) "；媒体采集继续运行" else "")
    }
    private fun stopCapture() {
        RuntimeSettings.cancelProjectionConsentRequest()
        RuntimeSettings.stop(this) { result ->
            if (isDestroyed) return@stop
            result.onSuccess {
                settings.status("paused", "你已停止采集，已有记录保留，同步按所选策略运行")
            }.onFailure { toast(it.message ?: "停止未完成，请重试") }
            refreshStatus()
        }
    }
    private fun refreshStatus() {
        if (!::status.isInitialized) return
        // Capture controls reflect cheap live state before optional statistics/diagnostics.
        // A slow inventory must not make a successful Start look unresponsive.
        val action = if (settings.enabled) "暂停采集" else "开始采集"
        if (captureAction.text != action) {
            captureAction.text = action
            captureTitle.text = if (settings.enabled) "正在本机采集" else "采集已暂停"
            captureProgress.visibility = if (settings.enabled) View.VISIBLE else View.GONE
            status.text = settings.message()
        }
        if (QueueStorage.recovering) { status.text = "正在连接本机存储，文件整理将在后台继续…"; return }
        if (ConnectionGuard.reconfiguring()) { status.text = RuntimeSettings.progressLabel(); updateSaveBar(); saveHint.text = RuntimeSettings.progressLabel(); return }
        if (isDestroyed) return
        if (statusLoading) { statusRefreshPending = true; return }
        statusLoading = true
        // Queue recovery, Keystore reads and diagnostic writes may wait for a worker.
        // Keep one request in flight; a slow scan must never accumulate refresh jobs.
        statusExecutor.execute {
            val result = runCatching { readStatus() }
            handler.post {
                statusLoading = false
                if (!resumed || isDestroyed || isFinishing) return@post
                if (QueueStorage.recovering || ConnectionGuard.reconfiguring()) { refreshStatus(); return@post }
                result.onSuccess { snapshot ->
                    snapshot.config?.let { if (!applyingSettings && it != loadedConfig) reloadSettings(it) }
                    captureTitle.text = snapshot.title; captureAction.text = snapshot.action
                    captureProgress.visibility = if (settings.enabled) View.VISIBLE else View.GONE
                    status.text = snapshot.status; syncStatus.text = snapshot.sync
                    totalsStatus.text = snapshot.totals; technicalStatus.text = snapshot.technical
                    connectionSummary.text = snapshot.connection; nsfwStatus.text = snapshot.model
                    mediaStatus.text = snapshot.media
                    updateSaveBar()
                }.onFailure { captureProgress.visibility = View.GONE; status.text = "状态暂不可读取，已有记录保留在本机；稍后自动重试" }
                if (statusRefreshPending) { statusRefreshPending = false; refreshStatus() }
            }
        }
    }
    private fun readStatus(): StatusSnapshot {
        val c = runCatching { settings.read() }.getOrNull()
        val local = LocalStateRepository.get(this).state.value
        if (c != null) runCatching { Diagnostics(this).sample(c) }
        val screenLive = c?.screenCollectionEnabled == true && (if (c.effectiveMode() == "projection") ProjectionService.running else CaptureAccessibilityService.connected)
        val live = screenLive || (c?.observesSystem() == true && MediaCollectionService.connected)
        val state = if (settings.enabled && !live) "采集服务未连接：请恢复权限" else if (settings.state() == "capturing") "正在采集" else settings.message()
        val stats = runCatching { Operations.ledger(this).read().getJSONObject("counts") }.getOrNull()
        val totals = if (stats == null) "统计暂不可读取" else "本周期累计截图记录 ${stats.optLong("SCREEN_QUEUED")} · 应用活动 ${stats.optLong("ACTIVITY_QUEUED")} · 媒体 ${stats.optLong("MEDIA_QUEUED")} · 笔记 ${stats.optLong("NOTE_QUEUED")} · 已确认 ${stats.optLong("SCREEN_ACK") + stats.optLong("NOTE_ACK") + stats.optLong("ACTIVITY_ACK") + stats.optLong("MEDIA_ACK")}\n拦截 ${stats.optLong("FRAME_BLOCKED")} · 失败 ${stats.optLong("CAPTURE_FAILED") + stats.optLong("ACTIVITY_FAILED") + stats.optLong("MEDIA_FAILED")} · 重试结果 ${stats.optLong("UPLOAD_RETRY")}"
        val queueStats = local.active
        val pending = local.pending
        val bytes = queueStats?.quotaBytes?.div(1024.0 * 1024)
        val modelMissing = c != null && c.screenCollectionEnabled && c.nsfw.enabled && AppCollectionRules.parse(c.appCollectionRules).mayCollectContent() && !NsfwModelStore(this).hasFile()
        val queueFull = c != null && bytes != null && bytes >= c.maxQueueMiB
        val title = when {
            settings.enabled && !live -> "等待采集权限"
            settings.enabled && queueFull -> "本机空间已满"
            settings.enabled && modelMissing -> "等待本机过滤模型"
            settings.enabled && settings.state() == "paused" -> "采集暂时等待"
            settings.enabled -> "正在本机采集"
            else -> "采集已暂停"
        }
        val action = if (settings.enabled) "暂停采集" else "开始采集"
        val syncWait = c?.takeIf { it.hasSyncConnection() }?.let { SyncSchedule.waitingReason(this, it) }
        val syncMessage = when {
            c == null -> "无法读取同步配置"
            !c.hasSyncConnection() -> "仅保存在本机 · 尚未连接节点"
            syncWait != null -> syncWait
            c.syncMode == "manual" && settings.syncState() !in setOf("uploading", "error", "waiting") -> "手动同步 · 点击立即同步才会发送"
            c.syncMode in setOf("interval", "batch") && settings.syncState() !in setOf("uploading", "error") ->
                if (c.syncMode == "interval") "约每 ${c.syncIntervalMinutes} 分钟同步" else "满 ${c.syncBatchSize} 条或等待 ${c.syncIntervalMinutes} 分钟同步"
            else -> settings.uploadStatus()
        }
        val syncText = "${pending?.let { "待同步 $it 条" } ?: "队列暂不可读取"}${bytes?.let { " · ${"%.1f".format(it)} MiB" } ?: ""}\n$syncMessage"
        val totalsText = local.imageLabel() + (if (QueueStorage.maintaining) " · 后台整理中，可正常采集" else "") + "\n" + if (stats == null) "累计统计暂不可读取" else "本周期累计截图记录 ${stats.optLong("SCREEN_QUEUED")}    活动 ${stats.optLong("ACTIVITY_QUEUED")}    媒体 ${stats.optLong("MEDIA_QUEUED")}    随手记 ${stats.optLong("NOTE_QUEUED")}\n本周期已同步 ${stats.optLong("SCREEN_ACK") + stats.optLong("NOTE_ACK") + stats.optLong("ACTIVITY_ACK") + stats.optLong("MEDIA_ACK")} 条"
        val technicalText = "$state\n$totals\n$syncText\n${settings.uploadStatus()}\n无障碍 ${if (CaptureAccessibilityService.connected) "已连接" else "未连接"} · 使用情况 ${if (ForegroundApps.usageAllowed(this)) "已授权" else "未授权"}\n最近采集 ${settings.lastCapture() ?: "无"}"
        val connectionText = if (c?.server.isNullOrBlank()) "尚未连接中央节点，请导入邀请或填写下方设置。" else "已保存节点：${c?.server}"
        val model = NsfwModelStore(this)
        return StatusSnapshot(title, action, state, syncText, totalsText, technicalText, connectionText, "${model.status()}\n${model.inferenceStatus()}", MediaCollection.statusLabel(this), c)
    }
    private fun mediaPermission() {
        AlertDialog.Builder(this).setTitle("媒体播放状态授权")
            .setMessage("Android 通过通知使用权开放通知与媒体会话。开启通知采集后，Mote 会保存应用公开的标题、正文、持续状态以及更新和移除事件，并按同步策略上传。设备事件单独记录亮屏、熄屏和锁定状态。各来源需单独开启并点击开始；应用的“不记录”和“仅活动”规则仍适用。系统可能隐藏敏感通知；Mote 不回复通知、不控制播放。")
            .setNegativeButton("取消", null).setPositiveButton("打开系统设置") { _, _ ->
                safeOpen(Intent(SystemSettings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }.show()
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
        resumed = true
        notePoll?.let { handler.removeCallbacks(it); handler.post(it) }
        if (::server.isInitialized) updatePermissionSummary()
        RuntimeSettings.observeProjectionConsent { if (::server.isInitialized) resumeProjectionAfterSettings() }
        RuntimeSettings.observeConfiguration {
            if (!applyingSettings && !isDestroyed) refreshStatus()
        }
        localStateJob = observeLocalState { refreshStatus() }
        handler.post(refresh)
        handler.post(decryptPoll)
    }
    override fun onPause() { localStateJob?.cancel(); localStateJob = null; resumed = false; notePoll?.let(handler::removeCallbacks); RuntimeSettings.observeProjectionConsent(null); RuntimeSettings.observeConfiguration(null); handler.removeCallbacks(refresh); handler.removeCallbacks(decryptPoll); super.onPause() }
    override fun onStop() { if (!isChangingConfigurations) discardPageDraft(); super.onStop() }
    override fun onDestroy() { statusExecutor.shutdownNow(); handler.removeCallbacksAndMessages(null); super.onDestroy() }
    private fun dp(value: Int) = moteDp(value)

    private fun help(title: String, message: String) {
        text(title + "  ›", 13, MoteUi.accent).apply {
            minHeight = dp(44); gravity = Gravity.CENTER_VERTICAL; isFocusable = true
            setOnClickListener { AlertDialog.Builder(this@MainActivity).setTitle(title).setMessage(message).setPositiveButton("知道了", null).show() }
        }
    }
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
        if (page == Page.PERMISSIONS) updatePermissionSummary()
        if (currentPage != page) {
            if (pageControlValues().isNotEmpty()) discardPageDraft()
            else pages[currentPage]?.let { scrollPositions[currentPage] = it.scrollY }
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
        if (initializing) { finish(); return }
        when {
            currentPage.parent != null -> showPage(Page.valueOf(currentPage.parent!!))
            currentPage != Page.OVERVIEW -> showPage(Page.OVERVIEW)
            else -> finish()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("page", currentPage.name)
        super.onSaveInstanceState(outState)
    }

    // Keep unsaved sensitive settings in memory across rotation; never serialize credentials to a Bundle.
    @Deprecated("Native Activity in-memory configuration retention")
    override fun onRetainNonConfigurationInstance(): Any? = if (::loadedConfig.isInitialized) RetainedDraft(pageControlValues(), loadedConfig) else null

    private fun updateSaveBar() {
        if (!::saveBar.isInitialized || initializing) return
        val current = pageControlValues()
        val dirty = current.any { (key, value) -> baseline[key] != value }
        saveBar.visibility = if (current.isNotEmpty() && (dirty || applyingSettings)) View.VISIBLE else View.GONE
        (saveBar.getChildAt(1) as Button).isEnabled = !applyingSettings && !ConnectionGuard.reconfiguring()
        saveHint.text = if (applyingSettings) "正在保存…" else "有未保存的更改"
    }

    private fun pageControlValues() = controlValues(controls.filter { controlPages[it] == currentPage })

    private fun restoreControlValues(values: Map<String, String>) {
        val wasApplying = applyingConnectionFields
        applyingConnectionFields = true
        try { controls.forEach { view -> values[view.tag as String]?.let { value -> when (view) {
            is EditText -> { if (view.text.toString() != value) view.setText(value); view.error = null }
            is CheckBox -> view.isChecked = value.toBoolean()
            is Spinner -> view.setSelection(value.toInt())
        } } } } finally { applyingConnectionFields = wasApplying }
        updateSyncFields(); updateSaveBar()
    }

    private fun discardPageDraft() {
        if (initializing) return
        val discarded = controls.filter { controlPages[it] == currentPage }
        if (discarded.isEmpty()) return
        draftGeneration++
        val config = loadedConfig
        run {
            initializing = true; applyingConnectionFields = true
            try {
                pages.remove(currentPage)?.let(pagesHost::removeView)
                discarded.forEach { controls.remove(it); controlPages.remove(it); if (it is EditText) fieldLabels.remove(it) }
                buildSettingsPage(currentPage, config)
                baseline = baseline + pageControlValues()
            } finally { initializing = false; applyingConnectionFields = false }
            showPage(currentPage)
        }
        scrollPositions.remove(currentPage); pages[currentPage]?.scrollTo(0, 0)
    }

    private fun buildSettingsPage(page: Page, config: CollectorConfig) = when (page) {
        Page.CONNECTION -> buildConnection(config); Page.CAPTURE -> buildCapture(config); Page.PRIVACY -> buildPrivacy(config)
        Page.PROCESSING -> buildProcessing(config); Page.STORAGE -> buildStorage(config)
        Page.DEVELOPER -> buildDeveloper(config); Page.DIAGNOSTICS -> buildDiagnostics(config); Page.MODEL -> buildModel(config)
        else -> Unit
    }

    /** Rebuild every settings form from the committed snapshot after pairing or another activity saves. */
    private fun reloadSettings(config: CollectorConfig) {
        initializing = true; applyingConnectionFields = true
        try {
            val editablePages = controlPages.values.toSet()
            editablePages.forEach { page -> pages.remove(page)?.let(pagesHost::removeView) }
            controls.forEach { if (it is EditText) fieldLabels.remove(it) }
            controls.clear(); controlPages.clear()
            loadedConfig = config; loadedServer = config.server
            editablePages.forEach { buildSettingsPage(it, config) }
            baseline = controlValues()
        } finally { applyingConnectionFields = false; initializing = false }
        showPage(currentPage)
    }

    private fun controlValues(views: List<View> = controls) = views.associate { view ->
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
    private fun appModeLabel(mode: AppCollectionMode) = when (mode) { AppCollectionMode.CONTENT -> "截图与内容"; AppCollectionMode.ACTIVITY -> "仅应用和时长"; AppCollectionMode.OFF -> "不记录" }
    private fun chooseAppMode(id: String, label: String, onChanged: () -> Unit = {}) {
        val current = runCatching { AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString()) }.getOrElse { toast("请先修正高级规则"); return }
        val selectedIndex = if (id in PrivacyRules.exclusions(excludes.text.toString())) 2 else current.apps[id]?.ordinal ?: 3
        AlertDialog.Builder(this).setTitle(label).setSingleChoiceItems(arrayOf("截图与内容 · 保存过滤后的截图", "仅应用和时长 · 不保存截图", "不记录 · 跳过此应用", "使用默认方式 · ${appModeLabel(current.defaultMode)}"), selectedIndex) { dialog, index ->
            runCatching {
                val rules = AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString())
                val selected = rules.apps.toMutableMap()
                if (index == 3) selected.remove(id) else selected[id] = AppCollectionMode.entries[index]
                AppCollectionRules.parse(AppCollectionRules(rules.defaultMode, selected).json())
                excludes.setText(PrivacyRules.exclusions(excludes.text.toString()).filterNot { it == id }.joinToString("\n"))
                appPolicies.setText(selected.entries.joinToString("\n") { "${it.key}=${it.value.wire}" })
                dialog.dismiss(); onChanged()
            }.onFailure { toast(it.message ?: "请检查应用规则") }
        }.setNegativeButton("取消", null).show()
    }
    private fun chooseInstalledApp() {
        val configured = AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString()).apps.keys + PrivacyRules.exclusions(excludes.text.toString())
        var apps = emptyList<Pair<String, String>>()
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(8)) }
        val search = MoteUi.field(EditText(this)).apply { hint = "搜索应用名称"; setSingleLine() }; body.addView(search)
        val list = ListView(this); body.addView(list, LinearLayout.LayoutParams(-1, dp(340)))
        val modes = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf("全部应用", "截图与内容", "仅应用和时长", "不记录"))
        }; body.addView(modes, 1)
        val summary = TextView(this); body.addView(summary, 2)
        var shown = apps
        fun filter() {
            val query = search.text.toString().trim()
            val rules = runCatching { AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString()) }.getOrNull() ?: return
            val excluded = PrivacyRules.exclusions(excludes.text.toString())
            fun mode(id: String) = if (id in excluded) AppCollectionMode.OFF else rules.apps[id] ?: rules.defaultMode
            shown = apps.filter { (query.isEmpty() || it.second.contains(query, true) || it.first.contains(query, true)) &&
                (modes.selectedItemPosition == 0 || mode(it.first).ordinal == modes.selectedItemPosition - 1) }
            summary.text = "${shown.size} 个应用 · 点按更改，返回后保存生效"
            list.adapter = object : ArrayAdapter<Pair<String, String>>(this, android.R.layout.simple_list_item_2, shown) {
                override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                    val view = convertView ?: layoutInflater.inflate(android.R.layout.simple_list_item_2, parent, false)
                    val app = getItem(position)!!
                    view.findViewById<TextView>(android.R.id.text1).text = app.second
                    view.findViewById<TextView>(android.R.id.text2).text = "${appModeLabel(mode(app.first))} · ${if (app.first in excluded || app.first in rules.apps) "单独设置" else "默认"}\n${app.first}"
                    return view
                }
            }
        }
        modes.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { filter() }
        }
        val dialog = AlertDialog.Builder(this).setTitle("应用记录方式").setView(body).setNegativeButton("完成", null).create()
        list.setOnItemClickListener { _, _, position, _ -> val app = shown[position]; chooseAppMode(app.first, app.second) { filter() } }
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { filter() }
        }); filter(); dialog.show()
        uiTask.start("正在读取已安装应用…", { if (dialog.isShowing) summary.text = it }, {
            InstalledApps.load(packageManager, configured)
        }) { result ->
            if (dialog.isShowing) result.onSuccess { apps = it; filter() }.onFailure { summary.text = "应用列表读取失败，请关闭后重试" }
        }
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
