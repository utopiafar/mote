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

class MainActivity : MoteActivity() {
    private lateinit var settings: Settings
    private lateinit var content: LinearLayout
    private var loadedServer: String? = null
    private lateinit var loadedConfig: CollectorConfig
    private var projectionRequestStamp: String? = null
    private var applyingConnectionFields = false
    private lateinit var status: TextView
    private lateinit var captureTitle: TextView
    private lateinit var captureProgress: ProgressBar
    private lateinit var packedUpload: CheckBox
    private lateinit var syncStatus: TextView
    private lateinit var totalsStatus: TextView
    private lateinit var technicalStatus: TextView
    private lateinit var captureAction: Button
    private lateinit var centralConnectionTitle: TextView
    private lateinit var centralConnectionStatus: TextView
    private lateinit var connectionSummary: TextView
    private lateinit var saveBar: LinearLayout
    private var applyingSettings = false
    private var pendingSubmission: Map<String, String>? = null
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
    private enum class Page(private val titleKey: String, val parent: String? = null) {
        OVERVIEW("今天"), LIBRARY("资料"), ASK("问一问"), NOTES("随手记", "SETTINGS"), SOURCES("本机来源", "SETTINGS"), SETTINGS("本机"),
        CONNECTION("连接与同步", "SETTINGS"), CAPTURE("采集与存储", "SETTINGS"),
        PROCESSING("图像与文字识别", "CAPTURE"), STORAGE("本机存储", "CAPTURE"),
        PRIVACY("隐私与应用规则", "SETTINGS"), PERMISSIONS("权限与后台运行", "SETTINGS"),
        ABOUT("关于与更新", "SETTINGS"), DEVELOPER("开发者选项", "ABOUT"),
        DIAGNOSTICS("诊断与支持", "DEVELOPER"), MODEL("模型高级设置", "DEVELOPER")
    ;
        val title get() = MoteI18n.text(titleKey)
    }
    private var logExportHours = 24
    private data class RetainedDraft(val fields: Map<String, String>, val config: CollectorConfig)
    private lateinit var server: EditText
    private lateinit var token: EditText
    private lateinit var name: EditText
    private lateinit var interval: EditText
    private lateinit var uploadedRetention: EditText
    private lateinit var maxQueue: EditText
    private lateinit var excludes: EditText
    private lateinit var uiPageMode: Spinner
    private lateinit var uiPageRules: EditText
    private lateinit var masks: EditText
    private lateinit var review: EditText
    private lateinit var syncMode: Spinner
    private lateinit var syncInterval: EditText
    private lateinit var syncBatch: EditText
    private lateinit var jsonlWindow: EditText
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
    private lateinit var diagnosticInterval: EditText
    private lateinit var gateEnabled: CheckBox
    private lateinit var gateText: EditText
    private lateinit var gateFailure: Spinner
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
    private val permissionBadges = linkedMapOf<String, TextView>()
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
        val totals: String, val technical: String, val connectionTitle: String, val connection: String,
        val model: String, val media: String, val config: CollectorConfig?)
    private val refresh = object : Runnable {
        override fun run() { refreshStatus(); handler.postDelayed(this, 2000) }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { navigateBack() }
        settings = Settings(this)
        val retained = lastNonConfigurationInstance as? RetainedDraft
        val loading = moteDetailPage()
        val label = TextView(this).apply { text = MoteI18n.text("正在读取本机设置…") }; loading.addView(label); loading.addView(ProgressBar(this))
        uiTask.start(MoteI18n.text("正在读取本机设置…"), { label.text = it }, { settings.read() }) { result ->
            result.onSuccess { buildUi(it, savedInstanceState, retained); if (resumed) { updatePermissionSummary(); refreshStatus() } }
                .onFailure { label.text = MoteI18n.text("设置无法读取，原数据保留。请退出后检查存储或重试。") }
        }
    }
    private fun buildUi(config: CollectorConfig, savedInstanceState: Bundle?, retained: RetainedDraft?) {
        loadedServer = config.server; loadedConfig = config
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setBackgroundColor(MoteUi.background); moteInsets()
        }
        val quickNote = MoteUi.button(Button(this).apply {
            text = MoteI18n.text("记录"); contentDescription = MoteI18n.text("写一条随手记")
            setOnClickListener { showPage(Page.NOTES) }
        })
        root.addView(quickNote, LinearLayout.LayoutParams(-2, dp(48)).apply { gravity = Gravity.END; marginEnd = dp(16) })
        pagesHost = FrameLayout(this)
        root.addView(pagesHost, LinearLayout.LayoutParams(-1, 0, 1f))
        saveBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(22), dp(10), dp(22), dp(10)); setBackgroundColor(Color.WHITE)
        }
        saveHint = TextView(this).apply { textSize = 12f; setTextColor(MoteUi.muted) }
        saveBar.addView(saveHint, LinearLayout.LayoutParams(0, -2, 1f))
        saveBar.addView(MoteUi.button(Button(this).apply {
            text = MoteI18n.text("保存设置"); setOnClickListener { saveConfig() }
        }, true), LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(12) })
        root.addView(saveBar)
        val nav = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(dp(12), dp(8), dp(12), dp(8)); setBackgroundColor(Color.WHITE)
            elevation = dp(2).toFloat()
        }
        listOf(Page.OVERVIEW, Page.LIBRARY, Page.ASK, Page.SETTINGS).forEach { page ->
            val item = TextView(this).apply {
                text = page.title; textSize = 14f; gravity = Gravity.CENTER; minHeight = dp(60)
                compoundDrawablePadding = dp(4); isFocusable = true
                contentDescription = page.title; setOnClickListener { showPage(page) }
            }
            navigation[page] = item
            nav.addView(item, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(3); marginEnd = dp(3) })
        }
        root.addView(nav)
        setContentView(root)
        // CollectorConfig is the complete draft baseline. Unvisited pages never supply defaults.
        buildToday()
        buildOverview()
        buildSettings()
        val restoredPage = savedInstanceState?.getString("page")?.let { value -> Page.entries.find { it.name == value } } ?: Page.OVERVIEW
        ensurePage(restoredPage)
        baseline = controlValues()
        retained?.let { retained ->
            if (retained.config == config) restoreControlValues(retained.fields)
        }
        initializing = false
        showPage(restoredPage)
        refreshStatus()
    }

    private fun buildToday() {
        page(Page.OVERVIEW, MoteI18n.text("回看最近记录，确认下一步行动"))
        menu(MoteI18n.text("最近记录"), MoteI18n.text("本机保存的内容，离线也能查看"), "capture") { startActivity(Intent(this, CaptureRecordsActivity::class.java)) }
        menu(MoteI18n.text("随手记"), MoteI18n.text("留住此刻的想法"), "note") { showPage(Page.NOTES) }
        menu(MoteI18n.text("日程建议"), MoteI18n.text("逐条确认，添加到手机已有日历"), "folder") { startActivity(Intent(this, CalendarActionsActivity::class.java)) }
        menu(MoteI18n.text("中央工作台"), MoteI18n.text("需要独立登录中央；设备配对不授予资料读取权限"), "sync") { startActivity(Intent(this, CentralActivity::class.java).putExtra("page", "overview")) }
        menu(MoteI18n.text("本机采集"), MoteI18n.text("查看正在收集什么，随时暂停"), "capture") { showPage(Page.SETTINGS) }
    }

    private fun buildLibrary() {
        page(Page.LIBRARY, MoteI18n.text("本机记录与中央归档，分别查看"))
        menu(MoteI18n.text("本机记录"), MoteI18n.text("无需中央登录；查看本机保存和待同步内容"), "capture") { startActivity(Intent(this, CaptureRecordsActivity::class.java)) }
        menu(MoteI18n.text("中央资料库"), MoteI18n.text("需要独立登录中央；设备配对不授予资料读取权限"), "folder") { startActivity(Intent(this, CentralActivity::class.java).putExtra("page", "archive")) }
        menu(MoteI18n.text("本机来源"), MoteI18n.text("文件、日历、媒体与通知"), "folder") { showPage(Page.SOURCES) }
    }

    private fun buildAsk() {
        page(Page.ASK, MoteI18n.text("基于已授权资料回答，并保留证据来源"))
        text(MoteI18n.text("问答需要中央所有者授权，设备配对凭据不能用于问答。"), 16, MoteUi.muted)
        button(MoteI18n.text("打开对话"), true) { startActivity(Intent(this, AskActivity::class.java)) }
    }

    private fun buildOverview() {
        page(Page.SETTINGS, MoteI18n.text("本机采集、隐私与同步，各自可控"))
        menu(MoteI18n.text("问一问"), MoteI18n.text("对话在中央继续，可随时返回查看或停止"), "note") { startActivity(Intent(this, AskActivity::class.java)) }
        menu(MoteI18n.text("中央导出"), MoteI18n.text("导出中央元数据与资料"), "folder") { startActivity(Intent(this, BackupActivity::class.java)) }
        card(MoteUi.tint) {
            text(MoteI18n.text("此刻的 Mote"), 12, MoteUi.accent)
            captureTitle = text(MoteI18n.text("采集已暂停"), 26)
            status = text(settings.message(), 14, MoteUi.muted)
            captureProgress = ProgressBar(this@MainActivity, null, android.R.attr.progressBarStyleHorizontal).apply { isIndeterminate = true; visibility = View.GONE }
            content.addView(captureProgress)
            captureAction = button(MoteI18n.text("开始采集"), true) { if (settings.enabled) stopCapture() else startCapture() }
            text(MoteI18n.text("未连接节点也能采集；随时可以暂停。"), 12, MoteUi.muted)
        }
        section(MoteI18n.text("中央节点"))
        card {
            text(MoteI18n.text("中央节点连接"), 12, MoteUi.accent)
            centralConnectionTitle = text(MoteI18n.text("正在检查…"), 19)
            centralConnectionStatus = text(MoteI18n.text("正在读取保存的连接与同步状态…"), 13, MoteUi.muted)
            button(MoteI18n.text("连接设置")) { showPage(Page.CONNECTION) }
        }
        section(MoteI18n.text("同步状态"))
        card {
            syncStatus = text(MoteI18n.text("正在读取同步状态…"), 14)
            rowButtons(MoteI18n.text("立即同步"), { retrySync() }, MoteI18n.text("待上传队列"), { startActivity(Intent(this, SyncQueueActivity::class.java)) })
        }
        section(MoteI18n.text("本机记录"))
        totalsStatus = text(MoteI18n.text("正在读取统计…"), 15)
        menu(MoteI18n.text("日程建议"), MoteI18n.text("逐条确认，添加到手机已有日历"), "folder") { startActivity(Intent(this, CalendarActionsActivity::class.java)) }
        menu(MoteI18n.text("采集记录"), MoteI18n.text("按天查看本机与中央归档的图片、OCR 状态和文字"), "capture") { startActivity(Intent(this, CaptureRecordsActivity::class.java)) }
        menu(MoteI18n.text("统计中心"), MoteI18n.text("按日期和文件类型查看空间占用"), "chart") { startActivity(Intent(this, StorageStatisticsActivity::class.java)) }
        menu(MoteI18n.text("采集与存储详情"), MoteI18n.text("查看累计结果、队列与使用空间"), "chart") { startActivity(Intent(this, ActivityStatsActivity::class.java)) }
    }

    private fun buildSettings() {
        menu(if (MoteI18n.language() == "en") "Language" else "界面语言", "中文 / English", "settings") {
            val choices = arrayOf(if (MoteI18n.language() == "en") "System default" else "跟随系统", "中文", "English")
            val values = listOf("system", "zh-CN", "en")
            MoteDialogBuilder(this).setTitle(if (MoteI18n.language() == "en") "Language" else "界面语言")
                .setSingleChoiceItems(choices, values.indexOf(MoteI18n.preference())) { dialog, index ->
                    MoteI18n.select(this, values[index]); dialog.dismiss(); recreate()
                }.setNegativeButton(android.R.string.cancel, null).show()
        }

        menu(MoteI18n.text("本机来源"), MoteI18n.text("文件、日历、媒体与通知"), "folder") { showPage(Page.SOURCES) }
        menu(MoteI18n.text("诊断与支持"), MoteI18n.text("日志与问题排查"), "settings") { showPage(Page.DIAGNOSTICS) }
        section(MoteI18n.text("记录与数据"))
        menu(MoteI18n.text("连接与同步"), MoteI18n.text("中央节点、设备名称与上传网络"), "sync") { showPage(Page.CONNECTION) }
        menu(MoteI18n.text("采集与存储"), MoteI18n.text("采样频率、图像质量与电量策略"), "capture") { showPage(Page.CAPTURE) }
        menu(MoteI18n.text("本机存储"), MoteI18n.text("保留时间、空间上限与保存位置"), "folder") { showPage(Page.STORAGE) }
        menu(MoteI18n.text("导入与导出"), MoteI18n.text("迁移配置、备份与恢复本机记录"), "folder") { startActivity(Intent(this, BackupActivity::class.java)) }
        menu(MoteI18n.text("隐私与应用规则"), MoteI18n.text("应用采集级别、遮罩与本机过滤"), "shield") { showPage(Page.PRIVACY) }
        section(MoteI18n.text("应用"))
        menu(MoteI18n.text("权限与后台运行"), MoteI18n.text("系统授权、电池优化与自启动"), "settings") { showPage(Page.PERMISSIONS) }
        menu(MoteI18n.text("关于与更新"), MoteI18n.text("版本信息、应用更新与开发者选项"), "info") { showPage(Page.ABOUT) }
        menu(MoteI18n.text("反馈"), MoteI18n.text("前往 GitHub，可附图片或诊断包"), "note") { openFeedback() }
        text(MoteI18n.text("修改后请保存，再切换页面。"), 12, MoteUi.muted)
    }

    private fun openFeedback() {
        val uri = Uri.Builder().scheme("https").authority("github.com").path("/utopiafar/mote/issues/new")
            .appendQueryParameter("template", "bug_report.yml")
            .appendQueryParameter("version", "Mote ${BuildConfig.VERSION_NAME} · Android ${Build.VERSION.RELEASE} / API ${Build.VERSION.SDK_INT}")
            .appendQueryParameter("environment", MoteI18n.text("Android 客户端 · {0}", BuildConfig.MOTE_PROFILE))
            .build()
        try { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
        catch (_: ActivityNotFoundException) { toast(MoteI18n.text("无法打开 GitHub，请安装或启用浏览器后重试")) }
        catch (_: SecurityException) { toast(MoteI18n.text("系统未允许打开 GitHub，请检查浏览器设置后重试")) }
    }

    private fun buildSources() {
        page(Page.SOURCES, MoteI18n.text("把你选择的生活线索，收进同一份档案"))
        section(MoteI18n.text("已支持的来源"))
        menu(MoteI18n.text("屏幕与应用活动"), MoteI18n.text("采集来源、频率与电量策略"), "capture") { showPage(Page.CAPTURE) }
        menu(MoteI18n.text("应用采集规则"), MoteI18n.text("为普通与系统应用设置记录方式"), "shield") { showPage(Page.PRIVACY) }
        menu(MoteI18n.text("随手记"), MoteI18n.text("记录此刻的想法"), "note") { showPage(Page.NOTES) }
        menu(MoteI18n.text("日历与文件"), MoteI18n.text("连接日历、选择文件或授权目录"), "folder") { startActivity(Intent(this, SourcesActivity::class.java)) }
        card(MoteUi.tint) {
            text(MoteI18n.text("只连接你选择的内容"), 17)
            text(MoteI18n.text("日历和文件只在主动授权后读取；你可以为每个来源调整同步范围和保留方式。"), 14, MoteUi.muted)
        }
    }

    private fun buildConnection(config: CollectorConfig) {
        page(Page.CONNECTION, MoteI18n.text("可先只在本机记录，需要时再连接中央档案"))
        section(MoteI18n.text("统一同步方式"))
        text(MoteI18n.text("所有采集记录和来源文件共用以下同步设置。"), 13, MoteUi.muted)
        syncMode = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("实时同步"), MoteI18n.text("定时同步"), MoteI18n.text("批量同步"), MoteI18n.text("仅手动同步")))
            setSelection(syncModes.indexOf(config.syncMode).coerceAtLeast(0))
        }; content.addView(syncMode, LinearLayout.LayoutParams(-1, dp(56))); track(syncMode, "syncMode")
        syncInterval = presetNumber(MoteI18n.text("同步间隔 / 分钟（批量模式下也是最长等待时间）"), config.syncIntervalMinutes, "1", 1..1440, listOf(1, 15, 30, 60, 180, 360, 720, 1440))
        syncBatch = presetNumber(MoteI18n.text("批量达到多少条时同步"), config.syncBatchSize, "20", 1..500, listOf(5, 10, 20, 50, 100, 200, 500))
        packedUpload = check(MoteI18n.text("压缩包上传（gzip JSONL，服务端解包后逐条确认）"), config.packedUpload)
        jsonlWindow = presetNumber(MoteI18n.text("无图片状态 JSONL 合并窗口 / 分钟"), config.jsonlWindowMinutes, "10", 1..1440, listOf(1, 5, 10, 15, 30, 60))
        updateSyncFields()
        help(MoteI18n.text("同步方式说明"), MoteI18n.text("定时模式按所选间隔发送；批量模式达到数量或最长等待时间即发送。压缩包内是 gzip JSONL，服务端解包后逐条校验并确认。无图片的短状态记录会按时间窗口合并，默认 10 分钟。手动模式仅在点击“立即同步”后发送；同步条件始终有效。Android 省电可能推迟后台执行。"))
        section(MoteI18n.text("同步条件"))
        wifi = check(MoteI18n.text("仅非计费 Wi-Fi 同步"), config.wifiOnly)
        syncChargingOnly = check(MoteI18n.text("仅充电时同步"), config.syncChargingOnly)
        syncBatteryNotLow = check(MoteI18n.text("低电量时暂停同步"), config.syncBatteryNotLow)
        text(MoteI18n.text("适用于记录、来源文件和 OCR 结果。立即同步与全量补传也遵守这些条件；低电量由系统判定。"), 13, MoteUi.muted)
        section(MoteI18n.text("中央节点"))
        menu(MoteI18n.text("扫码或导入邀请"), MoteI18n.text("推荐使用中央节点生成的一次性邀请"), "sync") { discardPageDraft(); startActivity(Intent(this, ConnectionActivity::class.java)) }
        section(MoteI18n.text("节点与设备"))
        connectionSummary = text("", 13, MoteUi.muted)
        server = field(MoteI18n.text("节点 URL（可留空，仅在本机记录）"), config.server, "https://mote.example.com", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        token = field(MoteI18n.text("访问令牌（未连接时可留空）"), config.token, MoteI18n.text("建议通过邀请获取本设备凭据"), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        server.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun afterTextChanged(s: Editable?) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                if (!applyingConnectionFields && !loadedServer.isNullOrBlank() && s.toString().trim().trimEnd('/') != loadedServer!!.trimEnd('/') && token.text.isNotEmpty()) {
                    token.text.clear()
                    toast(MoteI18n.text("节点地址已修改，请明确填写新节点令牌；队列未清空时不能换节点"))
                }
            }
        })
        name = field(MoteI18n.text("设备名称"), config.deviceName, MoteI18n.text("我的 K90 Pro Max"))
        text(MoteI18n.text("中央节点可在电脑、NAS 或服务器部署。手机的 localhost 指手机本身；跨设备请填写局域网 IP 或 HTTPS 域名。"), 13, MoteUi.muted)
        button(MoteI18n.text("立即重试同步")) { retrySync() }
        menu(MoteI18n.text("待上传队列"), MoteI18n.text("查看采集、随手记和来源待发条目"), "sync") { startActivity(Intent(this, SyncQueueActivity::class.java)) }
        menu(MoteI18n.text("同步与恢复"), MoteI18n.text("两端检查、补传与冲突处理"), "sync") { startActivity(Intent(this, SyncRecoveryActivity::class.java)) }
    }

    private fun buildCapture(config: CollectorConfig) {
        page(Page.CAPTURE, MoteI18n.text("在记录密度、清晰度和耗电之间找到平衡"))
        section(MoteI18n.text("采集来源"))
        screenCollectionEnabled = check(MoteI18n.text("采集屏幕与前台应用活动"), config.screenCollectionEnabled)
        notificationCollectionEnabled = check(MoteI18n.text("采集通知（正文、持续状态、更新与移除）"), config.notificationCollectionEnabled)
        deviceEventCollectionEnabled = check(MoteI18n.text("采集亮屏、熄屏与锁定 / 解锁事件"), config.deviceEventCollectionEnabled)
        help(MoteI18n.text("通知与设备事件说明"), MoteI18n.text("通知与设备事件可独立开启，通过系统通知服务观察，按同步策略上传。通知遵循应用规则：仅活动不读取正文，不记录会完全跳过。系统可能隐藏敏感内容；熄屏不等同于锁定。"))
        mediaCollectionEnabled = check(MoteI18n.text("采集媒体播放状态（需通知使用权）"), config.mediaCollectionEnabled)
        help(MoteI18n.text("媒体采集说明"), MoteI18n.text("媒体采集可单独开启，在前台、后台和锁屏时观察播放器公开的状态、应用及曲目/章节信息；不录音、不控制播放。普通通知由单独的通知采集开关控制。使用概览页的开始/暂停控制采集。媒体沿用应用隐私规则、电量限制和同步策略；关闭元数据会同时暂停媒体。"))
        mediaStatus = text(MoteI18n.text("媒体状态正在读取…"), 13, MoteUi.muted)
        button(MoteI18n.text("授权通知、媒体与设备事件")) { mediaPermission() }
        button(MoteI18n.text("重新授权投屏（已开启的媒体可继续）")) {
            val c = loadedConfig
            if (!c.screenCollectionEnabled || c.effectiveMode() != "projection") toast(MoteI18n.text("请先启用屏幕采集并保存投屏模式"))
            else if (ProjectionService.running) toast(MoteI18n.text("投屏会话正在运行"))
            else if (!settings.enabled) startCapture()
            else requestProjectionConsent()
        }
        help(MoteI18n.text("播放时间如何计算"), MoteI18n.text("约每30秒及状态变化时记录。系统休眠、终止服务或播放器未公开媒体会话时可能缺失；仅统计连续观测的播放时段。"))
        section(MoteI18n.text("采样与空间"))
        interval = presetNumber(MoteI18n.text("采集间隔 / 秒"), config.intervalSeconds, "30", 5..300, listOf(5, 15, 30, 60, 120, 300))
        projectionMode = check(MoteI18n.text("使用投屏模式（备用，每次需授权）"), config.mode == "projection")
        help(MoteI18n.text("截图模式说明"), MoteI18n.text("默认无障碍截图模式适用 Android 11+：系统重新连接服务时可恢复你已启用的采集。投屏模式锁屏/被杀后必须重新授权。Android 10 请选投屏模式。"))
        section(MoteI18n.text("电量策略"))
        chargingOnly = check(MoteI18n.text("仅充电时采集屏幕、活动和媒体"), config.chargingOnly)
        batteryBelow = presetNumber(MoteI18n.text("低于此电量暂停 / % · 0 为关闭"), config.batteryPauseBelowPct, "0", 0..95, listOf(0, 10, 15, 20, 30, 50))
        section(MoteI18n.text("更多采集设置"))
        menu(MoteI18n.text("图像与文字识别"), MoteI18n.text("清晰度、图片去重与 OCR"), "capture") { showPage(Page.PROCESSING) }
        menu(MoteI18n.text("本机存储"), MoteI18n.text("上传后保留时间、空间上限与保存位置"), "folder") { showPage(Page.STORAGE) }
    }
    private fun buildStorage(config: CollectorConfig) {
        page(Page.STORAGE, MoteI18n.text("保留你需要回看的本机副本"))
        menu(MoteI18n.text("图片保存位置"), MoteI18n.text("选择应用存储空间并迁移已有记录"), "folder") { startActivity(Intent(this, StorageActivity::class.java)) }
        uploadedRetention = presetNumber(MoteI18n.text("上传后本机保留 / 天（0 为立即清理）"), config.uploadedRetentionDays, "7", 0..365, listOf(0, 1, 7, 14, 30, 90, 365))
        maxQueue = presetNumber(MoteI18n.text("本机存储上限 / MiB"), config.maxQueueMiB, "256", 8..4096, listOf(64, 128, 256, 512, 1024, 2048, 4096))
        text(MoteI18n.text("完成上传与 OCR 后开始计时，到期自动清理本机副本；中央归档继续保留。未上传和冲突记录不会自动删除。"), 13, MoteUi.muted)
        menu(MoteI18n.text("导入与导出"), MoteI18n.text("备份配置与本机记录"), "folder") { startActivity(Intent(this, BackupActivity::class.java)) }
    }
    private fun buildProcessing(config: CollectorConfig) {
        page(Page.PROCESSING, MoteI18n.text("图像质量与 OCR"))
        section(MoteI18n.text("图像质量"))
        jpegQuality = presetNumber(MoteI18n.text("图像质量 · 数值越高清晰度越高"), config.jpegQuality, "75", 40..95, listOf(50, 65, 75, 85, 95))
        captureMaxSide = presetNumber(MoteI18n.text("图片最长边 / px"), config.captureMaxSide, "1280", 640..2560, listOf(640, 960, 1280, 1920, 2560))
        text(MoteI18n.text("图片去重"), 15)
        imageDedupeMode = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("关闭"), MoteI18n.text("精确"), MoteI18n.text("保守"), MoteI18n.text("均衡"), MoteI18n.text("激进")))
            setSelection(imageDedupeModes.indexOf(config.imageDedupeMode).coerceAtLeast(0))
        }
        content.addView(imageDedupeMode, LinearLayout.LayoutParams(-1, dp(56))); track(imageDedupeMode, "imageDedupeMode")
        help(MoteI18n.text("图片去重说明"), MoteI18n.text("与同一应用最近保存的画面比较。重处理前命中时仅记录应用活动，不保存或审查当前图片，也不沿用旧文字。开启图片对比诊断时保留审查后的对比链路。近似档位可能忽略细小变化；重启后重新建立基准。"))
        text(MoteI18n.text("OCR 识别方式"), 15)
        ocrMode = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("中文与拉丁文（单引擎）"), MoteI18n.text("仅拉丁文"), MoteI18n.text("双引擎（高质量）")))
            setSelection(OcrPolicy.modes.indexOf(config.ocrMode).coerceAtLeast(0))
        }
        content.addView(ocrMode); track(ocrMode, "ocrMode")
        ocrAppModes = field(MoteI18n.text("按应用指定 OCR（JSON）"), config.ocrAppModes, "{}")
        text(MoteI18n.text("可填写包名到 chinese、latin 或 dual 的映射；未指定的应用使用上方模式。"), 13, MoteUi.muted)
        ocrChargingOnly = check(MoteI18n.text("中央负责 OCR；旧版本地补识别策略已停用"), false).apply { isEnabled = false }
        text(MoteI18n.text("新截图由中央识别。充电限制仅用于升级前已经排队的本机 OCR。"), 13, MoteUi.muted)
    }

    private fun buildDiagnostics(config: CollectorConfig) {
        page(Page.DIAGNOSTICS, MoteI18n.text("按需开启诊断，帮助定位采集和同步问题"))
        technicalStatus = text(MoteI18n.text("正在读取运行状态…"), 13)
        diagnosticEnabled = check(MoteI18n.text("记录数值与事件诊断"), config.diagnosticsEnabled)
        diagnosticInterval = field(MoteI18n.text("诊断采样间隔 / 秒（15–3600）"), config.diagnosticsIntervalSeconds.toString(), "60", InputType.TYPE_CLASS_NUMBER)
        help(MoteI18n.text("数值诊断说明"), MoteI18n.text("仅在应用/采集运行时采样，最多 1440 条。记录整机电量、队列/模型空间、入队/拦截/失败计数、推理/OCR 耗时和上传字节，不包含截图、文字、笔记、令牌或审查理由。电量变化是整机变化，不能归因于 Mote。"))
        button(MoteI18n.text("导出数值诊断 JSON")) {
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "mote-diagnostics.json"), 103)
        }
        button(MoteI18n.text("打开本地日志查看器")) { startActivity(Intent(this, LogViewerActivity::class.java)) }
        button(MoteI18n.text("导出时间范围")) { MoteDialogBuilder(this).setTitle(MoteI18n.text("导出时间范围")).setSingleChoiceItems(arrayOf(MoteI18n.text("最近 1 小时"), MoteI18n.text("最近 24 小时"), MoteI18n.text("最近 7 天")), listOf(1,24,168).indexOf(logExportHours)) { dialog, which -> logExportHours = listOf(1,24,168)[which]; dialog.dismiss() }.show() }
        help(MoteI18n.text("支持包包含什么"), MoteI18n.text("事件日志最多 500 条，只记录固定阶段、错误类别与数值。支持包不包含节点地址、设备名、截图、笔记、OCR、令牌、提示词或审查理由；关闭诊断后停止新增，已有记录保留。"))
        button(MoteI18n.text("导出安全支持包 JSON")) {
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "mote-${BuildConfig.MOTE_PROFILE}-support.json"), 104)
        }
    }

    private fun buildNotes() {
        page(Page.NOTES, MoteI18n.text("为此刻，留下一句话"))
        menu(MoteI18n.text("图片与语音附件"), MoteI18n.text("在中央随手记中添加附件"), "note") { startActivity(Intent(this, CentralActivity::class.java).putExtra("page", "notes")) }
        val app = applicationContext
        val io = QuickNotes.io
        val task = UiTask(this, io, ownsExecutor = false)
        val note = field(MoteI18n.text("正在想什么"), "", MoteI18n.text("记下此刻的想法…"), multiline = true)
        note.minLines = 7; note.gravity = Gravity.TOP
        val mood = EditText(this) // Read compatibility for old drafts; no mood field in the UI.
        note.filters = arrayOf(android.text.InputFilter.LengthFilter(100000)); mood.filters = arrayOf(android.text.InputFilter.LengthFilter(80))
        val progress = text(MoteI18n.text("正在读取草稿…"), 13, MoteUi.muted)
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
                    progress.text = MoteI18n.text("正在保存草稿…")
                }
            }
        }
        note.addTextChangedListener(draftWatcher); mood.addTextChangedListener(draftWatcher)
        // Persistence is independent of this Activity; only the lightweight observer stops on pause.
        val draftPoll = object : Runnable {
            override fun run() {
                if (isDestroyed) return
                if (resumed && !task.busy) persisted.get()?.takeIf { it.first == editRevision }?.let {
                    progress.text = if (it.second) MoteI18n.text("草稿已保存") else MoteI18n.text("草稿保存失败，请保持页面打开并检查可用空间")
                }
                handler.postDelayed(this, 500)
            }
        }
        notePoll = draftPoll; if (resumed) handler.post(draftPoll)
        editable(false)
        task.start(MoteI18n.text("正在读取草稿…"), { progress.text = it }, { QuickNotes.draft(app).read() }) { result ->
            result.onSuccess { replace(it); readable = true; editable(true); progress.text = MoteI18n.text("草稿已载入") }
                .onFailure { progress.text = MoteI18n.text("草稿读取失败，原文件保留。明确点击新建才清除旧草稿。") }
        }
        button(MoteI18n.text("保存随手记"), true) {
            if (!task.busy && readable) {
                val value = note.text.toString() to mood.text.toString()
                editable(false)
                task.start(MoteI18n.text("正在保存随手记…"), { progress.text = it }, { QuickNotes.save(app, value.first, value.second) }) { result ->
                    editable(true); persisted.set(null)
                    result.onSuccess { replace(NoteDraft()); persisted.set(null); progress.text = MoteI18n.text("随手记已保存；同步按你的设置运行"); refreshStatus() }
                        .onFailure { progress.text = it.message ?: MoteI18n.text("随手记保存失败，草稿已保留") }
                }
            }
        }
        button(MoteI18n.text("新建一条 · 清除草稿")) {
            if (!task.busy) MoteDialogBuilder(this).setTitle(MoteI18n.text("清除当前草稿？")).setMessage(MoteI18n.text("此操作仅清除正在编辑的本机草稿。已保存的随手记不受影响。"))
                .setNegativeButton(MoteI18n.text("继续编辑"), null).setPositiveButton(MoteI18n.text("清除并新建")) { _, _ ->
                    if (!task.busy) {
                        editable(false)
                        task.start(MoteI18n.text("正在清除草稿…"), { progress.text = it }, { QuickNotes.draft(app).clear() }) { result ->
                            result.onSuccess { replace(NoteDraft()); persisted.set(null); readable = true; progress.text = MoteI18n.text("可以开始新随手记") }
                                .onFailure { progress.text = MoteI18n.text("草稿清除失败") }
                            editable(readable)
                        }
                    }
                }.show()
        }
        text(MoteI18n.text("草稿自动保存在本机，保存后按同步设置上传。正文最多 100000 字符，心情最多 80 字符。"), 13, MoteUi.muted)
    }

    private fun buildPrivacy(config: CollectorConfig) {
        page(Page.PRIVACY, MoteI18n.text("由你决定，哪些内容可以留下"))
        section(MoteI18n.text("选择要记录的应用"))
        text(MoteI18n.text("完整内容：保存经过隐私过滤的截图。仅应用活动：记录应用与时长。不记录：跳过该应用。"), 13, MoteUi.muted)
        val appRules = AppCollectionRules.parse(config.appCollectionRules)
        appDefault = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("默认：记录截图与内容"), MoteI18n.text("默认：只记应用和时长"), MoteI18n.text("默认：不记录（仅记录单独开启的应用）")))
            setSelection(AppCollectionMode.entries.indexOf(appRules.defaultMode))
        }; content.addView(appDefault, LinearLayout.LayoutParams(-1, dp(56))); track(appDefault, "appDefault")
        appRuleRows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; content.addView(appRuleRows)
        text(MoteI18n.text("默认方式适用于没有单独设置的应用，也适用于以后安装的应用。下方显示单独设置；修改后点击保存生效。"), 13, MoteUi.muted)
        button(MoteI18n.text("管理应用 · 查看每个应用的记录方式")) { chooseInstalledApp() }
        val regular = content
        val rawRules = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        button(MoteI18n.text("高级：手工编辑包名规则")) { rawRules.visibility = if (rawRules.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        regular.addView(rawRules); content = rawRules
        excludes = field(MoteI18n.text("不采集的应用包名（每行一个或逗号分隔）"), config.excludedPackages, "com.example.private", multiline = true)
        appPolicies = field(MoteI18n.text("应用级别（每行 包名=content/activity/off）"), appRules.apps.entries.joinToString("\n") { "${it.key}=${it.value.wire}" }, "com.example.chat=activity\ncom.example.private=off", multiline = true)
        appPolicies.filters = arrayOf(android.text.InputFilter.LengthFilter(32768))
        content = regular
        val rulesWatcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { renderAppRules() }
        }
        appPolicies.addTextChangedListener(rulesWatcher); excludes.addTextChangedListener(rulesWatcher); renderAppRules()
        metadataEnabled = check(MoteI18n.text("上传设备与采集状态元数据"), config.metadataEnabled)
        text(MoteI18n.text("开启后附带实际系统/机型、采集器版本、语言/时区、电量/充电、网络类型、锁屏与可用空间；不取设备序列号、IMEI、MAC、SSID或定位。关闭只影响新记录和心跳，已入队内容不追溯修改。授权文件来源自身的大小/修改时间不受此开关影响。"), 13)
        text(MoteI18n.text("没有内置应用黑名单。配置排除后，无法识别应用、多个应用窗口或系统遮挡时暂停。投屏模式需要同时启用无障碍服务才能可靠执行排除；仅使用情况权限不足以保证所有可见窗口。"), 13)
        section(MoteI18n.text("页面内容采集"))
        text(MoteI18n.text("仅在明确配置的应用和页面读取可见文字。需要辅助功能权限；输入框、密码与遮挡区域会被过滤。默认关闭。"),13,MoteUi.muted)
        uiPageMode=Spinner(this).apply {
            adapter=ArrayAdapter(this@MainActivity,android.R.layout.simple_spinner_dropdown_item,listOf(MoteI18n.text("仅截图（默认）"),MoteI18n.text("页面与截图"),MoteI18n.text("页面优先，完整时不截图"),MoteI18n.text("仅页面，不回退截图")))
            setSelection(UiPageRules.modes.indexOf(config.uiPageMode).coerceAtLeast(0))
        }; content.addView(uiPageMode)
        uiPageRules=field(MoteI18n.text("页面规则 JSON"),config.uiPageRules,"[]",multiline=true)
        button(MoteI18n.text("载入实验规则")){uiPageRules.setText(assets.open("ui-page-rules.json").bufferedReader().use { it.readText() })}
        text(MoteI18n.text("实验规则仅通过合成样本测试，可能包含导航文字。可编辑规则以限定页面和节点；保存后生效。"),13,MoteUi.muted)
        section(MoteI18n.text("固定遮罩"))
        text(MoteI18n.text("拖动示意图添加矩形；绿色区域会在 OCR 和保存前被遮住。这里不会读取你的屏幕。"), 13, MoteUi.muted)
        val maskFields = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        val mainContent = content; content.addView(maskFields); content = maskFields
        masks = field(MoteI18n.text("固定遮罩（每行 left,top,right,bottom）"), config.masks, "0,0,1,0.08", multiline = true)
        content = mainContent
        maskEditor = MaskEditorView(this) { values -> masks.setText(values.joinToString("\n") { "${it.left},${it.top},${it.right},${it.bottom}" }) }
        maskEditor.setMasks(Mask.parse(config.masks)); content.addView(maskEditor, LinearLayout.LayoutParams(-1, dp(260)).apply { bottomMargin = dp(12) })
        masks.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { runCatching { maskEditor.setMasks(Mask.parse(s.toString())) } }
        })
        rowButtons(MoteI18n.text("遮住顶部 8%"), { maskEditor.add(Mask(0f, 0f, 1f, .08f)) }, MoteI18n.text("遮住底部 12%"), { maskEditor.add(Mask(0f, .88f, 1f, 1f)) })
        rowButtons(MoteI18n.text("调整所选区域"), { editSelectedMask() }, MoteI18n.text("移除所选区域"), { maskEditor.removeSelected() })
        button(MoteI18n.text("高级：编辑精确坐标")) { maskFields.visibility = if (maskFields.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        section(MoteI18n.text("上传审查与过滤"))
        gateEnabled = check(MoteI18n.text("启用文字规则审查"), config.uploadGate.enabled)
        gateText = field(MoteI18n.text("禁止上传的文字（每行一个，精确包含匹配）"), config.uploadGate.blockedText, "", multiline = true)
        gateFailure = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("暂存待复核（默认）"), MoteI18n.text("不保存、不上传"), MoteI18n.text("允许上传")))
            setSelection(listOf("hold", "drop", "allow").indexOf(config.uploadGate.failureAction).coerceAtLeast(0))
        }
        content.addView(gateFailure); track(gateFailure, "gateFailure")
        text(MoteI18n.text("审查 OCR 仅在规则需要时运行，文字不会保存或上传。应用范围与固定遮罩仍然生效。VLM 接口保留，本版本暂停；中央负责完整 OCR 和理解。待复核记录请在同步恢复中逐条处理。"), 13)
        nsfwEnabled = CheckBox(this).apply { isChecked = false }
        nsfwStatus = TextView(this)

    }

    private fun buildModel(config: CollectorConfig) {
        page(Page.MODEL, MoteI18n.text("修改前先停止采集；参数影响本机过滤行为"))
        nsfwPolicy = field(MoteI18n.text("本机图片审查指令"), config.nsfw.policy, "", multiline = true)
        nsfwMaxTokens = field(MoteI18n.text("输出上限 token（32–1024）"), config.nsfw.maxTokens.toString(), "256", InputType.TYPE_CLASS_NUMBER)
        nsfwMaxSide = field(MoteI18n.text("审查图最长边（256–1024）"), config.nsfw.reviewMaxSide.toString(), "512", InputType.TYPE_CLASS_NUMBER)
        nsfwThreads = field(MoteI18n.text("CPU 线程（1–8）"), config.nsfw.threads.toString(), "2", InputType.TYPE_CLASS_NUMBER)
        nsfwTimeout = field(MoteI18n.text("推理超时 / 毫秒（5000–180000，含首次加载）"), config.nsfw.timeoutMs.toString(), "60000", InputType.TYPE_CLASS_NUMBER)
        text(MoteI18n.text("模型下载来源"), 13)
        nsfwSource = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("自动：ModelScope → Hugging Face"), MoteI18n.text("国内 ModelScope"), MoteI18n.text("官方 Hugging Face"), MoteI18n.text("自定义 HTTPS 目录")))
            setSelection(nsfwSources.indexOf(config.nsfw.source).coerceAtLeast(0))
            layoutParams = LinearLayout.LayoutParams(-1, dp(48)); content.addView(this)
        }
        track(nsfwSource, "nsfwSource")
        nsfwCustom = field(MoteI18n.text("自定义 HTTPS 目录（model.gguf / mmproj.gguf）"), config.nsfw.customUrl, "https://your-nas.example/models/qwen", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        help(MoteI18n.text("模型下载说明"), MoteI18n.text("双模型共约 703 MiB。自动先尝试国内 ModelScope，失败回退 Hugging Face；支持断点续传，取消后保留断点。可在自定义目录托管两个固定文件，或分两次导入本地 GGUF；每次加载前核对完整 SHA-256。下载速度取决于网络。"))
        button(MoteI18n.text("重载推理进程")) {
            uiTask.start(MoteI18n.text("正在重载推理进程…"), { nsfwStatus.text = it }, {
                NsfwClient.resetAll(); NsfwModelStore(applicationContext).inferenceStatus(MoteI18n.text("已重置推理进程，下一帧重新校验并加载"))
            }) { result -> result.onFailure { toast(MoteI18n.text("重载失败，请重试")) }; refreshStatus() }
        }
        review = field(MoteI18n.text("可选本机隐私模型 URL"), config.localReviewUrl, "http://127.0.0.1:47833/review", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        text(MoteI18n.text("这是 NSFW 检查后的额外通用隐私审查。仅允许手机本机 loopback；模型拒绝、超时或格式错误时丢弃此帧。模型新增遮罩后重新 OCR。未填写则不调用此额外 HTTP 钩子。"), 13)
    }

    private fun buildDeveloper(config: CollectorConfig) {
        page(Page.DEVELOPER, MoteI18n.text("用于排查问题和调整本机高级行为"))
        menu(MoteI18n.text("诊断与支持"), MoteI18n.text("运行状态、数值采样与安全支持包"), "chart") { showPage(Page.DIAGNOSTICS) }
        menu(MoteI18n.text("图片压缩预览"), MoteI18n.text("质量、文件大小、缩放比例与放大对比"), "chart") {
            @Suppress("DEPRECATION") startActivityForResult(Intent(this, CompressionPreviewActivity::class.java), 105)
        }
        section(MoteI18n.text("图片去重排查"))
        imageDedupeDiagnosticsEnabled = check(MoteI18n.text("临时保留图片去重对比记录"), config.imageDedupeDiagnosticsEnabled)
        help(MoteI18n.text("图片对比诊断说明"), MoteI18n.text("默认关闭。开启并保存后，将已去重图片及对比原图临时保存在本机，供核对分数与判断依据。最多 20 组、32 MiB，24 小时后到期；读取时清理，系统可能延后后台清理。关闭并保存后清空。保留的都是通过隐私检查和遮罩后的图片。"))
        menu(MoteI18n.text("本机图片批量去重"), MoteI18n.text("全量扫描、对比预览、移入待决定区或删除"), "chart") { startActivity(Intent(this, BulkDedupeActivity::class.java)) }
        menu(MoteI18n.text("查看图片去重记录"), MoteI18n.text("对比两张图片、分数与依据，可随时清空"), "chart") { startActivity(Intent(this, ImageDedupeDiagnosticsActivity::class.java)) }
        menu(MoteI18n.text("模型高级设置"), MoteI18n.text("审查指令、下载来源与推理参数"), "settings") { showPage(Page.MODEL) }
        section(MoteI18n.text("调试连接"))
        http = check(MoteI18n.text("允许调试局域网 HTTP（明文，仅私有 IP）"), config.debugHttp).apply { isEnabled = BuildConfig.DEBUG }
        section(MoteI18n.text("构建与运行环境"))
        text(MoteI18n.text("环境：{0} · {1}\n私有数据目录：{2}", BuildConfig.MOTE_PROFILE, packageName, noBackupFilesDir.absolutePath), 12, MoteUi.muted)
        if (BuildConfig.MOTE_PROFILE == "dev") text(MoteI18n.text("开发版与日常 Mote 独立安装，权限、设备 ID、令牌、草稿、队列和模型互不共享。默认测试端口 47842；模拟器使用 adb reverse tcp:47842 tcp:47842。"), 13, MoteUi.muted)
    }

    private fun buildAbout() {
        page(Page.ABOUT, MoteI18n.text("Mote · 让经历留有线索"))
        card(MoteUi.tint) {
            text("Mote", 30)
            text(MoteI18n.text("你的个人上下文档案"), 15)
            text(MoteI18n.text("版本 {0}", BuildConfig.VERSION_NAME), 13, MoteUi.muted)
        }
        menu(MoteI18n.text("应用更新"), MoteI18n.text("检查新版本与安装更新"), "sync") { startActivity(Intent(this, AppUpdatesActivity::class.java)) }
        menu(MoteI18n.text("开发者选项"), MoteI18n.text("诊断、模型高级参数与构建信息"), "settings") { showPage(Page.DEVELOPER) }
        text("Android ${Build.VERSION.RELEASE} / API ${Build.VERSION.SDK_INT} · ${Build.MANUFACTURER} ${Build.MODEL}", 12, MoteUi.muted)
    }

    private fun buildPermissions() {
        page(Page.PERMISSIONS, MoteI18n.text("按需授权，让记录稳定运行"))
        section(MoteI18n.text("当前状态"))
        permissionsSummary = text(MoteI18n.text("正在检查系统权限…"), 14, MoteUi.muted)
        for (name in listOf("无障碍截图", "通知使用权", "投屏会话", "通知", "使用情况", "电池优化", "自启动")) {
            permissionBadges[name] = text(MoteI18n.text(name), 17).apply { setPadding(dp(12), dp(12), dp(12), dp(12)); setTypeface(null, android.graphics.Typeface.BOLD) }
        }
        accessibilityButton = button(MoteI18n.text("启用无障碍截图服务")) {
            MoteDialogBuilder(this).setTitle(MoteI18n.text("屏幕采集权限说明"))
                .setMessage(getString(R.string.accessibility_description) + MoteI18n.text("\n\n继续后请在系统设置中选择 Mote 屏幕采集。启用服务本身不会开始截图，仍需回到此处点击开始。"))
                .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("打开系统设置")) { _, _ -> safeOpen(Intent(SystemSettings.ACTION_ACCESSIBILITY_SETTINGS)) }.show()
        }
        button(MoteI18n.text("授权通知与媒体（通知使用权）")) { mediaPermission() }
        help(MoteI18n.text("HyperOS 通知设置帮助"), MoteI18n.text("HyperOS 通知使用权：请按需打开实时、对话、通知、静音类别。旧版曾禁用这些类别；更新后若仍是灰色，可关闭再重新授予通知使用权。类别和应用级开关会影响可接收的事件。"))
        notificationButton = button(MoteI18n.text("通知权限")) { notifications() }
        usageButton = button(MoteI18n.text("使用情况权限")) { safeOpen(Intent(SystemSettings.ACTION_USAGE_ACCESS_SETTINGS)) }
        batteryButton = button(MoteI18n.text("电池优化设置")) { safeOpen(Intent(SystemSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        button(MoteI18n.text("自启动设置 · 需在系统确认")) { autostart() }
        button(MoteI18n.text("应用详情 / 受限制设置")) { safeOpen(detailsIntent()) }
        help(MoteI18n.text("HyperOS 后台设置帮助"), MoteI18n.text("小米 / HyperOS：在系统应用设置中允许 Mote 自启动，将省电策略设为无限制，并允许通知；可在最近任务中锁定应用。菜单随系统版本变化。若侧载 APK 的无障碍开关受限，请在应用详情的菜单中检查“允许受限制的设置”。这些设置不能保证系统永不终止采集。"))
    }

    private fun updatePermissionSummary() {
        if (!::permissionsSummary.isInitialized) return
        val accessibility = runCatching { SystemSettings.Secure.getString(contentResolver, SystemSettings.Secure.ENABLED_ACCESSIBILITY_SERVICES)?.split(':')?.any { ComponentName.unflattenFromString(it) == ComponentName(this, CaptureAccessibilityService::class.java) } == true }.getOrDefault(false)
        val notifications = getSystemService(NotificationManager::class.java).areNotificationsEnabled()
        val usage = ForegroundApps.usageAllowed(this)
        val power = runCatching { getSystemService(android.os.PowerManager::class.java).isIgnoringBatteryOptimizations(packageName) }.getOrDefault(false)
        val checks = mapOf("无障碍截图" to accessibility, "通知使用权" to MediaCollection.permissionAllowed(this), "投屏会话" to ProjectionService.running, "通知" to notifications, "使用情况" to usage, "电池优化" to power)
        for ((name, badge) in permissionBadges) {
            val allowed = checks[name]
            badge.text = (if (allowed == true) "✓ " else if (allowed == false) "! " else "? ") + MoteI18n.text(name) + " · " + when {
                allowed == null -> MoteI18n.text("需在系统确认")
                name == "投屏会话" -> if (allowed) MoteI18n.text("本次会话正在运行") else MoteI18n.text("未运行 · 开始时需系统授权")
                name == "电池优化" -> if (allowed) MoteI18n.text("已豁免") else MoteI18n.text("未豁免")
                else -> if (allowed) MoteI18n.text("已授权") else MoteI18n.text("未授权")
            }
            badge.setTextColor(android.graphics.Color.parseColor(if (allowed == true) "#15613A" else if (allowed == false) "#9C341D" else "#665419"))
            badge.setBackgroundColor(android.graphics.Color.parseColor(if (allowed == true) "#E7F7EC" else if (allowed == false) "#FFF0E9" else "#FFF8D9"))
        }
        accessibilityButton.text = if (accessibility) MoteI18n.text("无障碍截图已授权 · 管理") else MoteI18n.text("无障碍截图未授权 · 去授权")
        notificationButton.text = if (notifications) MoteI18n.text("通知已允许 · 管理") else MoteI18n.text("通知未允许 · 去授权")
        usageButton.text = if (usage) MoteI18n.text("使用情况已授权 · 管理") else MoteI18n.text("使用情况未授权 · 去授权")
        batteryButton.text = if (power) MoteI18n.text("电池优化已豁免 · 管理") else MoteI18n.text("电池优化未豁免 · 设置")
        permissionsSummary.text = MoteI18n.text("无障碍截图：{0}\n媒体通知使用权：{1}\n投屏：{2}\n通知：{3}\n使用情况：{4}\n电池优化：{5}\n自启动：系统未提供可靠查询，请在系统设置确认。", if (accessibility) if (CaptureAccessibilityService.connected) MoteI18n.text("已授权 · 服务已连接") else MoteI18n.text("已授权 · 等待系统连接服务") else MoteI18n.text("未授权"), if (MediaCollection.permissionAllowed(this)) MoteI18n.text("已授权") else MoteI18n.text("未授权"), if (ProjectionService.running) MoteI18n.text("本次会话正在运行") else MoteI18n.text("未运行 · 开始时需系统授权"), if (notifications) MoteI18n.text("已允许") else MoteI18n.text("未允许"), if (usage) MoteI18n.text("已授权") else MoteI18n.text("未授权"), if (power) MoteI18n.text("已豁免") else MoteI18n.text("系统可能限制后台运行"))
    }

    private fun retrySync() {
        val app = applicationContext
        uiTask.start(MoteI18n.text("正在提交同步任务…"), { syncStatus.text = it }, {
            ConnectionGuard.sync {
                val c = Settings(app).read()
                if (!c.hasSyncConnection()) false else {
                    c.validateConnection()
                    if (app.localSources().sources().any { it.enabled }) SourceWork.schedule(app, true, syncExplicit = true)
                    else UploadWorker.schedule(app, c, true)
                    true
                }
            } ?: error(MoteI18n.text("正在应用设置，请稍后重试"))
        }) { result ->
            result.onSuccess { connected ->
                if (!connected) { showPage(Page.CONNECTION); toast(MoteI18n.text("记录已保存在本机；连接节点后才可以同步")) }
                else toast(MoteI18n.text("已请求同步；仍遵守网络约束"))
            }.onFailure { toast(it.message ?: MoteI18n.text("配置无效")) }
        }
    }

    /** A settings page can only change its own fields in the latest saved snapshot. */
    private fun draft(current: CollectorConfig = loadedConfig): CollectorConfig = when (currentPage) {
        Page.CONNECTION -> current.copy(
            server = checked(server) { server.text.toString().trim().let { if (it.isBlank()) "" else PrivacyRules.validateEndpoint(it, current.debugHttp, BuildConfig.DEBUG) } },
            token = checked(token) { token.text.toString().trim().also { require(it.isBlank() || it.length >= 32) { MoteI18n.text("令牌至少需要 32 个字符；未连接时可留空") } } },
            deviceName = checked(name) { name.text.toString().trim().also { require(it.isNotBlank() && it.length <= 128) { MoteI18n.text("请填写 1..128 字符的设备名称") } } },
            wifiOnly = wifi.isChecked, syncMode = syncModes[syncMode.selectedItemPosition], syncIntervalMinutes = number(syncInterval, 1..1440),
            packedUpload = packedUpload.isChecked, syncBatchSize = number(syncBatch, 1..500), jsonlWindowMinutes = number(jsonlWindow, 1..1440), syncChargingOnly = syncChargingOnly.isChecked, syncBatteryNotLow = syncBatteryNotLow.isChecked)
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
            uiPageMode=UiPageRules.modes[uiPageMode.selectedItemPosition], uiPageRules=checked(uiPageRules){uiPageRules.text.toString().also{UiPageRules.parse(it)}},
            excludedPackages = excludes.text.toString(), masks = checked(masks) { masks.text.toString().also { Mask.parse(it) } },
            appCollectionRules = checked(appPolicies) { AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString()).json() },
            metadataEnabled = metadataEnabled.isChecked, uploadGate = UploadGateConfig(gateEnabled.isChecked, gateText.text.toString(), listOf("hold", "drop", "allow")[gateFailure.selectedItemPosition]), nsfw = current.nsfw.copy(enabled = false))
        Page.MODEL -> current.copy(nsfw = nsfwDraft().copy(enabled = current.nsfw.enabled),
            localReviewUrl = checked(review) { review.text.toString().trim().also { PrivacyRules.validateLocalReview(it) } })
        Page.DIAGNOSTICS -> current.copy(diagnosticsEnabled = diagnosticEnabled.isChecked, diagnosticsIntervalSeconds = number(diagnosticInterval, 15..3600))
        Page.DEVELOPER -> current.copy(debugHttp = http.isChecked, imageDedupeDiagnosticsEnabled = imageDedupeDiagnosticsEnabled.isChecked,
            contentEncryptionEnabled = false)
        else -> current
    }
    private fun nsfwDraft(): NsfwConfig {
        val value = NsfwConfig(enabled = nsfwEnabled.isChecked, threads = number(nsfwThreads, 1..8),
            timeoutMs = number(nsfwTimeout, 5000..180000).toLong(), source = nsfwSources[nsfwSource.selectedItemPosition],
            customUrl = checked(nsfwCustom) { nsfwCustom.text.toString().trim().also { if (nsfwSource.selectedItemPosition == 3) {
                require(NsfwConfig.validateModelUrl(it).rawQuery == null) { MoteI18n.text("自定义来源应为不带查询参数的 HTTPS 目录") }
            } } },
            policy = checked(nsfwPolicy) { nsfwPolicy.text.toString().trim().also { require(it.isNotBlank() && it.length <= 4000) { MoteI18n.text("审查指令须为 1..4000 字符") } } },
            maxTokens = number(nsfwMaxTokens, 32..1024), reviewMaxSide = number(nsfwMaxSide, 256..1024))
        return value.also { it.validate() }
    }
    private fun number(field: EditText, range: IntRange): Int = checked(field) {
        val value = field.text.toString().trim().toIntOrNull()
        require(value != null && value in range) { MoteI18n.text("请输入 {0}–{1} 之间的整数", range.first, range.last) }
        value
    }
    private fun <T> checked(field: EditText, read: () -> T): T = try {
        read().also { field.error = null }
    } catch (error: Exception) {
        val message = if (error is java.net.URISyntaxException || error is NumberFormatException) MoteI18n.text("请检查此项的输入格式") else error.message ?: MoteI18n.text("请检查此项设置")
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
    } catch (error: Exception) { toast(error.message ?: MoteI18n.text("请检查 NSFW 配置")) }
    private fun saveConfig(bindLocal: Boolean = false, after: () -> Unit = {}): Unit {
        if (applyingSettings || uiTask.busy) return
        val current = loadedConfig
        val c = runCatching { draft(current).also { it.validate() } }.getOrElse { toast(it.message ?: MoteI18n.text("请检查配置输入")); return }
        val savedFields = pageControlValues().keys
        val submitted = baseline + controlValues().filterKeys { it in savedFields }; val generation = draftGeneration
        if (c.server == current.server && c.token == current.token) {
            applySettings(c, bindLocal, expected = current, appliedFields = savedFields, submitted = submitted, generation = generation, saved = after)
            return
        }
        pendingSubmission = submitted; applyingSettings = true; updateSaveBar()
        val app = applicationContext
        // The accepted save must survive rotation while preflight is waiting on storage.
        // This handler only continues the operation; UiTask still owns all progress polling.
        val completion = Handler(Looper.getMainLooper())
        uiTask.start(MoteI18n.text("正在检查本机待同步资料…"), { saveHint.text = it }, {
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
                    if (needsBinding) MoteDialogBuilder(this).setTitle(MoteI18n.text("将本机资料绑定到此节点？"))
                        .setMessage(MoteI18n.text("{0}\n\n本机已有尚未绑定的截图、笔记或来源资料。确认后会绑定到这个档案地址，并按你的同步策略发送。请核对这是你自己的节点。", c.server))
                        .setNegativeButton(MoteI18n.text("继续保存在本机"), null).setPositiveButton(MoteI18n.text("确认绑定并保存")) { _, _ -> applySettings(c, true, expected = current, appliedFields = savedFields, submitted = submitted, generation = generation, saved = after) }.show()
                    else applySettings(c, bindLocal, expected = current, appliedFields = savedFields, submitted = submitted, generation = generation, saved = after)
                }.onFailure { toast(it.message ?: MoteI18n.text("无法检查设置，请重试")); refreshStatus() }
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
        pendingSubmission = submitted; applyingSettings = true; updateSaveBar()
        RuntimeSettings.apply(this, config, bindLocal, expected = expected) { result ->
            applyingSettings = false
            if (isDestroyed) return@apply
            result.onSuccess {
                // Keep edits made after this save started, including edits on a newly opened page.
                val comparison = if (generation == draftGeneration) submitted else baseline
                val laterEdits = pageControlValues().filter { (key, value) -> comparison[key] != value }
                reloadSettings(RuntimeSettings.currentConfiguration ?: loadedConfig); restoreControlValues(laterEdits)
                saved(); toast(MoteI18n.text("设置已保存")); resumeProjectionAfterSettings()
            }.onFailure {
                RuntimeSettings.currentConfiguration?.let { if (it != loadedConfig) reloadSettings(it) }
                toast(it.message ?: MoteI18n.text("设置未保存，请重试"))
            }
            updateSaveBar(); refreshStatus()
        }
    }
    private fun startCapture() {
        if (ConnectionGuard.changing() || RuntimeSettings.stopping) { toast(MoteI18n.text("正在连接节点，请稍后再开始采集")); return }
        if (settings.enabled) { toast(MoteI18n.text("已启用，状态见上方")); return }
        val next = runCatching { draft().also { it.validate() } }.getOrElse { toast(it.message ?: MoteI18n.text("请检查设置")); return }
        if (next == loadedConfig) startConfiguredCapture() else saveConfig(after = { startConfiguredCapture() })
    }
    private fun startConfiguredCapture() {
        if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) { notifications(); toast(MoteI18n.text("请先允许通知，然后再次点击开始")); return }
        val c = loadedConfig
        if (!c.screenCollectionEnabled) {
            if (!c.observesSystem()) { showPage(Page.CAPTURE); toast(MoteI18n.text("请至少启用一种采集来源")); return }
            if (!MediaCollection.permissionAllowed(this)) { mediaPermission(); return }
            enableCapture(c, MoteI18n.text("通知、设备事件或媒体采集已启用；等待系统事件")) {
                MediaCollectionService.refresh()
                if (!MediaCollectionService.connected) android.service.notification.NotificationListenerService.requestRebind(ComponentName(this, MediaCollectionService::class.java))
            }
            return
        }
        if (c.effectiveMode() == "accessibility") {
            if (Build.VERSION.SDK_INT < 30 && AppCollectionRules.parse(c.appCollectionRules).mayCollectContent()) { toast(MoteI18n.text("Android 10 内容截图请勾选投屏模式；仅活动无需投屏")); return }
            if (!CaptureAccessibilityService.connected) { showPage(Page.PERMISSIONS); toast(MoteI18n.text("请先启用无障碍截图服务，返回后再开始")); return }
            enableCapture(c, MoteI18n.text("采集已启用，等待首帧；配置页受系统安全保护")) {}
        } else {
            if (!CaptureAccessibilityService.connected && AppCollectionRules.parse(c.appCollectionRules).requiresWindowIdentity(PrivacyRules.exclusions(c.excludedPackages))) {
                showPage(Page.PERMISSIONS); toast(MoteI18n.text("分级采集需要可靠窗口身份，请先启用无障碍服务；不会读取控件文字")); return
            }
            requestProjectionConsent()
        }
        refreshStatus()
    }
    private fun enableCapture(config: CollectorConfig, message: String, after: () -> Unit) {
        uiTask.start(MoteI18n.text("正在启用采集…"), { status.text = it }, {
            ConnectionGuard.startCapture(applicationContext, SourceRules.hash(config.toString())) {
                Operations.record(applicationContext, OperationKind.CAPTURE_STARTED); settings.status("capturing", message)
            }
        }) { result ->
            if (result.getOrDefault(false)) after() else toast(MoteI18n.text("节点或配置已变化，请重新点击开始"))
            refreshStatus()
        }
    }
    private fun requestProjectionConsent() {
        val c = loadedConfig
        if (!CaptureAccessibilityService.connected && AppCollectionRules.parse(c.appCollectionRules).requiresWindowIdentity(PrivacyRules.exclusions(c.excludedPackages))) {
            showPage(Page.PERMISSIONS); toast(MoteI18n.text("分级采集需要可靠窗口身份，请先启用无障碍服务")); return
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
                toast(MoteI18n.text("参数已带回采集设置，请点击保存后应用"))
            }
            return
        }
        if (requestCode in setOf(103, 104) && resultCode == RESULT_OK && data?.data != null) {
            val uri = data.data!!; val app = applicationContext
            uiTask.start(MoteI18n.text("正在导出诊断包…"), { technicalStatus.text = it }, {
                val body = if (requestCode == 104) SupportEvents.export(app, logExportHours) else Diagnostics(app).export()
                app.contentResolver.openOutputStream(uri)!!.use { it.write(body.toByteArray()) }
            }) { result -> toast(if (result.isSuccess) MoteI18n.text("诊断包已导出") else MoteI18n.text("诊断导出失败")) }
            return
        }
        if (requestCode == 102 && resultCode == RESULT_OK && data?.data != null) {
            val uri = data.data!!; val app = applicationContext
            uiTask.start(MoteI18n.text("正在导入并校验模型…"), { nsfwStatus.text = it }, {
                val store = NsfwModelStore(app)
                app.contentResolver.openInputStream(uri)!!.use { store.importModel(it) }; NsfwClient.resetAll()
            }) { result -> toast(if (result.isSuccess) MoteI18n.text("模型导入完成") else MoteI18n.text("导入失败，请核对模型大小与 SHA-256；原模型保留")); refreshStatus() }
            return
        }
        if (requestCode == 100 && resultCode == RESULT_OK && data != null) {
            val stamp = projectionRequestStamp; projectionRequestStamp = null
            val startProjection = {
                startForegroundService(Intent(this, ProjectionService::class.java).putExtra("result", resultCode).putExtra("consent", data).putExtra("configurationStamp", stamp))
                Operations.record(this, OperationKind.CAPTURE_STARTED)
            }
            uiTask.start(MoteI18n.text("正在启用投屏采集…"), { status.text = it }, {
                stamp != null && if (settings.enabled) ConnectionGuard.sync {
                    val c = settings.read()
                    if (stamp == SourceRules.hash(c.toString()) && c.screenCollectionEnabled && c.effectiveMode() == "projection" && c.observesSystem() && !ProjectionService.running) {
                        startProjection(); true
                    } else false
                } == true else ConnectionGuard.startCapture(applicationContext, stamp, startProjection)
            }) { result ->
                if (!result.getOrDefault(false)) settings.status(if (settings.enabled) "capturing" else "permission_required", MoteI18n.text("节点或采集配置已变化，本次授权已丢弃；请重新点击开始"))
                refreshStatus()
            }
        } else if (requestCode == 100) settings.status(if (settings.enabled) "capturing" else "permission_required", MoteI18n.text("你未授予投屏权限，未开始截图") + if (settings.enabled) MoteI18n.text("；媒体采集继续运行") else "")
    }
    private fun stopCapture() {
        RuntimeSettings.cancelProjectionConsentRequest()
        RuntimeSettings.stop(this) { result ->
            if (isDestroyed) return@stop
            result.onSuccess {
                settings.status("paused", MoteI18n.text("你已停止采集，已有记录保留，同步按所选策略运行"))
            }.onFailure { toast(it.message ?: MoteI18n.text("停止未完成，请重试")) }
            refreshStatus()
        }
        refreshStatus()
    }
    private fun refreshStatus() {
        if (!::status.isInitialized) return
        // Capture controls reflect cheap live state before optional statistics/diagnostics.
        // A slow inventory must not make a successful Start look unresponsive.
        val action = if (settings.enabled) MoteI18n.text("暂停采集") else MoteI18n.text("开始采集")
        if (captureAction.text != action) {
            captureAction.text = action
            captureTitle.text = if (settings.enabled) MoteI18n.text("正在本机采集") else MoteI18n.text("采集已暂停")
            captureProgress.visibility = if (settings.enabled) View.VISIBLE else View.GONE
            status.text = settings.message()
        }
        if (QueueStorage.recovering) { status.text = MoteI18n.text("正在连接本机存储，文件整理将在后台继续…"); return }
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
                    status.text = snapshot.status; syncStatus.text = snapshot.sync + "\n" + MoteI18n.text("上传速率") + " · " + UploadMeter.label()
                    totalsStatus.text = snapshot.totals; if (::technicalStatus.isInitialized) technicalStatus.text = snapshot.technical
                    centralConnectionTitle.text = snapshot.connectionTitle; centralConnectionStatus.text = snapshot.connection
                    if (::connectionSummary.isInitialized) connectionSummary.text = snapshot.connection
                    if (::nsfwStatus.isInitialized) nsfwStatus.text = snapshot.model
                    if (::mediaStatus.isInitialized) mediaStatus.text = snapshot.media
                    updateSaveBar()
                }.onFailure { captureProgress.visibility = View.GONE; status.text = MoteI18n.text("状态暂不可读取，已有记录保留在本机；稍后自动重试") }
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
        val state = if (settings.enabled && !live) MoteI18n.text("采集服务未连接：请恢复权限") else if (settings.state() == "capturing") MoteI18n.text("正在采集") else settings.message()
        val stats = runCatching { Operations.ledger(this).read().getJSONObject("counts") }.getOrNull()
        val totals = if (stats == null) MoteI18n.text("统计暂不可读取") else MoteI18n.text("本周期累计截图记录 {0} · 应用活动 {1} · 媒体 {2} · 笔记 {3} · 已确认 {4}\n拦截 {5} · 失败 {6} · 重试结果 {7}", stats.optLong("SCREEN_QUEUED"), stats.optLong("ACTIVITY_QUEUED"), stats.optLong("MEDIA_QUEUED"), stats.optLong("NOTE_QUEUED"), stats.optLong("SCREEN_ACK") + stats.optLong("NOTE_ACK") + stats.optLong("ACTIVITY_ACK") + stats.optLong("MEDIA_ACK"), stats.optLong("FRAME_BLOCKED"), stats.optLong("CAPTURE_FAILED") + stats.optLong("ACTIVITY_FAILED") + stats.optLong("MEDIA_FAILED"), stats.optLong("UPLOAD_RETRY"))
        val queueStats = local.active
        val pending = local.pending
        val bytes = queueStats?.quotaBytes?.div(1024.0 * 1024)
        val modelMissing = c != null && c.screenCollectionEnabled && c.nsfw.enabled && AppCollectionRules.parse(c.appCollectionRules).mayCollectContent() && !NsfwModelStore(this).hasFile()
        val queueFull = c != null && bytes != null && bytes >= c.maxQueueMiB
        val title = when {
            settings.enabled && !live -> MoteI18n.text("等待采集权限")
            settings.enabled && queueFull -> MoteI18n.text("本机空间已满")
            settings.enabled && modelMissing -> MoteI18n.text("等待本机过滤模型")
            settings.enabled && settings.state() == "paused" -> MoteI18n.text("采集暂时等待")
            settings.enabled -> MoteI18n.text("正在本机采集")
            else -> MoteI18n.text("采集已暂停")
        }
        val action = if (settings.enabled) MoteI18n.text("暂停采集") else MoteI18n.text("开始采集")
        val syncWait = c?.takeIf { it.hasSyncConnection() }?.let { SyncSchedule.waitingReason(this, it) }
        val syncMessage = when {
            c == null -> MoteI18n.text("无法读取同步配置")
            !c.hasSyncConnection() -> MoteI18n.text("仅保存在本机 · 尚未连接节点")
            syncWait != null -> syncWait
            c.syncMode == "manual" && settings.syncState() !in setOf("uploading", "error", "waiting") -> MoteI18n.text("手动同步 · 点击立即同步才会发送")
            c.syncMode in setOf("interval", "batch") && settings.syncState() !in setOf("uploading", "error") ->
                if (c.syncMode == "interval") MoteI18n.text("约每 {0} 分钟同步", c.syncIntervalMinutes) else MoteI18n.text("满 {0} 条或等待 {1} 分钟同步", c.syncBatchSize, c.syncIntervalMinutes)
            else -> settings.uploadStatus()
        }
        val nativeFacts = NativeStatus.project(org.json.JSONObject().put("pending", pending ?: org.json.JSONObject.NULL)
            .put("lastAcknowledgedAt", settings.lastAcknowledgedAt() ?: org.json.JSONObject.NULL)
            .put("syncState", when { c == null || !c.hasSyncConnection() -> "unconfigured"; local.error != null || queueStats == null || queueStats.blocked > 0 -> "blocked"; else -> settings.syncState().takeIf { it in setOf("idle", "waiting", "uploading", "error", "paused") } ?: "waiting" })
            .put("errorCode", when { local.error != null || queueStats == null -> "local_state_unavailable"; queueStats.blocked > 0 -> "retained_conflict"; else -> org.json.JSONObject.NULL }))
        val syncText = "${pending?.let { MoteI18n.text("待同步 {0} 条", it) } ?: MoteI18n.text("队列暂不可读取")}${bytes?.let { " · ${"%.1f".format(it)} MiB" } ?: ""}\n${syncMessage}\n${NativeStatus.summary(nativeFacts)}"
        val totalsText = local.imageLabel() + (if (QueueStorage.maintaining) MoteI18n.text(" · 后台整理中，可正常采集") else "") + "\n" + if (stats == null) MoteI18n.text("累计统计暂不可读取") else MoteI18n.text("本周期累计截图记录 {0}    活动 {1}    媒体 {2}    随手记 {3}\n本周期已同步 {4} 条", stats.optLong("SCREEN_QUEUED"), stats.optLong("ACTIVITY_QUEUED"), stats.optLong("MEDIA_QUEUED"), stats.optLong("NOTE_QUEUED"), stats.optLong("SCREEN_ACK") + stats.optLong("NOTE_ACK") + stats.optLong("ACTIVITY_ACK") + stats.optLong("MEDIA_ACK"))
        val technicalText = MoteI18n.text("{0}\n{1}\n{2}\n{3}\n无障碍 {4} · 使用情况 {5}\n最近采集 {6}", state, totals, syncText, settings.uploadStatus(), if (CaptureAccessibilityService.connected) MoteI18n.text("已连接") else MoteI18n.text("未连接"), if (ForegroundApps.usageAllowed(this)) MoteI18n.text("已授权") else MoteI18n.text("未授权"), settings.lastCapture() ?: MoteI18n.text("无"))
        val connectionState = c?.takeIf { it.hasSyncConnection() }?.let { ConnectionClient(this).status() } ?: "unchecked"
        val connectionTitle = when {
            c == null || !c.hasSyncConnection() -> MoteI18n.text("未连接中央节点")
            settings.syncState() == "uploading" -> MoteI18n.text("正在同步中央节点")
            settings.syncState() == "error" || connectionState !in setOf("connected", "unchecked") -> MoteI18n.text("连接需要处理")
            connectionState == "unchecked" -> MoteI18n.text("已保存节点 · 待验证")
            else -> MoteI18n.text("已连接中央节点")
        }
        val connectionText = when {
            c == null || !c.hasSyncConnection() -> MoteI18n.text("记录只保存在本机；连接后按你的策略上传。")
            settings.syncState() == "error" -> settings.uploadStatus()
            pending != null && pending > 0 -> MoteI18n.text("待同步 {0} 条 · 节点：{1}", pending, c.server)
            connectionState == "unchecked" -> MoteI18n.text("节点已保存，但尚未完成最近一次连接验证：{0}", c.server)
            else -> MoteI18n.text("节点：{0} · 最近一次验证成功", c.server)
        }
        val model = NsfwModelStore(this)
        return StatusSnapshot(title, action, state, syncText, totalsText, technicalText, connectionTitle, connectionText, "${model.status()}\n${model.inferenceStatus()}", MediaCollection.statusLabel(this), c)
    }
    private fun mediaPermission() {
        MoteDialogBuilder(this).setTitle(MoteI18n.text("媒体播放状态授权"))
            .setMessage(MoteI18n.text("Android 通过通知使用权开放通知与媒体会话。开启通知采集后，Mote 会保存应用公开的标题、正文、持续状态以及更新和移除事件，并按同步策略上传。设备事件单独记录亮屏、熄屏和锁定状态。各来源需单独开启并点击开始；应用的“不记录”和“仅活动”规则仍适用。系统可能隐藏敏感通知；Mote 不回复通知、不控制播放。"))
            .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("打开系统设置")) { _, _ ->
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
        catch (_: Exception) { try { startActivity(detailsIntent()); toast(MoteI18n.text("此系统入口不同，请在应用详情或系统搜索中查找")) } catch (_: Exception) { toast(MoteI18n.text("请手动打开系统设置")) } }
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
    }
    override fun onStop() { super.onStop() }
    override fun onDestroy() { statusExecutor.shutdownNow(); handler.removeCallbacksAndMessages(null); super.onDestroy() }
    private fun dp(value: Int) = moteDp(value)

    private fun help(title: String, message: String) {
        text(title + "  ›", 13, MoteUi.accent).apply {
            minHeight = dp(44); gravity = Gravity.CENTER_VERTICAL; isFocusable = true
            setOnClickListener { MoteDialogBuilder(this@MainActivity).setTitle(title).setMessage(message).setPositiveButton(MoteI18n.text("知道了"), null).show() }
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
                contentDescription = MoteI18n.text("返回{0}", Page.valueOf(page.parent).title); setOnClickListener { showPage(Page.valueOf(page.parent)) }
            }
        } else text("MOTE", 11, MoteUi.accent).apply { letterSpacing = .18f }
        text(page.title, 30).apply { typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL) }
        text(subtitle, 14, MoteUi.muted)
    }

    private fun ensurePage(page: Page) {
        if (pages.containsKey(page)) return
        val wasInitializing = initializing
        initializing = true
        try {
            when (page) {
                Page.OVERVIEW -> buildToday()
                Page.LIBRARY -> buildLibrary()
                Page.ASK -> buildAsk()
                Page.NOTES -> buildNotes()
                Page.SOURCES -> buildSources()
                Page.SETTINGS -> { buildOverview(); buildSettings() }
                Page.PERMISSIONS -> buildPermissions()
                Page.ABOUT -> buildAbout()
                else -> buildSettingsPage(page, loadedConfig)
            }
            baseline = baseline + controlValues(controls.filter { controlPages[it] == page })
        } finally { initializing = wasInitializing }
    }

    private fun showPage(page: Page, discardConfirmed: Boolean = false) {
        if (!initializing && page != currentPage && !discardConfirmed && pageControlValues().any { (key, value) -> baseline[key] != value && (!applyingSettings || pendingSubmission?.get(key) != value) }) {
            MoteDialogBuilder(this).setTitle(MoteI18n.text("有未保存的更改"))
                .setMessage(MoteI18n.text("离开并丢弃修改？"))
                .setNegativeButton(MoteI18n.text("继续编辑"), null)
                .setPositiveButton(MoteI18n.text("丢弃修改")) { _, _ -> showPage(page, true) }.show()
            return
        }
        ensurePage(page)
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
        saveHint.text = if (applyingSettings) MoteI18n.text("正在保存…") else MoteI18n.text("有未保存的更改")
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
        if (rules == null) { appRuleRows.addView(TextView(this).apply { text = MoteI18n.text("手工规则格式有误，请展开高级规则修正。") }); return }
        val excluded = PrivacyRules.exclusions(excludes.text.toString())
        val ids = (rules.apps.keys + excluded).sorted()
        if (ids.isEmpty()) appRuleRows.addView(TextView(this).apply { text = MoteI18n.text("尚无单独规则，所有应用沿用上方设置。"); textSize = 13f; setTextColor(MoteUi.muted); setPadding(0, dp(10), 0, dp(14)) })
        ids.forEach { id ->
            val label = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(id, 0)).toString() }.getOrDefault(id)
            val mode = if (id in excluded) AppCollectionMode.OFF else rules.apps.getValue(id)
            appRuleRows.addView(MoteUi.button(Button(this)).apply {
                text = "$label · ${appModeLabel(mode)}"; contentDescription = MoteI18n.text("{0}，{1}，{2}，点击更改", label, id, appModeLabel(mode))
                setOnClickListener { chooseAppMode(id, label) }
            }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        }
    }
    private fun appModeLabel(mode: AppCollectionMode) = when (mode) { AppCollectionMode.CONTENT -> MoteI18n.text("截图与内容"); AppCollectionMode.ACTIVITY -> MoteI18n.text("仅应用和时长"); AppCollectionMode.OFF -> MoteI18n.text("不记录") }
    private fun chooseAppMode(id: String, label: String, onChanged: () -> Unit = {}) {
        val current = runCatching { AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString()) }.getOrElse { toast(MoteI18n.text("请先修正高级规则")); return }
        val selectedIndex = if (id in PrivacyRules.exclusions(excludes.text.toString())) 2 else current.apps[id]?.ordinal ?: 3
        MoteDialogBuilder(this).setTitle(label).setSingleChoiceItems(arrayOf(MoteI18n.text("截图与内容 · 保存过滤后的截图"), MoteI18n.text("仅应用和时长 · 不保存截图"), MoteI18n.text("不记录 · 跳过此应用"), MoteI18n.text("使用默认方式 · {0}", appModeLabel(current.defaultMode))), selectedIndex) { dialog, index ->
            runCatching {
                val rules = AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString())
                val selected = rules.apps.toMutableMap()
                if (index == 3) selected.remove(id) else selected[id] = AppCollectionMode.entries[index]
                AppCollectionRules.parse(AppCollectionRules(rules.defaultMode, selected).json())
                excludes.setText(PrivacyRules.exclusions(excludes.text.toString()).filterNot { it == id }.joinToString("\n"))
                appPolicies.setText(selected.entries.joinToString("\n") { "${it.key}=${it.value.wire}" })
                dialog.dismiss(); onChanged()
            }.onFailure { toast(it.message ?: MoteI18n.text("请检查应用规则")) }
        }.setNegativeButton(MoteI18n.text("取消"), null).show()
    }
    private fun chooseInstalledApp() {
        val configured = AppCollectionRules.fromLines(AppCollectionMode.entries[appDefault.selectedItemPosition], appPolicies.text.toString()).apps.keys + PrivacyRules.exclusions(excludes.text.toString())
        var apps = emptyList<Pair<String, String>>()
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(8)) }
        val search = MoteUi.field(EditText(this)).apply { hint = MoteI18n.text("搜索应用名称"); setSingleLine() }; body.addView(search)
        val list = ListView(this); body.addView(list, LinearLayout.LayoutParams(-1, dp(340)))
        val modes = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("全部应用"), MoteI18n.text("截图与内容"), MoteI18n.text("仅应用和时长"), MoteI18n.text("不记录")))
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
            summary.text = MoteI18n.text("{0} 个应用 · 点按更改，返回后保存生效", shown.size)
            list.adapter = object : ArrayAdapter<Pair<String, String>>(this, android.R.layout.simple_list_item_2, shown) {
                override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                    val view = convertView ?: layoutInflater.inflate(android.R.layout.simple_list_item_2, parent, false)
                    val app = getItem(position)!!
                    view.findViewById<TextView>(android.R.id.text1).text = app.second
                    view.findViewById<TextView>(android.R.id.text2).text = "${appModeLabel(mode(app.first))} · ${if (app.first in excluded || app.first in rules.apps) MoteI18n.text("单独设置") else MoteI18n.text("默认")}\n${app.first}"
                    return view
                }
            }
        }
        modes.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { filter() }
        }
        val dialog = MoteDialogBuilder(this).setTitle(MoteI18n.text("应用记录方式")).setView(body).setNegativeButton(MoteI18n.text("完成"), null).create()
        list.setOnItemClickListener { _, _, position, _ -> val app = shown[position]; chooseAppMode(app.first, app.second) { filter() } }
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { filter() }
        }); filter(); dialog.show()
        uiTask.start(MoteI18n.text("正在读取已安装应用…"), { if (dialog.isShowing) summary.text = it }, {
            InstalledApps.load(packageManager, configured)
        }) { result ->
            if (dialog.isShowing) result.onSuccess { apps = it; filter() }.onFailure { summary.text = MoteI18n.text("应用列表读取失败，请关闭后重试") }
        }
    }
    private fun editSelectedMask() {
        val chosen = maskEditor.value().getOrNull(maskEditor.selectedIndex) ?: run { toast(MoteI18n.text("请先在示意图中点选一个绿色区域")); return }
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(8)) }
        val sliders = listOf(MoteI18n.text("左边界") to chosen.left, MoteI18n.text("上边界") to chosen.top, MoteI18n.text("右边界") to chosen.right, MoteI18n.text("下边界") to chosen.bottom).map { (name, value) ->
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
        val dialog = MoteDialogBuilder(this).setTitle(MoteI18n.text("调整遮罩区域")).setView(form).setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("应用"), null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            runCatching { maskEditor.updateSelected(Mask(sliders[0].progress / 100f, sliders[1].progress / 100f, sliders[2].progress / 100f, sliders[3].progress / 100f)); dialog.dismiss() }
                .onFailure { toast(MoteI18n.text("右边界应大于左边界，下边界应大于上边界")) }
        } }; dialog.show()
    }

    private fun presetNumber(label: String, value: Int, placeholder: String, range: IntRange, presets: List<Int>): EditText {
        val result = field(label, value.toString(), placeholder, InputType.TYPE_CLASS_NUMBER)
        result.keyListener = null; result.isFocusable = false; result.isClickable = true
        result.setCompoundDrawablesWithIntrinsicBounds(null, null, MoteNavigationIcon(this, "dropdown", true), null)
        result.contentDescription = MoteI18n.text("{0}，点按选择", label)
        result.setOnClickListener {
            val current = result.text.toString().toIntOrNull()
            val choices = (presets + listOfNotNull(current)).distinct().sorted()
            val labels = choices.map { it.toString() } + MoteI18n.text("自定义…")
            MoteDialogBuilder(this).setTitle(label).setSingleChoiceItems(labels.toTypedArray(), choices.indexOf(current)) { dialog, index ->
                dialog.dismiss()
                if (index < choices.size) { result.setText(choices[index].toString()); result.error = null }
                else {
                    val custom = MoteUi.field(EditText(this)).apply { inputType = InputType.TYPE_CLASS_NUMBER; setText(result.text); selectAll() }
                    val customDialog = MoteDialogBuilder(this).setTitle(MoteI18n.text("自定义数值")).setMessage(MoteI18n.text("范围 {0}–{1}", range.first, range.last))
                        .setView(custom).setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("确定"), null).create()
                    customDialog.setOnShowListener { customDialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                        val number = custom.text.toString().toIntOrNull()
                        if (number == null || number !in range) custom.error = MoteI18n.text("请输入 {0}–{1} 之间的整数", range.first, range.last)
                        else { result.setText(number.toString()); result.error = null; customDialog.dismiss() }
                    } }; customDialog.show()
                }
            }.setNegativeButton(MoteI18n.text("取消"), null).show()
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
