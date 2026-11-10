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
import dev.mote.collector.plugins.DailyHomeOwner
import dev.mote.collector.plugins.DailyHomePlugin
import dev.mote.collector.plugins.DailyHomeSections
import dev.mote.collector.plugins.NativeAdministrationPlugin
import dev.mote.collector.plugins.NativeSystemToolsPlugin
import dev.mote.collector.plugins.NativeWorkDiscoveryPlugin
import dev.mote.collector.ui.MoteComponents
import dev.mote.collector.ui.MoteGlyph
import dev.mote.collector.ui.MoteIconButtonStyle
import dev.mote.collector.ui.moteGlyph
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.concurrent.Executors

class MainActivity : MoteActivity() {
    private lateinit var settings: Settings
    private lateinit var content: LinearLayout
    private lateinit var loadedConfig: CollectorConfig
    private var projectionRequestStamp: String? = null
    private var pageRuleImportTarget: Pair<String, String>? = null
    private var permissionReturnPage = Page.SETTINGS
    private enum class ConnectionOrigin { LOCAL_ASK, LOCAL_ACTIVITY, CENTRAL_CALLER }
    private var connectionOrigin: ConnectionOrigin? = null
    private var applyingConnectionFields = false
    private lateinit var status: TextView
    private lateinit var captureTitle: TextView
    private lateinit var captureProgress: ProgressBar
    private lateinit var syncStatus: TextView
    private lateinit var totalsStatus: TextView
    private lateinit var technicalStatus: TextView
    private var diagnosticExportStatus: TextView? = null
    private lateinit var captureAction: Button
    private lateinit var centralConnectionTitle: TextView
    private lateinit var centralConnectionStatus: TextView
    private lateinit var saveBar: LinearLayout
    private var applyingSettings = false
    private var pendingSubmission: Map<String, String>? = null
    private lateinit var saveHint: TextView
    private lateinit var pagesHost: FrameLayout
    private val pages = linkedMapOf<Page, View>()
    private lateinit var homeHeader: LinearLayout
    private lateinit var headerMarkAction: View
    private lateinit var headerSearchAction: ImageView
    private lateinit var headerBackAction: android.widget.ImageButton
    private lateinit var headerDivider: View
    private lateinit var headerTitle: TextView
    private lateinit var headerHeading: LinearLayout
    private lateinit var headerActions: LinearLayout
    private var activeMenuGroup: LinearLayout? = null
    private var centralContent: CentralContent? = null
    private var centralState: Bundle? = null
    private var activityContent: CentralContent? = null
    private var activityState: Bundle? = null
    private var pendingCentralResult: Triple<Int, Int, Intent?>? = null
    private var pendingPageRuleResult: Pair<Int, Intent?>? = null
    private val scrollPositions = mutableMapOf<Page, Int>()
    private lateinit var navigation: MotePrimaryNavigation
    private lateinit var homeRecordingBar: HomeRecordingBar
    private lateinit var todaySummary: TextView
    private lateinit var manageScreenSwitch: MoteComponents.MoteSwitch
    private lateinit var manageSendSwitch: MoteComponents.MoteSwitch
    private lateinit var manageScreenPermission: LinearLayout
    private lateinit var homeSyncDetailStatus: TextView
    private lateinit var homeSyncRate: TextView
    private lateinit var homeSourceList: LinearLayout
    private val homeTask by lazy { UiTask(this) }
    private var homeSections: DailyHomeSections? = null
    private var homePlugin: DailyHomeOwner? = null
    private var captureRangeState: TextView? = null
    private lateinit var homeNoticeRow: HomeNoticeRow
    internal fun isFirstUseRecordEntry() = firstUse
    private var libraryView: LibraryCaptureView? = null
    private var libraryState: Bundle? = null
    private var processingSave: Button? = null
    private var libraryRecordsRevision = -1L
    private var firstUse = true
    private var homeArchiveEmpty = false
    private var homeHasRecords = false
    private val controls = mutableListOf<View>()
    private val controlPages = mutableMapOf<View, Page>()
    private val stableControlKeys = mutableMapOf<View, String>()
    private val fieldLabels = mutableMapOf<EditText, TextView>()
    private var baseline = emptyMap<String, String>()
    private var initializing = true
    private var buildingPage = Page.OVERVIEW
    private var currentPage = Page.OVERVIEW
    private var draftGeneration = 0
    private enum class Page(private val titleKey: String, val parent: String? = null) {
        OVERVIEW("首页"), MANAGE("我的 Mote", "OVERVIEW"), LIBRARY("资料与记忆", "MANAGE"), ASK("问一问", "OVERVIEW"), ACTIVITY("活动", "MANAGE"), NOTES("记录", "LIBRARY"), SOURCES("采集与同步", "MANAGE"), SETTINGS("设置", "MANAGE"),
        CONNECTION("连接与设备", "SETTINGS"), CAPTURE("采集与存储", "SETTINGS"),
        PROCESSING("图像质量与去重", "CAPTURE"), STORAGE("本机存储", "CAPTURE"),
        PRIVACY("采集范围", "SETTINGS"), PERMISSIONS("系统权限与后台运行", "SETTINGS"),
        APPEARANCE("外观与语言", "SETTINGS"),
        ABOUT("关于、更新与反馈", "SETTINGS"), DEVELOPER("开发者选项", "SETTINGS"),
        DIAGNOSTICS("诊断与支持", "SETTINGS")
    ;
        val title get() = MoteI18n.text(titleKey)
        fun belongsToSettings(): Boolean = this == SETTINGS || parent?.let { valueOf(it).belongsToSettings() } == true
    }
    private var logExportHours = 24
    private data class RetainedDraft(val fields: Map<String, String>, val config: CollectorConfig, val appCapture: AppCaptureEditor.State?)
    private lateinit var name: EditText
    private lateinit var interval: EditText
    private lateinit var uploadedRetention: EditText
    private lateinit var maxQueue: EditText
    private lateinit var excludes: EditText
    private lateinit var uiPageMode: Spinner
    private val uiPageModes = listOf("screen_only", "ui_preferred")
    private lateinit var uiPageRules: EditText
    private lateinit var masks: EditText
    private lateinit var appCaptureEditor: AppCaptureEditor
    private lateinit var maskEditor: MaskEditorView
    private lateinit var http: CheckBox
    private lateinit var projectionMode: CheckBox
    private lateinit var appDefaultDuration: CheckBox
    private lateinit var appDefaultScreenshots: CheckBox
    private lateinit var appDefaultStructured: CheckBox
    private lateinit var appDefaultSummary: Button
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
    private lateinit var chargingOnly: CheckBox
    private lateinit var localContentOcr: CheckBox
    private lateinit var ocrMode: Spinner
    private lateinit var ocrAppModes: EditText
    private lateinit var diagnosticEnabled: CheckBox
    private lateinit var imageDedupeDiagnosticsEnabled: CheckBox
    private lateinit var diagnosticInterval: EditText
    private lateinit var gateEnabled: CheckBox
    private lateinit var gateText: EditText
    private lateinit var gateFailure: Spinner
    private val permissionBadges = linkedMapOf<String, TextView>()
    private lateinit var projectionButton: Button
    private var notePoll: Runnable? = null
    private val handler = Handler(Looper.getMainLooper())
    private val uiTask by lazy { UiTask(this) }
    private val statusExecutor = Executors.newSingleThreadExecutor()
    private var statusLoading = false
    private var statusRefreshPending = false
    private var resumed = false
    private val settingsSummaries by lazy { NativeAdministrationPlugin.owner(this).settingsSummary() }
    private val systemTools by lazy { NativeSystemToolsPlugin.owner(this) }
    private var settingsConnectionRow: LinearLayout? = null
    private var settingsConnectionTitle: TextView? = null
    private var settingsConnectionDetail: TextView? = null
    private var connectionCentralValue: TextView? = null
    private var connectionPermissionValue: TextView? = null
    private var connectionTimeValue: TextView? = null
    private var connectionConnectAction: View? = null
    private var connectionDisconnectAction: View? = null
    private var localStateJob: kotlinx.coroutines.Job? = null
    private data class StatusSnapshot(val title: String, val action: String, val status: String, val sync: String,
        val totals: String, val technical: String, val connectionTitle: String, val connection: String,
        val media: String, val config: CollectorConfig?, val syncQueue: String, val syncPolicy: String, val syncFacts: String, val captureAttention: Boolean,
        val notice: HomeNotice?)
    private val refresh = object : Runnable {
        override fun run() { refreshStatus(); loadHomeContent(); handler.postDelayed(this, 2000) }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { navigateBack() }
        centralState = savedInstanceState?.getBundle("centralContent")
        activityState = savedInstanceState?.getBundle("activityContent")
        permissionReturnPage = savedInstanceState?.getString("permissionReturnPage")?.let { value -> Page.entries.find { it.name == value } } ?: Page.SETTINGS
        connectionOrigin = savedInstanceState?.getString("connectionOrigin")?.let { value -> ConnectionOrigin.entries.find { it.name == value } }
            ?: if (savedInstanceState == null && intent.getStringExtra("page") == "CONNECTION" && intent.getBooleanExtra("returnToCentral", false)) ConnectionOrigin.CENTRAL_CALLER else null
        savedInstanceState?.getString("pageRuleImportApp")?.let { id -> pageRuleImportTarget = id to savedInstanceState.getString("pageRuleImportVersion", "") }
        val retained = lastNonConfigurationInstance as? RetainedDraft
        val loading = moteDetailPage()
        val mark = MoteComponents.loadingMark(this, MoteI18n.text("正在读取本机设置…")); loading.addView(mark, LinearLayout.LayoutParams(-1, 0, 1f))
        uiTask.start(MoteI18n.text("正在读取本机设置…"), {}, {
            Settings(applicationContext).let { it to it.read() }
        }) { result ->
            result.onSuccess { (opened, config) ->
                settings = opened
                buildUi(config, savedInstanceState, retained)
                if (resumed) resumeUi()
            }
                .onFailure { failure ->
                    loading.removeView(mark)
                    loading.addView(TextView(this).apply { text = if (failure.message == MoteI18n.text(LocalDataFormat.RESET_MESSAGE)) failure.message else MoteI18n.text("设置无法读取，原数据保留。请退出后检查存储或重试。") })
                }
        }
    }
    private fun buildUi(config: CollectorConfig, savedInstanceState: Bundle?, retained: RetainedDraft?) {
        loadedConfig = config
        settingsSummaries.committed(config.settingsSummary())
        val root = NativeAppShell(this).apply { moteInsets(topBar = true) }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(MoteTheme.spacePage), 0, dp(MoteTheme.spacePage), 0) }
        headerHeading = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        headerActions = LinearLayout(this).apply { gravity = Gravity.END or Gravity.CENTER_VERTICAL }
        headerBackAction = MoteComponents.iconButton(this, MoteGlyph.BACK, "返回上一页") {
            navigatePageBack(currentPage)
        }.apply { tag = "local-back" }
        headerHeading.addView(headerBackAction, LinearLayout.LayoutParams(dp(MoteTheme.controlHeight), -2))
        headerMarkAction = LinearLayout(this).apply {
            gravity = Gravity.CENTER; tag = "home-m-action"; visibility = View.GONE
            contentDescription = MoteI18n.text("我的 Mote"); isFocusable = true
            background = MoteUi.clickable(this@MainActivity, NativeColorRole.TRANSPARENT, NativeRadiusRole.PILL, false)
            setOnClickListener { showPage(Page.MANAGE) }
            addView(MoteComponents.mark(this@MainActivity).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, LinearLayout.LayoutParams(dp(28), dp(28)))
        }
        headerHeading.addView(headerMarkAction, LinearLayout.LayoutParams(dp(48), dp(48)))
        headerTitle = TextView(this).apply { text = "Mote"; tag = "local-page-title"; MoteUi.type(this, NativeFontRole.APPBAR, medium = true); MoteUi.textColor(this, NativeColorRole.INK) }
        headerHeading.addView(headerTitle, LinearLayout.LayoutParams(0, -2, 1f))
        // H01: the home app bar carries only the brand entry and Central's original search.
        headerSearchAction = MoteComponents.iconButton(this, MoteGlyph.SEARCH, "搜索资料") { openCentral(MoteNavigation.SEARCH) }.apply {
            tag = "home-search-action"
        }
        headerActions.addView(headerSearchAction, LinearLayout.LayoutParams(dp(48), dp(48)))
        header.addView(headerHeading, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(headerActions, LinearLayout.LayoutParams(-2, -2))
        homeHeader = header
        root.header(header)
        headerDivider = View(this).apply { MoteUi.backgroundColor(this, NativeColorRole.DIVIDER); layoutParams = LinearLayout.LayoutParams(-1, dp(1)) }
        root.header(headerDivider)
        pagesHost = FrameLayout(this)
        root.content(pagesHost)
        saveBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(MoteTheme.spacePage), dp(MoteTheme.spaceItem), dp(MoteTheme.spacePage), dp(MoteTheme.spaceItem)); MoteUi.backgroundColor(this, NativeColorRole.SURFACE)
        }
        saveHint = TextView(this).apply { MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED) }
        saveBar.addView(saveHint, LinearLayout.LayoutParams(0, -2, 1f))
        saveBar.addView(MoteUi.button(Button(this).apply {
            text = MoteI18n.text("保存设置"); setOnClickListener { saveConfig() }
        }, true), LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(12) })
        root.footer(saveBar)
        homeRecordingBar = HomeRecordingBar(this) { openRecordEditor() }
        root.footer(homeRecordingBar)
        homeRecordingBar.layoutParams = LinearLayout.LayoutParams(-1, -2).apply {
            leftMargin = dp(16); rightMargin = dp(16); bottomMargin = dp(10)
        }
        navigation = MotePrimaryNavigation(this) { showPage(Page.valueOf(it.localPage)) }
        root.navigation(navigation)
        setContentView(root)
        // CollectorConfig is the complete draft baseline. Unvisited pages never supply defaults.
        libraryState = savedInstanceState?.getBundle("library"); logExportHours=savedInstanceState?.getInt("logExportHours",24)?.takeIf { it in listOf(1,24,168) } ?: 24
        buildToday()
        buildManagement()
        buildSettings()
        val restoredPage = savedInstanceState?.getString("page")?.let { value -> Page.entries.find { it.name == value } } ?: intent.getStringExtra("page")?.let { value -> requestedPage(value) } ?: Page.valueOf(MoteNavigation.initialLocalPage())
        val initialPage = restoredPage
        ensurePage(initialPage)
        baseline = controlValues()
        retained?.let { retained ->
            if (retained.config == config) {
                restoreControlValues(retained.fields)
                if (::appCaptureEditor.isInitialized) appCaptureEditor.restore(retained.appCapture)
            }
        }
        initializing = false
        val restoredPermissionReturn = permissionReturnPage
        showPage(initialPage, connectionEntryOrigin = connectionOrigin)
        if (initialPage == Page.PERMISSIONS) permissionReturnPage = restoredPermissionReturn
        pendingCentralResult?.let { (request, result, data) ->
            pendingCentralResult = null
            ensurePage(Page.ASK)
            centralContent?.activityResult(request, result, data)
        }
        pendingPageRuleResult?.let { (result, data) -> pendingPageRuleResult = null; onActivityResult(106, result, data) }
        refreshStatus()
        if (savedInstanceState == null && intent.getStringExtra("page") == "OBSERVATIONS") pagesHost.post { showObservations() }
        if (savedInstanceState == null) takeCaptureAction(intent)
        dev.mote.collector.plugins.SystemEntriesPlugin.refresh(applicationContext)
    }

    private fun buildToday() {
        val local = LocalStatusProducer.get(this).state.value
        homeHasRecords = (local.active?.records ?: 0) > 0 || (local.sourcePending ?: 0) > 0
        firstUse = MoteNavigation.isFirstUse(loadedConfig.hasSyncConnection(), settings.enabled, settings.lastCapture(), homeHasRecords,homeArchiveEmpty)
        page(Page.OVERVIEW, null)
        content.setPadding(dp(16), dp(8), dp(16), dp(28))
        // The plugin owns the home reads and mounted sections; this Activity only routes actions.
        val home = DailyHomePlugin.owner(this)
        homePlugin = home
        homeSections?.close()
        val sections = home.sections()
        homeSections = sections
        // Look at the top, act at the bottom: one shared status notice here, Ask and quick records in the thumb zone.
        homeNoticeRow = home.noticeRow(this, open = ::openHomeNotice, act = ::runHomeNotice)
        content.addView(homeNoticeRow, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) })
        if (!loadedConfig.hasSyncConnection() && !settings.enabled) homeNoticeRow.bind(HomeNotice.connect())
        // H08: waiting calendar items and existing discoveries lead the home list in the
        // shared row style; the feed below groups recent originals by day. Neither block
        // takes a position when its plugin has nothing to show.
        val workDiscovery = NativeWorkDiscoveryPlugin.owner(this)
        val workHomeSections = NativeWorkDiscoveryPlugin.homeSections(NativeWorkDiscoveryPlugin.availability(applicationContext))
        if (NativeWorkDiscoveryPlugin.HomeSection.CALENDAR_NEEDS in workHomeSections) {
            workDiscovery.homeCalendarNeeds(this) { startActivity(Intent(this, CalendarActionsActivity::class.java)) }.also {
                sections.add(it); content.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) })
            }
        }
        if (NativeWorkDiscoveryPlugin.HomeSection.DISCOVERY in workHomeSections) {
            workDiscovery.homeDiscovery(this) { id ->
                startActivity(Intent(this,CentralActivity::class.java).putExtra("page","insights").apply{if(id!=null)putExtra("insightId",id)})
            }.also { sections.add(it); content.addView(it) }
        }
        val feed = home.feed(this, archiveEmpty = { empty ->
            homeArchiveEmpty = empty
            firstUse = MoteNavigation.isFirstUse(loadedConfig.hasSyncConnection(),settings.enabled,settings.lastCapture(),homeHasRecords,empty)
        }) { original, origin ->
            startActivity(Intent(this, CaptureRecordsActivity::class.java)
                .putExtra("recordId", original.id).putExtra("directReader", true).putExtra("recordRemote", original.remote)
                .putExtra("recordOrigin", origin).putExtra("recordDeviceId", original.deviceId)
                .putExtra("recordSource", original.source).putExtra("recordDate", original.day))
        }
        sections.add(feed)
        content.addView(feed)
        sections.show()
    }

    private fun buildManagement() {
        val local = LocalStatusProducer.get(this).state.value
        page(Page.MANAGE, null)
        content.setPadding(dp(16), 0, dp(16), dp(28))
        designHeading(MoteI18n.text("我的 Mote"))
        val navigationGroup = menuGroup(0)
        addGroupRow(navigationGroup, menuOption(MoteI18n.text("资料与记忆"), MoteGlyph.LIBRARY) { showPage(Page.LIBRARY) })
        addGroupRow(navigationGroup, menuOption(MoteI18n.text("发现历史"), MoteGlyph.PULSE) { openCentral("insights") })
        addGroupRow(navigationGroup, menuOption(MoteI18n.text("日程与待办"), MoteGlyph.CALENDAR) {
            startActivity(Intent(this, CalendarActionsActivity::class.java))
        })
        val captureGroup = menuGroup(24)
        val screenTrailing = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        manageScreenSwitch = MoteComponents.switch(this, checked = false, description = MoteI18n.text("屏幕采集")) { on -> setScreenCapture(on) }
        screenTrailing.addView(manageScreenSwitch)
        manageScreenPermission = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            visibility = View.GONE
        }
        manageScreenPermission.addView(TextView(this).apply {
            text = MoteI18n.text("等待采集权限")
            MoteUi.type(this, NativeFontRole.BODY)
            MoteUi.textColor(this, NativeColorRole.WARNING)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) })
        manageScreenPermission.addView(MoteComponents.smallButton(this, MoteI18n.text("处理")) {
            val action = ManageMenu.screenPermissionAction(loadedConfig.effectiveMode() == "projection")
            runCaptureAction(action)
        }, LinearLayout.LayoutParams(-2, dp(48)))
        screenTrailing.addView(manageScreenPermission)
        addGroupRow(captureGroup, MoteComponents.row(this, MoteGlyph.SCREEN, MoteI18n.text("屏幕采集"),
            trailing = screenTrailing, verticalPaddingDp = 0).apply { tag = "menu:屏幕采集" })
        manageSendSwitch = MoteComponents.switch(this, checked = false, description = MoteI18n.text("发送")) { changeSendPause() }
        addGroupRow(captureGroup, MoteComponents.row(this, MoteGlyph.SEND, MoteI18n.text("发送"),
            trailing = manageSendSwitch, verticalPaddingDp = 0).apply { tag = "menu:发送" })
        addGroupRow(captureGroup, menuOption(MoteI18n.text("采集与同步"), MoteGlyph.REFRESH) {
            startActivity(Intent(this, SourcesActivity::class.java))
        })
        val moreGroup = menuGroup(24)
        addGroupRow(moreGroup, menuOption(MoteI18n.text("设置"), MoteGlyph.GEAR) { showPage(Page.SETTINGS) })
        addGroupRow(moreGroup, MoteComponents.row(this, MoteGlyph.GLOBE, MoteI18n.text("中央工作台"),
            trailing = MoteComponents.icon(this, MoteGlyph.EXTERNAL, NativeColorRole.MUTED, 16),
            onClick = { openCentral("overview") }).apply { tag = "menu:中央工作台" })
        refreshManageMenu()
        // Operational inventory remains available under capture and sync, outside the light home/menu.
        ensurePage(Page.SOURCES)
        content = (pages.getValue(Page.SOURCES) as ScrollView).getChildAt(0) as LinearLayout
        val pageContent = content
        val summary = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        content.addView(summary, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
        val details = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE; tag = "home-status-details" }
        val toggle = TextView(this).apply {
            text = MoteI18n.text("查看状态与操作"); MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.ACCENT)
            minHeight = dp(48); gravity = Gravity.CENTER; setPadding(dp(12), 0, 0, 0); isFocusable = true
            setOnClickListener { details.visibility = if (details.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        }
        summary.addView(toggle, LinearLayout.LayoutParams(-2, -2))
        content.addView(details); content = details
        try {
            homeSyncDetailStatus = text("", NativeFontRole.SUPPORT, NativeColorRole.MUTED)
            syncStatus = homeSyncDetailStatus
            homeSyncRate = text("", NativeFontRole.META, NativeColorRole.MUTED)
            centralConnectionTitle = text(MoteI18n.text("正在检查…"), NativeFontRole.ROW)
            centralConnectionStatus = text("", NativeFontRole.SUPPORT, NativeColorRole.MUTED)
            rowButtons(MoteI18n.text("立即同步"), { retrySync() }, MoteI18n.text("连接设置"), { showPage(Page.CONNECTION) })

            button(MoteI18n.text("发送中的内容")) { startActivity(Intent(this, SyncQueueActivity::class.java)) }

            captureTitle = text(MoteI18n.text("采集已暂停"), NativeFontRole.ROW)
            status = text(settings.message(), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
            captureProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { isIndeterminate = true; visibility = View.GONE }
            content.addView(captureProgress)
            captureAction = button(MoteI18n.text("开始采集"), primary = !settings.enabled) { if (settings.enabled) stopCapture() else startCapture() }

            homeSourceList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            content.addView(homeSourceList)
            button(MoteI18n.text("来源管理")) { showPage(Page.SOURCES) }
            todaySummary = text(local.imageLabel(), NativeFontRole.META, NativeColorRole.MUTED)
            totalsStatus = text("", NativeFontRole.META, NativeColorRole.MUTED)
            button(MoteI18n.text("活动")) { showPage(Page.ACTIVITY) }
            button(MoteI18n.text("中央工作台")) {
                startActivity(Intent(this, CentralActivity::class.java).putExtra("page", "overview"))
            }
        } finally { content = pageContent }
    }

    internal fun addContent(action: MoteAddAction) {
        when (action) {
            MoteAddAction.FOLDER, MoteAddAction.FILE -> startActivity(Intent(this, FileTaskActivity::class.java).putExtra("addAction", action.name))
            MoteAddAction.SCREEN -> showPage(Page.PRIVACY)
            MoteAddAction.NOTE -> openRecordEditor()
            MoteAddAction.FEISHU -> openCentral("lark")
        }
    }

    private fun changeSendPause() {
        if (uiTask.busy) { refreshManageMenu(); return }
        uiTask.start(MoteI18n.text("正在保存发送状态…"), {}, {
            SendPauseControl.set(applicationContext, !Settings(applicationContext).read().syncPaused)
            Settings(applicationContext).read()
        }) { result ->
            result.onSuccess { current -> loadedConfig = current; commitSettingsSummaries(current); refreshStatus() }
                .onFailure {
                    refreshManageMenu()
                    toast(it.message ?: MoteI18n.text("保存或调度失败，请重试；已保存内容不会丢失"))
                }
        }
    }

    private fun setScreenCapture(on: Boolean) {
        if (applyingSettings || uiTask.busy) { refreshManageMenu(); return }
        if (on) {
            if (!settings.enabled) {
                refreshManageMenu()
                showPage(Page.PRIVACY)
            } else if (settings.screenPausedAt() != null) {
                resumeCapture()
            } else if (!loadedConfig.screenCollectionEnabled) {
                val next = loadedConfig.copy(screenCollectionEnabled = true)
                changeRuntimeConfig(next) {
                    if (next.effectiveMode() == "projection" && !ProjectionService.running) requestProjectionConsent()
                }
            }
        } else if (settings.enabled && loadedConfig.screenCollectionEnabled) {
            pauseScreenCapture()
        } else if (loadedConfig.screenCollectionEnabled) {
            changeRuntimeConfig(loadedConfig.copy(screenCollectionEnabled = false))
        }
    }

    private fun refreshManageMenu() {
        if (!::manageScreenSwitch.isInitialized) return
        val live = loadedConfig.screenCollectionEnabled &&
            (if (loadedConfig.effectiveMode() == "projection") ProjectionService.running else CaptureAccessibilityService.connected)
        val state = ManageMenu.state(settings.enabled, loadedConfig.screenCollectionEnabled, live, loadedConfig.syncPaused)
        manageScreenSwitch.setChecked(state.screenOn)
        manageSendSwitch.setChecked(state.sendOn)
        manageScreenSwitch.visibility = if (state.screenPermission) View.GONE else View.VISIBLE
        manageScreenPermission.visibility = if (state.screenPermission) View.VISIBLE else View.GONE
    }

    private fun menuGroup(topMarginDp: Int): LinearLayout {
        val group = MoteComponents.group(this)
        content.addView(group, LinearLayout.LayoutParams(-1, -2).apply { if (topMarginDp > 0) topMargin = dp(topMarginDp) })
        return group
    }

    private fun addGroupRow(group: LinearLayout, row: View) {
        if (group.childCount > 0) group.addView(MoteComponents.divider(this))
        group.addView(row)
    }

    private fun menuOption(label: String, glyph: MoteGlyph, action: () -> Unit): View =
        MoteComponents.row(this, glyph, label, onClick = { action() }).apply {
            tag = "menu:$label"
            contentDescription = label
        }

    private fun changeRuntimeConfig(next: CollectorConfig, onApplied: () -> Unit = {}) {
        if (applyingSettings || uiTask.busy) return
        applyingSettings = true
        RuntimeSettings.apply(this, next, expected = loadedConfig) { result ->
            applyingSettings = false
            result.onSuccess { loadedConfig = next; commitSettingsSummaries(next); refreshStatus(); loadHomeContent(); onApplied() }
                .onFailure { toast(it.message ?: MoteI18n.text("保存或调度失败，请重试；已保存内容不会丢失")) }
        }
    }

    private fun loadHomeContent() {
        homeSections?.refresh()
        if (!::homeSourceList.isInitialized || homeTask.busy || currentPage !in setOf(Page.OVERVIEW, Page.MANAGE, Page.SOURCES)) return
        val home = homePlugin ?: return
        homeTask.start("", {}, {
            val store = applicationContext.localSources()
            val sources = store.sources().map { source ->
                val sourceState = store.state(source.id)
                val state = if (source.binaryFiles()) applicationContext.fileArchives().state(source.id).put("status", sourceState.optString("status")) else sourceState
                source to state.apply {
                    if (source.tree && source.binaryFiles()) {
                        put("folderProgress", LocalContentPresentation.folderStatus(applicationContext, source))
                        val progress = applicationContext.fileArchives().progress(source)
                        put("fileTransferring", progress.count(FileSyncPhase.PREPARING) + progress.count(FileSyncPhase.UPLOADING) > 0)
                    }
                }
            }
            val captures = home.captures(LocalStatusProducer.get(applicationContext).state.value.revision.records,
                applicationContext.recordDraftStore().draft(),
                pendingRecovery = { QueueStorage(applicationContext).stageRecoveryPending() }) {
                HomeLocalCaptures.exists(
                    queue = { applicationContext.queue() },
                    committedProbe = { QueueStorage(applicationContext).committedStored() })
            }
            Triple(sources, captures, applicationContext.localFileContents(3))
        }) { result ->
            result.onSuccess { (sources, capturePage, files) ->
                navigation.updateDraft(capturePage.optBoolean("hasDraft"))
                // Unknown inventory must not invent an empty archive/first-use handoff, but it
                // must still let independently readable drafts and source rows reach Home.
                homeHasRecords = capturePage.isNull("hasAnyRecords") || capturePage.getBoolean("hasAnyRecords") || files.isNotEmpty() || sources.any { it.first.syncContinuously }
                firstUse = MoteNavigation.isFirstUse(loadedConfig.hasSyncConnection(), settings.enabled, settings.lastCapture(), homeHasRecords,homeArchiveEmpty)
                val sourceSignature = home.sourceSignature(sources.filter { it.first.syncContinuously }.map { (source, state) ->
                    Triple(source.id, source.name, LocalContentPresentation.sourceStatus(source, state) + state.optString("folderProgress").takeIf { it.isNotBlank() }?.let { "\n" + it }.orEmpty())
                })
                if (home.sourcesChanged(sourceSignature)) {
                homeSourceList.removeAllViews()
                if (sources.none { it.first.syncContinuously }) homeSourceList.addView(TextView(this).apply { text = MoteI18n.text("尚未添加文件夹。添加后可在这里查看范围和状态。"); MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED) })
                sources.filter { it.first.syncContinuously }.forEach { (source, state) ->
                    addContentRow(homeSourceList, source.name, LocalContentPresentation.sourceStatus(source, state) + state.optString("folderProgress").takeIf { it.isNotBlank() }?.let { "\n" + it }.orEmpty(), "source:" + source.id) {
                        startActivity(Intent(this, SourcesActivity::class.java).putExtra("sourceId", source.id))
                    }
                }
                }


            }.onFailure { /* Local inventory failure must not erase independently loaded conversations. */ }
        }
    }

    private fun addContentRow(parent: LinearLayout, title: String, detail: String, identity: String, icon: String = "library", provenance: String = "", action: () -> Unit) {
        parent.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.TOP
            background = MoteUi.clickable(this@MainActivity)
            setPadding(dp(12), dp(14), dp(12), dp(14)); isFocusable = true; contentDescription = listOf(title, provenance, detail).filter { it.isNotBlank() }.joinToString("，"); tag = identity
            addView(ImageView(this@MainActivity).apply {
                setImageDrawable(MoteNavigationIcon(this@MainActivity, icon, true)); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                background = MoteUi.shape(this@MainActivity, NativeColorRole.TINT, NativeRadiusRole.INDICATOR, false); setPadding(dp(4), dp(4), dp(4), dp(4))
            }, LinearLayout.LayoutParams(dp(32), dp(32)).apply { marginEnd = dp(12); topMargin = dp(2) })
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(TextView(this@MainActivity).apply { text = title; MoteUi.type(this, NativeFontRole.ROW); MoteUi.textColor(this, NativeColorRole.INK); typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL) })
                if (provenance.isNotBlank()) addView(TextView(this@MainActivity).apply { text = provenance; MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(0, dp(5), 0, 0) })
                addView(TextView(this@MainActivity).apply { text = detail; MoteUi.type(this, NativeFontRole.SUPPORT); maxLines = if (identity.startsWith("source:")) Int.MAX_VALUE else 3; MoteUi.textColor(this, if (identity.startsWith("library-record:")) NativeColorRole.INK else NativeColorRole.MUTED); setPadding(0, dp(9), 0, 0); setLineSpacing(0f, 1.25f) })
            }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(MoteComponents.icon(this@MainActivity, MoteGlyph.CHEV, NativeColorRole.ACCENT, 20),
                LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginStart = dp(8); gravity = Gravity.CENTER_VERTICAL })
            setOnClickListener { action() }
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) })
    }
    private fun addCaptureRow(parent: LinearLayout, item: org.json.JSONObject, remote: Boolean = false, location: String = "", scope: String = "") {
        val note = item.optString("source") == "note"
        val title = item.optString("windowTitle").ifBlank { NativeRecordPreview.text(item) }.ifBlank { item.optString("appName") }.ifBlank { MoteI18n.text(if (note) "记录" else "采集记录") }
        val timestamp = runCatching { java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT).withLocale(resources.configuration.locales[0]).withZone(java.time.ZoneId.systemDefault()).format(java.time.Instant.parse(item.getString("capturedAt"))) }.getOrDefault(item.optString("capturedAt"))
        val source = item.optString("source")
        val recordingLength = item.optLong("durationMs", 0).takeIf { source == "media" && it > 0 }?.let { millis ->
            val seconds = millis / 1000
            "%d:%02d".format(seconds / 60, seconds % 60)
        }
        val kind = MoteI18n.text(when (source) {
            "note" -> when {
                item.optString("windowTitle").matches(Regex("(?i).+\\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|zip)$")) -> "文件"
                item.optString("appName").contains('.') -> item.optString("appName")
                else -> "记录"
            }
            "screen" -> if (item.optBoolean("hasImage")) "照片" else "截图"
            "notification" -> "通知"
            "ui_page" -> "网页"
            "media" -> "录音"
            "activity" -> "应用活动"
            "device_event" -> "设备事件"
            else -> "采集记录"
        }) + (recordingLength?.let { " $it" }.orEmpty())
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; minimumHeight = dp(60); setPadding(dp(14), dp(10), dp(14), dp(10))
            background = MoteUi.clickable(this@MainActivity, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
            isFocusable = true; tag = "library-record:" + item.getString("id"); contentDescription = listOf(title, timestamp, kind, location).filter(String::isNotBlank).joinToString("，")
            addView(TextView(this@MainActivity).apply { text = title; MoteUi.type(this, NativeFontRole.ROW, medium = true); MoteUi.textColor(this, NativeColorRole.INK); maxLines = 2 })
            addView(TextView(this@MainActivity).apply { text = "$timestamp · $kind"; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED) })
        }
        row.setOnClickListener {
            startActivity(Intent(this, CaptureRecordsActivity::class.java).putExtra("recordId", item.getString("id")).putExtra("directReader",true).putExtra("recordVersion", dev.mote.collector.plugins.NativeLibraryPlugin.version(item)).putExtra("recordObservationCount", dev.mote.collector.plugins.NativeLibraryPlugin.observations(item)).putExtra("recordRemote", remote).putExtra("recordOrigin", scope).putExtra("recordDeviceId", item.optString("deviceId")).putExtra("recordSource", item.optString("source")).putExtra("recordDate", java.time.Instant.parse(item.getString("capturedAt")).atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString()))
        }
        parent.addView(row)
    }

    private fun buildLibrary() {
        page(Page.LIBRARY, null)
        content.setPadding(dp(20), dp(6), dp(20), dp(28))
        val heading = designHeading(MoteI18n.text("资料与记忆"))
        heading.setPadding(0, 0, 0, 0)
        (heading.layoutParams as LinearLayout.LayoutParams).bottomMargin = dp(10)
        val materials = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        content.addView(LibraryBrowseUi.tabs(this, "materials") { value -> if (value == "memories") openCentral("memories") }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) })
        content.addView(materials)
        libraryView = LibraryCaptureView(this, materials, libraryState,
            { parent, item, remote, location, scope -> addCaptureRow(parent, item, remote, location, scope) })
    }
    private fun openCentral(page: String) { startActivity(Intent(this, CentralActivity::class.java).putExtra("page", page)) }

    private fun loadLocalLibrary() { libraryView?.refresh() }

    private fun buildSettings() {
        page(Page.SETTINGS, null)
        content.setPadding(dp(16), 0, dp(16), dp(28))
        designHeading(MoteI18n.text("设置"))
        val connectionGroup = menuGroup(0)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
            minimumHeight = dp(64); setPadding(dp(14), dp(9), dp(14), dp(9))
            tag = "menu:连接与设备"; isFocusable = true
            background = MoteUi.clickable(this@MainActivity, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
            setOnClickListener { showPage(Page.CONNECTION) }
        }
        card.addView(MoteComponents.mark(this), LinearLayout.LayoutParams(dp(28), dp(28)).apply { marginEnd = dp(12) })
        card.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val title = TextView(this@MainActivity).apply {
                MoteUi.type(this, NativeFontRole.BODY, medium = true)
                MoteUi.textColor(this, NativeColorRole.INK)
                maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
                tag = "row-detail"
            }
            settingsConnectionTitle = title
            addView(title)
            val subtitle = TextView(this@MainActivity).apply {
                MoteUi.type(this, NativeFontRole.META)
                MoteUi.textColor(this, NativeColorRole.MUTED)
                maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(0, dp(1), 0, 0)
            }
            settingsConnectionDetail = subtitle
            addView(subtitle)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        card.addView(MoteComponents.icon(this, MoteGlyph.CHEV, NativeColorRole.MUTED, 16),
            LinearLayout.LayoutParams(dp(16), dp(16)).apply { marginStart = dp(12) })
        settingsConnectionRow = card
        addGroupRow(connectionGroup, card)

        val choices = menuGroup(24)
        addGroupRow(choices, settingsOption(MoteI18n.text("外观与语言")) { showPage(Page.APPEARANCE) })
        addGroupRow(choices, settingsOption(MoteI18n.text("备份与恢复")) { startActivity(Intent(this, BackupActivity::class.java)) })
        addGroupRow(choices, settingsOption(MoteI18n.text("诊断与支持")) { showPage(Page.DIAGNOSTICS) })

        val about = menuGroup(24)
        addGroupRow(about, settingsOption(MoteI18n.text("关于与更新"), BuildConfig.VERSION_NAME.substringBefore('-')) { showPage(Page.ABOUT) })
        renderSettingsSummaries()
    }

    private fun CollectorConfig.settingsSummary() = SettingsSummaryConfig(server, syncPaused)

    private fun renderSettingsSummaries() {
        if (!::loadedConfig.isInitialized) return
        val state = settingsSummaries.state
        val fallback = when (state) {
            SettingsSummaryState.Loading -> MoteI18n.text("正在读取本机设置…")
            SettingsSummaryState.Unavailable -> MoteI18n.text("暂不可读取")
            is SettingsSummaryState.Current -> null
        }
        val config = (state as? SettingsSummaryState.Current)?.config
        val server = fallback ?: centralHost(config!!.server)
        val detail = loadedConfig.deviceName
        settingsConnectionTitle?.text = server
        settingsConnectionDetail?.text = detail
        settingsConnectionRow?.contentDescription = listOf(MoteI18n.text("连接与设备"), server, detail.takeIf { fallback == null })
            .filterNotNull().joinToString("，")
    }

    private fun commitSettingsSummaries(config: CollectorConfig) {
        settingsSummaries.committed(config.settingsSummary())
        renderSettingsSummaries()
    }

    private fun settingsOption(label: String, value: String? = null, action: () -> Unit): View =
        MoteComponents.row(this, null, label, value = value, onClick = { action() }).apply {
            tag = "menu:$label"
            contentDescription = listOfNotNull(label, value).joinToString("，")
        }

    private fun designHeading(label: String): TextView = TextView(this).apply {
        text = label
        MoteUi.type(this, NativeFontRole.TITLE_MOBILE)
        MoteUi.textColor(this, NativeColorRole.INK)
        setPadding(dp(4), dp(2), 0, 0)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(18) }
        content.addView(this)
    }

    private fun buildAppearance() {
        page(Page.APPEARANCE,null)
        content.setPadding(dp(20),dp(28),dp(20),dp(28))
        text(MoteI18n.text("外观"),NativeFontRole.SUPPORT)
        val appearances = AppearancePreference.entries
        val appearance = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity,android.R.layout.simple_spinner_dropdown_item,listOf(MoteI18n.text("浅色"),MoteI18n.text("深色"),MoteI18n.text("跟随系统")))
            setSelection(appearances.indexOf(MoteAppearance.preference()))
        }
        content.addView(appearance,LinearLayout.LayoutParams(-1,dp(44)).apply { bottomMargin = dp(22) })
        appearance.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (appearances[position] != MoteAppearance.preference()) runCatching { MoteAppearance.select(this@MainActivity,appearances[position]) }
                    .onFailure { toast(MoteI18n.text("无法保存外观偏好，请重试。")) }
            }
        }
        text(MoteI18n.text("界面语言"),NativeFontRole.SUPPORT)
        val languages = listOf("system","zh-CN","en","ja","fr","de","es","ru")
        val language = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity,android.R.layout.simple_spinner_dropdown_item,listOf(MoteI18n.text("跟随系统"),"中文","English","日本語","Français","Deutsch","Español","Русский"))
            setSelection(languages.indexOf(MoteI18n.preference()).coerceAtLeast(0))
        }
        content.addView(language,LinearLayout.LayoutParams(-1,dp(44)).apply { bottomMargin = dp(20) })
        language.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (languages[position] != MoteI18n.preference()) { MoteI18n.select(this@MainActivity,languages[position]); recreate() }
            }
        }
        text(MoteI18n.text("切换只影响界面，已有输入、附件和授权保留。"),NativeFontRole.SUPPORT,NativeColorRole.MUTED)
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
        page(Page.SOURCES, null)
        section(MoteI18n.text("已支持的来源"))
        menu(MoteI18n.text("屏幕与应用活动"), MoteI18n.text("采集来源、频率与电量策略"), "capture") { showPage(Page.CAPTURE) }
        menu(MoteI18n.text("按应用配置"), MoteI18n.text("采集内容、可用能力与字段规则"), "shield") { showPage(Page.PRIVACY) }
        menu(MoteI18n.text("导入文件"), MoteI18n.text("选择文件"), "folder") { addContent(MoteAddAction.FILE) }
        menu(MoteI18n.text("同步文件夹"), MoteI18n.text("选择文件夹"), "folder") { addContent(MoteAddAction.FOLDER) }
        menu(MoteI18n.text("日历与文件"), MoteI18n.text("连接日历、选择文件或授权目录"), "folder") { startActivity(Intent(this, SourcesActivity::class.java)) }
        menu(MoteI18n.text("中央来源"), MoteI18n.text("连接与同步"), "sync") { openCentral("sources") }
        menu(MoteI18n.text("同步与上传"), MoteI18n.text("当前任务与上传历史"), "sync") { startActivity(Intent(this, SyncQueueActivity::class.java)) }
    }

    private fun buildConnection(config: CollectorConfig) {
        page(Page.CONNECTION, null)
        content.setPadding(dp(16), 0, dp(16), dp(28))
        designHeading(MoteI18n.text("连接与设备"))
        val facts = menuGroup(0)
        connectionCentralValue = connectionRow(facts, MoteI18n.text("中央"))
        connectionPermissionValue = connectionRow(facts, MoteI18n.text("权限"))
        connectionTimeValue = connectionRow(facts, MoteI18n.text("连接时间"))

        text(MoteI18n.text("设备名称"), NativeFontRole.SUPPORT, NativeColorRole.MUTED).apply {
            (layoutParams as LinearLayout.LayoutParams).topMargin = dp(22)
            (layoutParams as LinearLayout.LayoutParams).bottomMargin = dp(8)
        }
        name = MoteUi.field(EditText(this)).apply {
            setText(config.deviceName)
            hint = MoteI18n.text("设备名称")
            contentDescription = MoteI18n.text("设备名称")
            isSingleLine = true; isSaveEnabled = false
            filters = arrayOf(android.text.InputFilter.LengthFilter(128))
            layoutParams = LinearLayout.LayoutParams(-1, dp(MoteTheme.controlHeight))
        }
        content.addView(name)
        track(name, "设备名称")

        val actions = menuGroup(24)
        if (config.hasSyncConnection()) {
            connectionDisconnectAction = connectionActionRow(MoteI18n.text("断开连接"), danger = true) { confirmDisconnect() }
            addGroupRow(actions, connectionDisconnectAction!!)
        } else {
            connectionConnectAction = connectionActionRow(MoteI18n.text("连接你的 Mote"), danger = false) {
                discardPageDraft()
                startActivity(Intent(this, ConnectionActivity::class.java))
            }
            addGroupRow(actions, connectionConnectAction!!)
        }
        renderConnectionPage()
    }

    private fun connectionRow(group: LinearLayout, label: String): TextView {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
            minimumHeight = dp(MoteTheme.controlHeight); setPadding(dp(14), 0, dp(14), 0)
        }
        row.addView(TextView(this).apply { text = label; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK) },
            LinearLayout.LayoutParams(0, -2, 1f))
        val value = TextView(this).apply {
            MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.MUTED)
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
        }
        row.addView(value, LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(12) })
        addGroupRow(group, row)
        return value
    }

    private fun connectionActionRow(label: String, danger: Boolean, action: () -> Unit): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isBaselineAligned = false
            minimumHeight = dp(MoteTheme.controlHeight); setPadding(dp(14), 0, dp(14), 0)
            isFocusable = true; contentDescription = label; tag = "connection-action:$label"
            background = MoteUi.clickable(this@MainActivity, NativeColorRole.TRANSPARENT, NativeRadiusRole.CONTAINER, false)
            setOnClickListener { action() }
        }
        row.addView(TextView(this).apply {
            text = label; MoteUi.type(this, NativeFontRole.BODY)
            MoteUi.textColor(this, if (danger) NativeColorRole.DANGER else NativeColorRole.INK)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        return row
    }

    private fun renderConnectionPage() {
        if (!::name.isInitialized) return
        val config = loadedConfig
        val connected = config.hasSyncConnection()
        connectionCentralValue?.text = centralHost(config.server)
        connectionPermissionValue?.text = when {
            !connected -> MoteI18n.text("尚未连接")
            ConnectionClient(applicationContext).scope() == "owner" -> MoteI18n.text("本人设备")
            else -> MoteI18n.text("采集权限")
        }
        connectionTimeValue?.text = if (!connected) MoteI18n.text("尚未连接") else connectionTimeLabel(ConnectionClient(applicationContext).statusAt())
        connectionConnectAction?.visibility = if (connected) View.GONE else View.VISIBLE
        connectionDisconnectAction?.visibility = if (connected) View.VISIBLE else View.GONE
    }

    private fun centralHost(server: String): String {
        if (server.isBlank()) return MoteI18n.text("尚未连接")
        val uri = runCatching { java.net.URI(server) }.getOrNull()
        val host = uri?.host?.takeIf(String::isNotBlank) ?: return server.trim()
        val port = uri.port
        return if (port > 0 && port != 80 && port != 443) "$host:$port" else host
    }

    private fun connectionTimeLabel(at: Long): String {
        if (at <= 0) return MoteI18n.text("暂不可读取")
        val time = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault())
        val locale = MoteI18n.locale()
        return if (time.year == java.time.LocalDate.now().year && MoteI18n.language() in setOf("zh-CN", "ja"))
            DateTimeFormatter.ofPattern("M月d日", locale).format(time)
        else DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale).format(time)
    }

    private fun confirmDisconnect() {
        MoteDialogBuilder(this).setTitle(MoteI18n.text("断开连接"))
            .setMessage(MoteI18n.text("断开连接后停止发送，已有记录保留在本机。"))
            .setNegativeButton(MoteI18n.text("取消"), null)
            .setPositiveButton(MoteI18n.text("断开连接")) { _, _ ->
                changeRuntimeConfig(loadedConfig.copy(server = "", token = "", authSignedOut = true)) {
                    toast(MoteI18n.text("已断开连接，已有记录保留在本机"))
                    showPage(Page.SETTINGS)
                }
            }.show()
    }

    private fun buildCapture(config: CollectorConfig) {
        page(Page.CAPTURE, MoteI18n.text("在记录密度、清晰度和耗电之间找到平衡"))
        button(MoteI18n.text("编辑采集来源说明")) { CaptureContextDialog(this).show() }
        section(MoteI18n.text("采集来源"))
        screenCollectionEnabled = sourceCheck("采集屏幕与前台应用活动", config.screenCollectionEnabled)
        notificationCollectionEnabled = sourceCheck("采集通知（正文、持续状态与更新）", config.notificationCollectionEnabled)
        deviceEventCollectionEnabled = sourceCheck("采集亮屏、熄屏与锁定 / 解锁事件", config.deviceEventCollectionEnabled)
        help(MoteI18n.text("通知与设备事件说明"), MoteI18n.text("通知与设备事件可独立开启，通过系统通知服务观察，按同步策略上传。通知遵循应用规则：仅活动不读取正文，不记录会完全跳过。系统可能隐藏敏感内容；熄屏不等同于锁定。"))
        mediaCollectionEnabled = sourceCheck("采集媒体播放状态（需通知使用权）", config.mediaCollectionEnabled)
        help(MoteI18n.text("媒体采集说明"), MoteI18n.text("媒体采集可单独开启，在前台、后台和锁屏时观察播放器公开的状态、应用及曲目/章节信息；不录音、不控制播放。普通通知由单独的通知采集开关控制。使用本机页的开始/暂停控制采集。媒体沿用应用隐私规则、电量限制和同步策略；关闭元数据会同时暂停媒体。"))
        mediaStatus = text(MoteI18n.text("媒体状态正在读取…"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
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
        interval = sourcePresetNumber("采集间隔 / 秒", config.intervalSeconds, "30", 5..300, listOf(5, 15, 30, 60, 120, 300))
        projectionMode = sourceCheck("使用投屏模式（只截图，每次需授权）", config.mode == "projection")
        help(MoteI18n.text("截图模式说明"), MoteI18n.text("默认无障碍采集支持页面字段与截图回退。选择投屏会同时改为只截图，锁屏/被杀后必须重新授权。Android 10 截图请选投屏模式。"))
        section(MoteI18n.text("电量策略"))
        chargingOnly = sourceCheck("仅充电时采集屏幕、活动和媒体", config.chargingOnly)
        batteryBelow = sourcePresetNumber("低于此电量暂停 / % · 0 为关闭", config.batteryPauseBelowPct, "0", 0..95, listOf(0, 10, 15, 20, 30, 50))
        section(MoteI18n.text("更多采集设置"))
        menu(MoteI18n.text("图像质量与去重"), MoteI18n.text("清晰度与图片去重"), "capture") { showPage(Page.PROCESSING) }
        menu(MoteI18n.text("本机存储"), MoteI18n.text("上传后保留时间、空间上限与保存位置"), "folder") { showPage(Page.STORAGE) }
    }
    private fun buildStorage(config: CollectorConfig) {
        page(Page.STORAGE, MoteI18n.text("保留你需要回看的本机副本"))
        menu(MoteI18n.text("图片保存位置"), MoteI18n.text("选择应用存储空间并迁移已有记录"), "folder") { startActivity(Intent(this, StorageActivity::class.java)) }
        menu(MoteI18n.text("上传历史保存时长"), MoteI18n.text("默认30天，仅清理历史，不删除资料"), "history") { startActivity(Intent(this, UploadHistorySettingsActivity::class.java)) }
        uploadedRetention = sourcePresetNumber("上传后本机保留 / 天（0 为立即清理）", config.uploadedRetentionDays, "7", 0..365, listOf(0, 1, 7, 14, 30, 90, 365))
        maxQueue = sourcePresetNumber("本机存储上限 / MiB", config.maxQueueMiB, "256", 8..4096, listOf(64, 128, 256, 512, 1024, 2048, 4096))
        text(MoteI18n.text("中央确认上传后开始计时，到期自动清理本机副本；中央归档继续保留。未上传和冲突记录不会自动删除。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        menu(MoteI18n.text("导入与导出"), MoteI18n.text("备份配置与本机记录"), "folder") { startActivity(Intent(this, BackupActivity::class.java)) }
        if (!RuntimeProfile.current.developerTools) menu(MoteI18n.text("本机图片批量去重"), MoteI18n.text("全量扫描、对比预览、移入待决定区或删除"), "chart") { startActivity(Intent(this, BulkDedupeActivity::class.java)) }
    }
    private fun buildProcessing(config: CollectorConfig) {
        page(Page.PROCESSING, null)
        jpegQuality = sourceField("JPEG 质量", config.jpegQuality.toString(), "75", InputType.TYPE_CLASS_NUMBER)
        val pageContent=content
        val advanced=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL;visibility=View.GONE;tag="image-processing-advanced:content" }
        imageDedupeMode = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity,android.R.layout.simple_spinner_dropdown_item,listOf(MoteI18n.text("关闭"),MoteI18n.text("精确"),MoteI18n.text("保守"),MoteI18n.text("均衡"),MoteI18n.text("激进")))
            setSelection(imageDedupeModes.indexOf(config.imageDedupeMode).coerceAtLeast(0))
        }
        val choice=button("") {
            val labels=listOf("关闭","相同画面","近似画面")
            MoteDialogBuilder(this).setTitle(MoteI18n.text("采集时图片去重")).setSingleChoiceItems(labels.map { MoteI18n.text(it) }.toTypedArray(),when(imageDedupeMode.selectedItemPosition){0->0;1->1;else->2}) { dialog,which->
                dialog.dismiss()
                if(which<2)imageDedupeMode.setSelection(which)
                else MoteDialogBuilder(this).setTitle(MoteI18n.text("选择近似画面档位")).setSingleChoiceItems(arrayOf(MoteI18n.text("保守"),MoteI18n.text("均衡"),MoteI18n.text("激进")),imageDedupeMode.selectedItemPosition.takeIf { it>=2 }?.minus(2) ?: -1) { preset,index->imageDedupeMode.setSelection(index+2);preset.dismiss() }.setNegativeButton(MoteI18n.text("取消"),null).show()
            }.setNegativeButton(MoteI18n.text("取消"),null).show()
        }.apply { contentDescription=MoteI18n.text("采集时图片去重");tag="image-dedupe-choice" }
        fun choiceLabel(){choice.text=MoteI18n.text("采集时图片去重")+" · "+when(imageDedupeMode.selectedItemPosition){0->MoteI18n.text("关闭");1->MoteI18n.text("相同画面");else->MoteI18n.text("近似画面")+" · "+imageDedupeMode.selectedItem.toString()}}
        track(imageDedupeMode,"imageDedupeMode");val tracked=imageDedupeMode.onItemSelectedListener
        imageDedupeMode.onItemSelectedListener=object:AdapterView.OnItemSelectedListener{
            override fun onNothingSelected(parent:AdapterView<*>?)=Unit
            override fun onItemSelected(parent:AdapterView<*>?,view:View?,position:Int,id:Long){tracked?.onItemSelected(parent,view,position,id);choiceLabel()}
        };choiceLabel()
        text(MoteI18n.text("同一应用最近保存画面对比；近似档可能忽略细小变化。命中时仅记录活动，不复用旧文字。"),NativeFontRole.SUPPORT,NativeColorRole.MUTED)
        processingSave=button(MoteI18n.text("保存设置"),true){saveConfig()}
        menu(MoteI18n.text("图片压缩预览"),MoteI18n.text("质量、文件大小、缩放比例与放大对比"),"chart"){
            @Suppress("DEPRECATION") startActivityForResult(Intent(this,CompressionPreviewActivity::class.java),105)
        }
        imageDedupeDiagnosticsEnabled=sourceCheck("临时保留图片去重对比记录",config.imageDedupeDiagnosticsEnabled)
        text(MoteI18n.text("默认关闭；最多20组、32 MiB、24小时。关闭并保存后清空诊断副本。"),NativeFontRole.SUPPORT,NativeColorRole.MUTED)
        menu(MoteI18n.text("查看图片去重记录"),MoteI18n.text("对比两张图片、分数与依据，可随时清空"),"chart"){startActivity(Intent(this,ImageDedupeDiagnosticsActivity::class.java))}
        menu(MoteI18n.text("本机图片批量去重"),MoteI18n.text("全量扫描、对比预览、移入待决定区或删除"),"chart"){startActivity(Intent(this,BulkDedupeActivity::class.java))}
        button(MoteI18n.text("高级选项")){advanced.visibility=if(advanced.visibility==View.VISIBLE)View.GONE else View.VISIBLE}.tag="image-processing-advanced"
        content.addView(advanced);content=advanced
        captureMaxSide=sourcePresetNumber("图片最长边 / px",config.captureMaxSide,"1280",640..2560,listOf(640,960,1280,1920,2560))
        content.addView(imageDedupeMode,LinearLayout.LayoutParams(-1,dp(56)))
        help(MoteI18n.text("图片去重说明"),MoteI18n.text("与同一应用最近保存的画面比较。重处理前命中时仅记录应用活动，不保存或审查当前图片，也不沿用旧文字。开启图片对比诊断时保留审查后的对比链路。近似档位可能忽略细小变化；重启后重新建立基准。"))
        help(MoteI18n.text("图片对比诊断说明"),MoteI18n.text("默认关闭。开启并保存后，将已去重图片及对比原图临时保存在本机，供核对分数与判断依据。最多 20 组、32 MiB，24 小时后到期；读取时清理，系统可能延后后台清理。关闭并保存后清空。保留的都是通过隐私检查和遮罩后的图片。"))
        content=pageContent
    }

    private fun buildDiagnostics(config: CollectorConfig) {
        page(Page.DIAGNOSTICS,null)
        val logSettings = RuntimeLogSettings(this)
        val logPolicy = logSettings.read()
        section(MoteI18n.text("运行日志"))
        val logEnabled = CheckBox(this).apply {
            text = MoteI18n.text("记录运行日志"); isChecked = logPolicy.enabled
            MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK)
        }
        content.addView(logEnabled)
        text(MoteI18n.text("日志级别"), NativeFontRole.SUPPORT)
        val logLevels = RuntimeLogPolicy.levels
        val logLevel = Spinner(this).apply {
            contentDescription = MoteI18n.text("日志级别")
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, logLevels.map { it.uppercase() })
            setSelection(logLevels.indexOf(logPolicy.level))
        }
        content.addView(logLevel)
        button(MoteI18n.text("保存日志设置")) {
            if (logSettings.save(RuntimeLogPolicy(logEnabled.isChecked, logLevels[logLevel.selectedItemPosition]))) {
                toast(MoteI18n.text("已保存，立即生效。"))
            } else toast(MoteI18n.text("无法持久保存设置，请检查存储空间"))
        }
        text(MoteI18n.text("日志目录") + ": " + noBackupFilesDir.absolutePath, NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        text(MoteI18n.text("日志位于应用私有空间；关闭后停止新增，已有日志保留。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        button(MoteI18n.text("导出日志")) {
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("text/plain").putExtra(Intent.EXTRA_TITLE,"mote.log"),107)
        }
        section(MoteI18n.text("诊断与支持"))
        diagnosticEnabled=sourceCheck("记录数值与事件诊断",config.diagnosticsEnabled)
        text(MoteI18n.text("最多 1440 条数值样本。电量变化是整机变化，不能归因于 Mote。支持包不含截图、正文、笔记、令牌或审查理由。"),NativeFontRole.SUPPORT,NativeColorRole.MUTED)
        button(MoteI18n.text("打开本地日志查看器")){startActivity(Intent(this,LogViewerActivity::class.java))}
        val labels=listOf("最近 1 小时","最近 24 小时","最近 7 天");val hours=listOf(1,24,168)
        lateinit var range:Button
        fun rangeLabel(){range.text=MoteI18n.text("导出时间范围")+" · "+MoteI18n.text(labels[hours.indexOf(logExportHours).coerceAtLeast(0)])}
        range=button(""){MoteDialogBuilder(this).setTitle(MoteI18n.text("导出时间范围")).setSingleChoiceItems(labels.map{MoteI18n.text(it)}.toTypedArray(),hours.indexOf(logExportHours)){dialog,which->logExportHours=hours[which];rangeLabel();dialog.dismiss()}.show()}.apply{contentDescription=MoteI18n.text("导出时间范围");tag="diagnostic-export-range"};rangeLabel()
        text(MoteI18n.text("数值诊断导出保留的全部数值；时间范围用于支持包事件。"),NativeFontRole.SUPPORT,NativeColorRole.MUTED)
        button(MoteI18n.text("导出数值诊断 JSON")){
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE,"mote-diagnostics.json"),103)
        }
        button(MoteI18n.text("导出安全支持包 JSON")){
            @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE,"mote-"+BuildConfig.MOTE_PROFILE+"-support.json"),104)
        }
        diagnosticExportStatus=text("",NativeFontRole.SUPPORT).apply{tag="diagnostic-export-status";visibility=View.GONE;accessibilityLiveRegion=View.ACCESSIBILITY_LIVE_REGION_POLITE}
        val pageContent=content;content=SecondaryUi.disclosure(content,MoteI18n.text("更多"),"diagnostic-details")
        technicalStatus=text(MoteI18n.text("正在读取运行状态…"),NativeFontRole.SUPPORT)
        diagnosticInterval=sourceField("诊断采样间隔 / 秒（15–3600）",config.diagnosticsIntervalSeconds.toString(),"60",InputType.TYPE_CLASS_NUMBER)
        help(MoteI18n.text("数值诊断说明"),MoteI18n.text("仅在应用/采集运行时采样，最多 1440 条。记录整机电量、本机空间、入队/拦截/失败计数、截图隐私审查耗时和上传字节，不包含截图、文字、笔记、令牌或审查理由。电量变化是整机变化，不能归因于 Mote。"))
        help(MoteI18n.text("支持包包含什么"),MoteI18n.text("事件日志最多 500 条，只记录固定阶段、错误类别与数值。支持包不包含节点地址、设备名、截图、笔记、OCR、令牌、提示词或审查理由；关闭诊断后停止新增，已有记录保留。"))
        content=pageContent
    }

    private fun buildNotes() {
        page(Page.NOTES, null)
        val pageContent = content
        val draft = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; background = MoteUi.shape(this@MainActivity, NativeColorRole.SURFACE, NativeRadiusRole.READING); setPadding(dp(16), dp(16), dp(16), dp(4)) }
        pageContent.addView(draft); content = draft
        val app = applicationContext
        val io = QuickNotes.io
        val controller = QuickNotes.controller(app)
        val task = UiTask(this, io, ownsExecutor = false)
        val note = sourceField("正在想什么", "", MoteI18n.text("记下此刻的想法…"), multiline = true)
        fieldLabels[note]?.visibility = View.GONE
        note.contentDescription = MoteI18n.text("正在想什么")
        note.minLines = 4; note.gravity = Gravity.TOP
        note.background = android.graphics.drawable.ColorDrawable(Color.TRANSPARENT)
        note.setPadding(0, dp(8), 0, dp(12)); note.setLineSpacing(0f, 1.25f)
        note.filters = arrayOf(android.text.InputFilter.LengthFilter(100000))
        val progress = text(MoteI18n.text("正在读取草稿…"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        var changingDraft = false
        var readable = false
        fun replace(value: NoteDraft) {
            changingDraft = true; note.setText(value.text); changingDraft = false
        }
        fun editable(value: Boolean) { note.isEnabled = value }
        val draftWatcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                if (!changingDraft && readable) {
                    controller.autosave(note.text.toString(), "")
                    progress.text = MoteI18n.text("正在保存草稿…")
                }
            }
        }
        note.addTextChangedListener(draftWatcher)
        // Persistence is independent of this Activity; only the lightweight observer stops on pause.
        val draftPoll = object : Runnable {
            override fun run() {
                if (isDestroyed) return
                if (resumed && !task.busy) controller.persistence()?.let {
                    progress.text = if (it.succeeded) MoteI18n.text("草稿已保存") else MoteI18n.text("草稿保存失败，请保持页面打开并检查可用空间")
                }
                handler.postDelayed(this, 500)
            }
        }
        notePoll = draftPoll; if (resumed) handler.post(draftPoll)
        editable(false)
        task.start(MoteI18n.text("正在读取草稿…"), { progress.text = it }, { controller.read() }) { result ->
            result.onSuccess { replace(it); readable = true; editable(true); progress.text = MoteI18n.text("草稿已载入") }
                .onFailure { progress.text = MoteI18n.text("草稿读取失败，原文件保留。明确点击新建才清除旧草稿。") }
        }
        button(MoteI18n.text("保存记录"), true) {
            if (!task.busy && readable) {
                val value = note.text.toString() to ""
                editable(false)
                task.start(MoteI18n.text("正在保存记录…"), { progress.text = it }, { controller.save(value.first, value.second) }) { result ->
                    editable(true); controller.clearPersistence()
                    result.onSuccess { replace(NoteDraft()); controller.clearPersistence(); progress.text = MoteI18n.text("记录已保存；同步按你的设置运行"); refreshStatus() }
                        .onFailure { progress.text = it.message ?: MoteI18n.text("记录保存失败，草稿已保留") }
                }
            }
        }
        button(MoteI18n.text("新建一条 · 清除草稿")) {
            if (!task.busy) MoteDialogBuilder(this).setTitle(MoteI18n.text("清除当前草稿？")).setMessage(MoteI18n.text("此操作仅清除正在编辑的本机草稿。已保存的记录不受影响。"))
                .setNegativeButton(MoteI18n.text("继续编辑"), null).setPositiveButton(MoteI18n.text("清除并新建")) { _, _ ->
                    if (!task.busy) {
                        editable(false)
                        task.start(MoteI18n.text("正在清除草稿…"), { progress.text = it }, { controller.clear() }) { result ->
                            result.onSuccess { replace(NoteDraft()); controller.clearPersistence(); readable = true; progress.text = MoteI18n.text("可以开始新记录") }
                                .onFailure { progress.text = MoteI18n.text("草稿清除失败") }
                            editable(readable)
                        }
                    }
                }.show()
        }
        content = pageContent
        text(MoteI18n.text("图片与语音附件"), NativeFontRole.SUPPORT, NativeColorRole.ACCENT).apply {
            minHeight = dp(48); gravity = Gravity.CENTER_VERTICAL; isFocusable = true
            contentDescription = MoteI18n.text("在中央记录中添加附件")
            setOnClickListener { openCentral("notes") }
        }
        text(MoteI18n.text("草稿自动保存在本机，保存后按同步设置上传。正文最多 100000 字符，心情最多 80 字符。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
    }

    private fun buildPrivacy(config: CollectorConfig) {
        page(Page.PRIVACY, null)
        val appConfigurationContent = content
        val appOverview = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        content.addView(appOverview); content = appOverview
        captureRangeState = text(MoteI18n.text(if (settings.enabled) "正在本机采集" else "采集已暂停"),NativeFontRole.TITLE_MOBILE).apply { tag = "capture-range-state" }
        text(MoteI18n.text("应用时长、截图与结构化内容分别选择。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        val appRules = AppCollectionRules.parse(config.appCollectionRules)
        val appDefaults = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        appDefaultSummary = button(MoteI18n.text("未单独配置的应用：{0}", appModeLabel(appRules.defaultMode))) {
            appDefaults.visibility = if (appDefaults.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }.apply { tag = "app-default-summary"; MoteUi.action(this,MoteUi.ButtonRole.TEXT); gravity = Gravity.START or Gravity.CENTER_VERTICAL }
        content.addView(appDefaults)
        val defaultOwner = content; content = appDefaults
        appDefaultDuration = sourceCheck("默认：应用时长", appRules.defaultMode.duration)
        appDefaultScreenshots = sourceCheck("默认：截图", appRules.defaultMode.screenshots)
        appDefaultStructured = sourceCheck("默认：结构化内容", appRules.defaultMode.structured)
        text(MoteI18n.text("默认方式适用于没有单独设置的应用，也适用于以后安装的应用。修改后点击保存生效。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        content = defaultOwner
        listOf(appDefaultDuration, appDefaultScreenshots, appDefaultStructured).forEach { choice ->
            choice.setOnCheckedChangeListener { _, _ ->
                appDefaultSummary.text = MoteI18n.text("未单独配置的应用：{0}", appModeLabel(AppCollectionMode.fromChoices(appDefaultDuration.isChecked, appDefaultScreenshots.isChecked, appDefaultStructured.isChecked)))
                updateSaveBar(); renderAppRules()
            }
        }
        content = appConfigurationContent
        val heading = lightControl(MoteI18n.text("按应用设置"),MoteI18n.text("系统权限")) { showPage(Page.PERMISSIONS) }
        heading.first.visibility = View.GONE
        val appEditorHost = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; content.addView(appEditorHost)
        val globalSettings = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; content.addView(globalSettings); content = globalSettings
        var advancedPrivacyExpanded = false
        var captureExtrasExpanded = false
        var captureExtras: View? = null
        var captureExtrasToggle: View? = null
        val regular = content
        val rawRules = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        button(MoteI18n.text("高级：手工编辑包名规则")) { rawRules.visibility = if (rawRules.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        regular.addView(rawRules); content = rawRules
        excludes = sourceField("不采集的应用包名（每行一个或逗号分隔）", config.excludedPackages, "com.example.private", multiline = true)
        appPolicies = sourceField("应用选项（每行 包名=采集选项）", appRules.apps.entries.joinToString("\n") { "${it.key}=${it.value.wire}" }, "com.example.chat=activity\ncom.example.private=off", multiline = true)
        appPolicies.filters = arrayOf(android.text.InputFilter.LengthFilter(32768))
        text(AppCollectionMode.entries.joinToString("\n") { "${it.wire}：${appModeLabel(it)}" }, NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        content = regular
        val rulesWatcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) { renderAppRules() }
        }
        appPolicies.addTextChangedListener(rulesWatcher); excludes.addTextChangedListener(rulesWatcher)
        section(MoteI18n.text("开启前预览"))
        text(MoteI18n.text("保存范围后开始，系统权限按需申请。拒绝授权不影响文件和记录。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        button(MoteI18n.text("预览当前配置的记录格式")) {
            val candidate = runCatching { draft().also { it.validate() } }.getOrElse { toast(it.message ?: MoteI18n.text("请检查设置")); return@button }
            showCapturePreview(candidate)
        }
        button(MoteI18n.text("保存并预览"), true) { saveConfig(after = { showCapturePreview(loadedConfig) }) }
        val startRange = button(MoteI18n.text("保存范围并开始记录"), true) {
            saveConfig {
                if (!loadedConfig.screenCollectionEnabled) changeRuntimeConfig(loadedConfig.copy(screenCollectionEnabled = true)) { startCapture() }
                else startCapture()
            }
        }
        menu(MoteI18n.text("权限与后台运行"), MoteI18n.text("保存后授权，再回本机开始采集"), "settings") { showPage(Page.PERMISSIONS) }
        metadataEnabled = sourceCheck("上传设备与采集状态元数据", config.metadataEnabled)
        text(MoteI18n.text("开启后附带实际系统/机型、采集器版本、语言/时区、电量/充电、网络类型、锁屏与可用空间；不取设备序列号、IMEI、MAC、SSID或定位。关闭只影响新记录和心跳，已入队内容不追溯修改。授权文件来源自身的大小/修改时间不受此开关影响。"), NativeFontRole.SUPPORT)
        text(MoteI18n.text("没有内置应用黑名单。配置排除后，无法识别应用、多个应用窗口或系统遮挡时暂停。投屏模式需要同时启用无障碍服务才能可靠执行排除；仅使用情况权限不足以保证所有可见窗口。"), NativeFontRole.SUPPORT)
        section(MoteI18n.text("页面采集方式"))
        text(MoteI18n.text("端侧提取可见字段，中央组织资料和活动。每个应用分别选择截图和结构化内容。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        text(MoteI18n.text("结构化字段规则按应用和版本匹配，仅在该应用已选择结构化内容时运行。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        uiPageMode=Spinner(this).apply {
            adapter=ArrayAdapter(this@MainActivity,android.R.layout.simple_spinner_dropdown_item,listOf(MoteI18n.text("只截图"),MoteI18n.text("页面优先，未取得内容时截图")))
            setSelection(if (config.uiPageMode == "screen_only") 0 else 1)
        }; uiPageMode.visibility = View.GONE
        text(MoteI18n.text("截图和结构化内容独立执行，解析结果不改变截图选择。投屏模式不支持结构化内容。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        val ruleEditor = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        button(MoteI18n.text("高级：查看或编辑全部页面规则")) { ruleEditor.visibility = if (ruleEditor.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        content.addView(ruleEditor)
        val pageOwner = content; content = ruleEditor
        uiPageRules=sourceField("页面规则 JSON",config.uiPageRules,"[]",multiline=true)
        text(MoteI18n.text("字段规则需要匹配实际应用版本与控件 ID；配置匹配不代表已经通过真机验证。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        content = pageOwner
        localContentOcr = sourceCheck("使用本机 OCR 补充结构化内容", config.localContentOcr)
        localContentOcr.setOnCheckedChangeListener { _, _ -> updateSaveBar(); renderAppRules() }
        uiPageRules.addTextChangedListener(rulesWatcher)
        appCaptureEditor = dev.mote.collector.plugins.SystemEntriesPlugin.appCaptureEditor(this,
            snapshot = { runCatching { AppCapturePresentation.Snapshot(currentAppRules(), PrivacyRules.exclusions(excludes.text.toString()), uiPageRules.text.toString(),
                loadedConfig.mode == "projection", localContentOcr.isChecked) }.getOrNull() },
            change = { id, mode ->
                val rules = currentAppRules(); val selected = rules.apps.toMutableMap()
                if (mode == null) selected.remove(id) else selected[id] = mode
                excludes.setText(PrivacyRules.exclusions(excludes.text.toString()).filterNot { it == id }.joinToString("\n"))
                appPolicies.setText(selected.entries.joinToString("\n") { "${it.key}=${it.value.wire}" })
            },
            preview = { id -> runCatching { draft().also { it.validate() } }.onSuccess { showCapturePreview(it, appId = id) }.onFailure { toast(it.message ?: MoteI18n.text("请检查设置")) } },
            editRule = { id, version -> editAppPageRule(id, version) { renderAppRules() } },
            loadRules = { id, version -> loadAppPageRules(id, version) },
            importRules = { id, version ->
                if (version.isBlank()) toast(MoteI18n.text("无法读取应用版本，请重新选择已安装应用"))
                else { pageRuleImportTarget = id to version
                    @Suppress("DEPRECATION") startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE), 106) }
            }, detailChanged = { detail ->
                appOverview.visibility = if (detail) View.GONE else View.VISIBLE
                globalSettings.visibility = if (!detail && advancedPrivacyExpanded) View.VISIBLE else View.GONE
                captureExtras?.visibility = if (!detail && captureExtrasExpanded) View.VISIBLE else View.GONE
                captureExtrasToggle?.visibility = if (detail) View.GONE else View.VISIBLE
                startRange.visibility = if(detail)View.GONE else View.VISIBLE
            })
        appEditorHost.addView(appCaptureEditor)
        text(MoteI18n.text("仅对已选择结构化内容的应用启用。截图关闭时，临时像素只在本机识别后释放，不保存、不上传图片。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        section(MoteI18n.text("固定遮罩"))
        text(MoteI18n.text("拖动示意图添加矩形；绿色区域会在 OCR 和保存前被遮住。这里不会读取你的屏幕。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        val maskFields = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        val mainContent = content; content.addView(maskFields); content = maskFields
        masks = sourceField("固定遮罩（每行 left,top,right,bottom）", config.masks, "0,0,1,0.08", multiline = true)
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
        gateEnabled = sourceCheck("启用文字规则审查", config.uploadGate.enabled)
        gateText = sourceField("禁止上传的文字（每行一个，精确包含匹配）", config.uploadGate.blockedText, "", multiline = true)
        gateFailure = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("暂存待复核（默认）"), MoteI18n.text("不保存、不上传"), MoteI18n.text("允许上传")))
            setSelection(listOf("hold", "drop", "allow").indexOf(config.uploadGate.failureAction).coerceAtLeast(0))
        }
        content.addView(gateFailure); track(gateFailure, "gateFailure")
        text(MoteI18n.text("文字规则适用于截图、页面和通知；截图文字仅在本机用于审查，完整内容识别由中央执行。待复核记录请在同步恢复中逐条处理；更改规则不会自动释放旧记录。"), NativeFontRole.SUPPORT)
        val reviewSettings = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        val privacyContent = content
        button(MoteI18n.text("高级：截图文字隐私审查")) { reviewSettings.visibility = if (reviewSettings.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        privacyContent.addView(reviewSettings); content = reviewSettings
        text(MoteI18n.text("截图文字隐私审查引擎"), NativeFontRole.BODY)
        ocrMode = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("中文与拉丁文（单引擎）"), MoteI18n.text("仅拉丁文"), MoteI18n.text("双引擎（高质量）")))
            setSelection(OcrPolicy.modes.indexOf(config.ocrMode).coerceAtLeast(0))
        }
        content.addView(ocrMode); track(ocrMode, "ocrMode")
        ocrAppModes = sourceField("按应用指定隐私审查引擎（JSON）", config.ocrAppModes, "{}")
        text(MoteI18n.text("可填写包名到 chinese、latin 或 dual 的映射；未指定的应用使用上方模式。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        text(MoteI18n.text("隐私审查使用本机识别。只有另行选择本机 OCR 补充时，识别文字才会作为结构化内容保存；截图按独立选择执行。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        content = appConfigurationContent
        globalSettings.visibility = View.GONE
        val extras = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        captureExtras = extras
        captureExtrasToggle = MoteUi.action(button(MoteI18n.text("资料说明与其他设置")) { captureExtrasExpanded = !captureExtrasExpanded; extras.visibility = if (captureExtrasExpanded) View.VISIBLE else View.GONE },MoteUi.ButtonRole.TEXT).apply { gravity = Gravity.START or Gravity.CENTER_VERTICAL }
        content.addView(extras); content = extras
        text(MoteI18n.text(if (config.mode == "projection") "采集方式：投屏模式" else "采集方式：无障碍模式"),NativeFontRole.META,NativeColorRole.MUTED)
        val actions = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        actions.addView(MoteUi.action(Button(this).apply { text = MoteI18n.text("编辑采集来源说明"); setOnClickListener { CaptureContextDialog(this@MainActivity).show() } },MoteUi.ButtonRole.TEXT),LinearLayout.LayoutParams(0,-2,1f))
        actions.addView(MoteUi.action(Button(this).apply { text = MoteI18n.text("通知与设备信息"); setOnClickListener { showObservations() } },MoteUi.ButtonRole.TEXT),LinearLayout.LayoutParams(0,-2,1f))
        content.addView(actions)
        (localContentOcr.parent as ViewGroup).removeView(localContentOcr); localContentOcr.text = MoteI18n.text("本机 OCR 补充"); content.addView(localContentOcr)
        text(MoteI18n.text("仅对已选结构化内容的应用生效。截图关闭时，临时像素识别后释放；截图按独立选择保存和发送。"),NativeFontRole.META,NativeColorRole.MUTED)
        content.addView(appCaptureEditor.advancedFilters())
        MoteUi.action(button(MoteI18n.text("高级采集设置")) { advancedPrivacyExpanded = !advancedPrivacyExpanded; globalSettings.visibility = if (advancedPrivacyExpanded) View.VISIBLE else View.GONE },MoteUi.ButtonRole.TEXT)
        (globalSettings.parent as ViewGroup).removeView(globalSettings); content.addView(globalSettings)
        content = appConfigurationContent
        (startRange.parent as ViewGroup).removeView(startRange); content.addView(startRange)
    }

    private fun requestedPage(value: String): Page? = if (value in setOf("CAPTURE","OBSERVATIONS")) Page.PRIVACY else Page.entries.find { it.name == value }

    private fun showObservations() {
        if (applyingSettings || uiTask.busy) return
        val expected = loadedConfig
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20),dp(12),dp(20),dp(20)) }
        fun choice(label: String, detail: String, enabled: Boolean): CheckBox {
            val value = CheckBox(this).apply { text = label; isChecked = enabled; MoteUi.type(this,NativeFontRole.SUPPORT); MoteUi.textColor(this,NativeColorRole.INK); minHeight = dp(44) }
            body.addView(value)
            body.addView(TextView(this).apply { text = detail; MoteUi.type(this,NativeFontRole.META); MoteUi.textColor(this,NativeColorRole.MUTED); setPadding(dp(32),0,0,dp(10)) })
            return value
        }
        val notifications = choice(MoteI18n.text("通知内容"),MoteI18n.text("仅在系统通知使用权已授权后采集。"),expected.notificationCollectionEnabled)
        val events = choice(MoteI18n.text("设备事件"),MoteI18n.text("设备状态与活动线索。"),expected.deviceEventCollectionEnabled)
        val media = choice(MoteI18n.text("正在播放的信息"),MoteI18n.text("公开的标题与播放状态，不录音、不控制播放。"),expected.mediaCollectionEnabled)
        val dialog = MoteDialogBuilder(this).setTitle(MoteI18n.text("通知与设备信息")).setView(body)
            .setNegativeButton(MoteI18n.text("取消"),null).setPositiveButton(MoteI18n.text("保存选择"),null).create()
        dialog.setOnShowListener {
            MoteUi.action(dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE),MoteUi.ButtonRole.PRIMARY)
            dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if (applyingSettings || uiTask.busy) return@setOnClickListener
                if (loadedConfig != expected) { toast(MoteI18n.text("配置或相关操作状态已变化，请重新读取后再确认。")); return@setOnClickListener }
                applySettings(expected.copy(notificationCollectionEnabled = notifications.isChecked,deviceEventCollectionEnabled = events.isChecked,mediaCollectionEnabled = media.isChecked),
                    expected = expected,appliedFields = emptySet(),submitted = baseline,saved = { dialog.dismiss() })
            }
        }
        dialog.show()
    }


    private fun buildDeveloper(config: CollectorConfig) {
        page(Page.DEVELOPER, MoteI18n.text("用于排查问题和调整本机高级行为"))
        menu(MoteI18n.text("诊断与支持"), MoteI18n.text("运行状态、数值采样与安全支持包"), "chart") { showPage(Page.DIAGNOSTICS) }
        menu(MoteI18n.text("图片压缩预览"), MoteI18n.text("质量、文件大小、缩放比例与放大对比"), "chart") {
            @Suppress("DEPRECATION") startActivityForResult(Intent(this, CompressionPreviewActivity::class.java), 105)
        }
        section(MoteI18n.text("调试连接"))
        http = sourceCheck("允许调试局域网 HTTP（明文，仅私有 IP）", config.debugHttp).apply { isEnabled = BuildConfig.DEBUG }
        section(MoteI18n.text("构建与运行环境"))
        text(MoteI18n.text("环境：{0} · {1}\n私有数据目录：{2}", BuildConfig.MOTE_PROFILE, packageName, noBackupFilesDir.absolutePath), NativeFontRole.META, NativeColorRole.MUTED)
        if (BuildConfig.MOTE_PROFILE == "dev") text(MoteI18n.text("开发版与日常 Mote 独立安装，权限、设备 ID、令牌、草稿、队列和模型互不共享。默认测试端口 47842；模拟器使用 adb reverse tcp:47842 tcp:47842。"), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
    }

    private fun buildAbout() {
        page(Page.ABOUT, MoteI18n.text("Mote · 让经历留有线索"))
        card(NativeColorRole.TINT) {
            text("Mote · ${RuntimeProfile.current.name}", NativeFontRole.TITLE).apply { tag = "about-build-profile" }
            text(MoteI18n.text("你的个人上下文档案"), NativeFontRole.BODY)
            text(MoteI18n.text("版本 {0}", BuildConfig.VERSION_NAME), NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        }
        menu(MoteI18n.text("应用更新"), MoteI18n.text("检查新版本与安装更新"), "sync") { startActivity(Intent(this, AppUpdatesActivity::class.java)) }
        if (RuntimeProfile.current.developerTools) menu(MoteI18n.text("开发者选项"), MoteI18n.text("诊断、采集排查与构建信息"), "settings") { showPage(Page.DEVELOPER) }
        settingsRow(MoteI18n.text("反馈"),MoteI18n.text("前往 GitHub，可附图片或诊断包")) { openFeedback() }
        text("Android ${Build.VERSION.RELEASE} / API ${Build.VERSION.SDK_INT} · ${Build.MANUFACTURER} ${Build.MODEL}", NativeFontRole.META, NativeColorRole.MUTED)
    }

    private fun buildPermissions() {
        page(Page.PERMISSIONS, null)
        content.setPadding(dp(20),dp(28),dp(20),dp(28))
        section(MoteI18n.text("采集权限"))
        permissionRow("无障碍截图",MoteI18n.text("无障碍截图服务")) {
            MoteDialogBuilder(this).setTitle(MoteI18n.text("屏幕采集权限说明"))
                .setMessage(getString(R.string.accessibility_description) + MoteI18n.text("\n\n继续后请在系统设置中选择 Mote 屏幕采集。启用服务本身不会开始截图，仍需回到此处点击开始。"))
                .setNegativeButton(MoteI18n.text("取消"),null).setPositiveButton(MoteI18n.text("打开系统设置")) { _, _ -> safeOpen(Intent(SystemSettings.ACTION_ACCESSIBILITY_SETTINGS)) }.show()
        }
        permissionRow("通知使用权",MoteI18n.text("通知使用权：读取通知与媒体会话")) { mediaPermission() }
        permissionRow("通知",MoteI18n.text("通知提醒：显示运行通知")) { notifications() }
        permissionRow("使用情况",MoteI18n.text("使用情况访问")) { safeOpen(Intent(SystemSettings.ACTION_USAGE_ACCESS_SETTINGS)) }
        card(NativeColorRole.TINT) {
            text(MoteI18n.text("投屏会话"),NativeFontRole.SUPPORT)
            permissionBadges["投屏会话"] = text("",NativeFontRole.META,NativeColorRole.MUTED).apply { tag = "permission-detail" }
        }
        section(MoteI18n.text("后台运行"))
        permissionRow("电池优化",MoteI18n.text("电池优化设置")) { safeOpen(Intent(SystemSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        permissionRow("自启动",MoteI18n.text("自启动设置")) { autostart() }
        settingsRow(MoteI18n.text("应用详情 / 受限制设置"),MoteI18n.text("侧载应用可能需允许受限制设置")) { safeOpen(detailsIntent()) }
        help(MoteI18n.text("HyperOS 帮助"),MoteI18n.text("小米 / HyperOS：在系统应用设置中允许 Mote 自启动，将省电策略设为无限制，并允许通知；可在最近任务中锁定应用。菜单随系统版本变化。若侧载 APK 的无障碍开关受限，请在应用详情的菜单中检查“允许受限制的设置”。这些设置不能保证系统永不终止采集。") + "\n\n" + MoteI18n.text("HyperOS 通知使用权：请按需打开实时、对话、通知、静音类别。旧版曾禁用这些类别；更新后若仍是灰色，可关闭再重新授予通知使用权。类别和应用级开关会影响可接收的事件。"))
        text(MoteI18n.text("授权后仍需明确开始。"),NativeFontRole.SUPPORT,NativeColorRole.MUTED)
        projectionButton = button(MoteI18n.text("返回采集范围")) { showPage(Page.PRIVACY) }
        if (permissionReturnPage != Page.PRIVACY) button(MoteI18n.text("返回原配置页面")) { showPage(permissionReturnPage) }
    }

    private fun permissionRow(key: String, label: String, action: () -> Unit) {
        val row = settingsRow(label,MoteI18n.text("正在检查系统权限…"),action = action)
        val labels = row.getChildAt(0) as LinearLayout
        permissionBadges[key] = (labels.getChildAt(1) as TextView).apply { tag = "permission-detail" }
    }

    private fun permissionStatus(name: String) {
        permissionBadges[name] = text(MoteI18n.text(name) + " · " + MoteI18n.text("正在检查系统权限…"), NativeFontRole.BODY).apply {
            setPadding(dp(12), dp(9), dp(12), dp(9))
            layoutParams = (layoutParams as LinearLayout.LayoutParams).apply { bottomMargin = dp(5) }
        }
    }

    private fun setPermissionStatus(name: String, status: String, allowed: Boolean?) {
        permissionBadges[name]?.apply {
            text = if (tag == "permission-detail") status else MoteI18n.text(name) + " · " + status
            if (tag == "permission-detail") { MoteUi.textColor(this,NativeColorRole.MUTED); return@apply }
            MoteUi.textColor(this, if (allowed == true) NativeColorRole.SUCCESS else NativeColorRole.WARNING)
            background = MoteUi.shape(this@MainActivity, if (allowed == true) NativeColorRole.SUCCESS_TINT else NativeColorRole.WARNING_TINT, NativeRadiusRole.CONTAINER)
        }
    }

    private fun updatePermissionStatuses() {
        if (permissionBadges.isEmpty()) return
        val accessibility = runCatching { SystemSettings.Secure.getString(contentResolver, SystemSettings.Secure.ENABLED_ACCESSIBILITY_SERVICES)?.split(':')?.any { ComponentName.unflattenFromString(it) == ComponentName(this, CaptureAccessibilityService::class.java) } == true }.getOrDefault(false)
        val notifications = getSystemService(NotificationManager::class.java).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
        val media = MediaCollection.permissionAllowed(this)
        val usage = ForegroundApps.usageAllowed(this)
        val power = runCatching { getSystemService(android.os.PowerManager::class.java).isIgnoringBatteryOptimizations(packageName) }.getOrDefault(false)
        setPermissionStatus("无障碍截图", if (!accessibility) MoteI18n.text("未授权") else if (CaptureAccessibilityService.connected) MoteI18n.text("已授权 · 服务已连接") else MoteI18n.text("已授权 · 等待系统连接服务"), if (!accessibility) false else if (CaptureAccessibilityService.connected) true else null)
        setPermissionStatus("通知使用权", if (media) MoteI18n.text("已授权") else MoteI18n.text("未授权"), media)
        setPermissionStatus("投屏会话", if (ProjectionService.running) MoteI18n.text("本次会话正在运行") else MoteI18n.text("尚无投屏会话。需要时返回采集页发起系统同意。"), if (ProjectionService.running) true else null)
        projectionButton.text = MoteI18n.text("返回采集范围")
        setPermissionStatus("通知", if (notifications) MoteI18n.text("已允许") else MoteI18n.text("未允许"), notifications)
        setPermissionStatus("使用情况", if (usage) MoteI18n.text("已授权") else MoteI18n.text("未授权"), usage)
        setPermissionStatus("电池优化", if (power) MoteI18n.text("已豁免") else MoteI18n.text("未豁免") + " · " + MoteI18n.text("系统可能限制后台运行"), if (power) true else null)
        setPermissionStatus("自启动", MoteI18n.text("系统未提供可靠查询，请在系统设置确认。"), null)
    }

    private fun retrySync() {
        val app = applicationContext
        uiTask.start(MoteI18n.text("正在提交同步任务…"), { syncStatus.text = it }, {
            ConnectionGuard.sync {
                val c = Settings(app).read()
                if (!c.hasSyncConnection()) false else {
                    c.validateConnection()
                    if (app.localSources().sources().any { it.enabled }) dev.mote.collector.plugins.SourceProviderPlugin.owner(app).schedule(manual = true, syncExplicit = true)
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
            deviceName = checked(name) { name.text.toString().trim().also { require(it.isNotBlank() && it.length <= 128) { MoteI18n.text("请填写 1..128 字符的设备名称") } } })
        Page.CAPTURE -> current.copy(
            intervalSeconds = number(interval, 5..300), mode = if (projectionMode.isChecked) "projection" else "accessibility",
            uiPageMode = if (projectionMode.isChecked) "screen_only" else current.uiPageMode,
            chargingOnly = chargingOnly.isChecked, batteryPauseBelowPct = number(batteryBelow, 0..95),
            mediaCollectionEnabled = mediaCollectionEnabled.isChecked, screenCollectionEnabled = screenCollectionEnabled.isChecked,
            notificationCollectionEnabled = notificationCollectionEnabled.isChecked, deviceEventCollectionEnabled = deviceEventCollectionEnabled.isChecked)
        Page.STORAGE -> current.copy(maxQueueMiB = number(maxQueue, 8..4096), uploadedRetentionDays = number(uploadedRetention, 0..365))
        Page.PROCESSING -> current.copy(
            jpegQuality = number(jpegQuality, 40..95), captureMaxSide = number(captureMaxSide, 640..2560),
            imageDedupeMode = imageDedupeModes[imageDedupeMode.selectedItemPosition], imageDedupeDiagnosticsEnabled = imageDedupeDiagnosticsEnabled.isChecked)
        Page.PRIVACY -> current.copy(
            localContentOcr = localContentOcr.isChecked, uiPageMode=current.uiPageMode, uiPageRules=checked(uiPageRules){uiPageRules.text.toString().also{UiPageRules.parse(it)}},
            excludedPackages = excludes.text.toString(), masks = checked(masks) { masks.text.toString().also { Mask.parse(it) } },
            appCollectionRules = checked(appPolicies) { currentAppRules().json() },
            ocrMode = OcrPolicy.modes[ocrMode.selectedItemPosition], ocrAppModes = checked(ocrAppModes) { ocrAppModes.text.toString().also { OcrPolicy.validate(OcrPolicy.modes[ocrMode.selectedItemPosition], it) } },
            metadataEnabled = metadataEnabled.isChecked, uploadGate = UploadGateConfig(gateEnabled.isChecked, gateText.text.toString(), listOf("hold", "drop", "allow")[gateFailure.selectedItemPosition]))
        Page.DIAGNOSTICS -> current.copy(diagnosticsEnabled = diagnosticEnabled.isChecked, diagnosticsIntervalSeconds = number(diagnosticInterval, 15..3600))
        Page.DEVELOPER -> current.copy(debugHttp = http.isChecked)
        else -> current
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
    private fun saveConfig(bindLocal: Boolean = false, after: () -> Unit = {}): Unit {
        if (applyingSettings || uiTask.busy) return
        val current = loadedConfig
        val c = runCatching { draft(current).let { if (it.token != current.token || it.server != current.server) it.copy(authSignedOut = false, authExpiresAt = 0, authProcess = "") else it }.also { it.validate() } }.getOrElse { toast(it.message ?: MoteI18n.text("请检查配置输入")); return }
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
                    if (result.getOrNull() == false) RuntimeSettings.apply(app, c, bindLocal, expected = current, confirmCentralEndpoint = "${Page.CONNECTION.name}:节点 URL（可留空，仅在本机记录）" in savedFields) { }
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
        RuntimeSettings.apply(this, config, bindLocal, expected = expected, confirmCentralEndpoint = "${Page.CONNECTION.name}:节点 URL（可留空，仅在本机记录）" in appliedFields) { result ->
            applyingSettings = false
            if (isDestroyed) return@apply
            result.onSuccess {
                // Keep edits made after this save started, including edits on a newly opened page.
                val comparison = if (generation == draftGeneration) submitted else baseline
                val laterEdits = pageControlValues().filter { (key, value) -> comparison[key] != value }
                val current = RuntimeSettings.currentConfiguration ?: loadedConfig
                reloadSettings(current); commitSettingsSummaries(current); restoreControlValues(laterEdits)
                saved(); toast(MoteI18n.text("设置已保存")); resumeProjectionAfterSettings()
            }.onFailure {
                RuntimeSettings.currentConfiguration?.let { if (it != loadedConfig) { reloadSettings(it); commitSettingsSummaries(it) } }
                toast(it.message ?: MoteI18n.text("设置未保存，请重试"))
            }
            updateSaveBar(); refreshStatus()
        }
    }
    private fun startCapture() {
        if (ConnectionGuard.changing() || RuntimeSettings.stopping) { toast(MoteI18n.text("正在连接节点，请稍后再开始采集")); return }
        if (settings.enabled) { toast(MoteI18n.text("已启用，状态见上方")); return }
        val next = runCatching { draft().also { it.validate() } }.getOrElse { toast(it.message ?: MoteI18n.text("请检查设置")); return }
        fun previewThenStart() {
            showCapturePreview(loadedConfig, firstStart = true)
        }
        if (next == loadedConfig) previewThenStart() else saveConfig(after = { previewThenStart() })
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
            if (Build.VERSION.SDK_INT < 30 && (c.collectionRules.mayCollectScreenshots() || c.localContentOcr && c.collectionRules.mayCollectStructured())) { toast(MoteI18n.text("Android 10 内容截图请勾选投屏模式；仅活动无需投屏")); return }
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
            ConnectionGuard.startCapture(applicationContext, config.captureStamp()) {
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
        projectionRequestStamp = c.captureStamp()
        @Suppress("DEPRECATION") startActivityForResult(intent, 100)
    }
    private fun resumeProjectionAfterSettings() {
        if (RuntimeSettings.takeProjectionConsentRequest()) startConfiguredCapture()
    }
    @Deprecated("Platform consent result API retained for the minimal native Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode in setOf(71, 72, 73)) {
            if (initializing) pendingCentralResult = Triple(requestCode, resultCode, data)
            else { ensurePage(Page.ASK); centralContent?.activityResult(requestCode, resultCode, data) }
            return
        }
        if (requestCode == 106) {
            if (initializing || !::uiPageRules.isInitialized) { pendingPageRuleResult = resultCode to data; return }
            val target = pageRuleImportTarget; pageRuleImportTarget = null
            if (resultCode != RESULT_OK || data?.data == null || target == null) return
            val uri = data.data!!
            val previousRules = uiPageRules.text.toString()
            uiTask.start(MoteI18n.text("正在读取字段规则…"), { saveHint.text = it }, {
                val imported = contentResolver.openInputStream(uri)?.use { input ->
                    val buffer = ByteArray(1048577); var size = 0
                    while (size < buffer.size) {
                        val count = input.read(buffer, size, buffer.size - size)
                        if (count < 0) break
                        if (count == 0) continue
                        size += count
                    }
                    require(size <= 1048576) { MoteI18n.text("字段规则文件超过大小上限") }
                    buffer.copyOf(size).toString(Charsets.UTF_8)
                } ?: error(MoteI18n.text("字段规则文件不可读取"))
                AppPageSetup.merge(previousRules, imported, target.first, target.second)
            }) { result ->
                result.onSuccess { merged ->
                    if (uiPageRules.text.toString() != previousRules || appVersion(target.first) != target.second) {
                        toast(MoteI18n.text("应用版本或规则草稿已变化，请重新导入"))
                    } else {
                        uiPageRules.setText(merged); uiPageMode.setSelection(uiPageModes.indexOf("ui_preferred"))
                        toast(MoteI18n.text("字段规则已加入草稿；返回后保存生效，应用内容授权未改变"))
                    }
                }.onFailure { toast(it.message ?: MoteI18n.text("字段规则格式无效")) }
            }
            return
        }
        if (requestCode == 105 && resultCode == RESULT_OK && data != null) {
            val quality = data.getIntExtra("quality", 75); val side = data.getIntExtra("maxSide", 1280)
            if (quality in 40..95 && side in 640..2560) {
                showPage(Page.PROCESSING); jpegQuality.setText(quality.toString()); captureMaxSide.setText(side.toString())
                toast(MoteI18n.text("参数已带回采集设置，请点击保存后应用"))
            }
            return
        }
        if (requestCode in setOf(103, 104, 107)) {
            fun feedback(message:String){diagnosticExportStatus?.apply { text=message;visibility=View.VISIBLE }}
            if(resultCode!=RESULT_OK || data?.data==null){feedback(MoteI18n.text("导出已取消，记录与设置保留。"));return}
            val uri = data.data!!; val app = applicationContext; val tools = systemTools
            uiTask.start(MoteI18n.text("正在导出诊断包…"), { feedback(it) }, {
                val body = when (requestCode) {
                    104 -> tools.supportBundle(app, logExportHours)
                    107 -> SupportEvents.runtime(app).exportRange(0, System.currentTimeMillis() + 1).getString("text")
                    else -> tools.diagnostics(app).export()
                }
                app.contentResolver.openOutputStream(uri)!!.use { it.write(body.toByteArray()) }
            }) { result -> feedback(if (result.isSuccess) MoteI18n.text(if (requestCode == 107) "日志已导出。" else "诊断包已导出") else MoteI18n.text("诊断导出失败")) }
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
                    if (stamp == c.captureStamp() && c.screenCollectionEnabled && c.effectiveMode() == "projection" && c.observesSystem() && !ProjectionService.running) {
                        startProjection(); true
                    } else false
                } == true else ConnectionGuard.startCapture(applicationContext, stamp, startProjection)
            }) { result ->
                if (!result.getOrDefault(false)) settings.status(if (settings.enabled) "capturing" else "permission_required", MoteI18n.text("节点或采集配置已变化，本次授权已丢弃；请重新点击开始"))
                refreshStatus()
            }
        } else if (requestCode == 100) settings.status(if (settings.enabled) "capturing" else "permission_required", MoteI18n.text("你未授予投屏权限，未开始截图") + if (settings.enabled) MoteI18n.text("；媒体采集继续运行") else "")
    }
    /** Home, panel and tile requests share one mapping; only resume and restart ask for the preview or system consent. */
    private fun runCaptureAction(action: CaptureOverview.Action) {
        when (action) {
            CaptureOverview.Action.RESUME -> resumeCapture()
            CaptureOverview.Action.RESTART -> if (settings.enabled) requestProjectionConsent() else startCapture()
            CaptureOverview.Action.PERMISSIONS -> showPage(Page.PERMISSIONS)
            CaptureOverview.Action.STORAGE -> showPage(Page.STORAGE)
        }
    }

    /** The row opens the place that explains the state; its one action repairs it. */
    private fun openHomeNotice(notice: HomeNotice) {
        when (val operation = notice.operation) {
            HomeNotice.Operation.Connect -> openConnection()
            is HomeNotice.Operation.Capture -> when (operation.operation) {
                CaptureStatusOperation.RECONNECT -> openConnection()
                CaptureStatusOperation.RESUME_SEND, CaptureStatusOperation.OPEN_SYNC -> startActivity(Intent(this, SyncQueueActivity::class.java))
                else -> startActivity(Intent(this, CaptureStatusActivity::class.java))
            }
        }
    }

    private fun runHomeNotice(notice: HomeNotice) {
        when (val operation = notice.operation) {
            HomeNotice.Operation.Connect -> openConnection()
            is HomeNotice.Operation.Capture -> when (operation.operation) {
                CaptureStatusOperation.RESUME_CAPTURE -> runCaptureAction(CaptureOverview.Action.RESUME)
                CaptureStatusOperation.RESUME_SEND, CaptureStatusOperation.OPEN_SYNC -> startActivity(Intent(this, SyncQueueActivity::class.java))
                CaptureStatusOperation.RECONNECT -> openConnection()
                CaptureStatusOperation.RESTART_CAPTURE -> runCaptureAction(CaptureOverview.Action.RESTART)
                CaptureStatusOperation.OPEN_PERMISSIONS -> showPage(Page.PERMISSIONS)
                CaptureStatusOperation.OPEN_STORAGE -> showPage(Page.STORAGE)
            }
        }
    }

    private fun openConnection() {
        startActivity(Intent(this, ConnectionActivity::class.java).putExtra("firstUse", firstUse))
    }
    private fun resumeCapture() {
        if (ConnectionGuard.changing() || RuntimeSettings.stopping || applyingSettings) { toast(MoteI18n.text("正在应用设置，请稍后重试")); return }
        if (settings.screenPausedAt() == null || loadedConfig.screenCollectionEnabled) { startCapture(); return }
        val base = loadedConfig
        val next = base.copy(screenCollectionEnabled = true)
        showCapturePreview(next, firstStart = true, expected = base) {
            val wasEnabled = settings.enabled
            changeRuntimeConfig(next) {
                settings.screenPaused(null)
                // Applying settings resumes accessibility capture and requests consent for a sole projection source itself.
                if (!wasEnabled) startConfiguredCapture()
                else if (next.effectiveMode() == "projection" && next.observesSystem() && !ProjectionService.running) requestProjectionConsent()
            }
        }
    }
    private fun pauseScreenCapture() {
        if (applyingSettings || uiTask.busy) return
        applyingSettings = true
        dev.mote.collector.plugins.CapturePlugin.controls().pauseScreen(this) { result ->
            applyingSettings = false
            if (isDestroyed) return@pauseScreen
            result.onSuccess { loadedConfig = settings.read(); refreshStatus(); loadHomeContent() }
                .onFailure { toast(it.message ?: MoteI18n.text("保存或调度失败，请重试；已保存内容不会丢失")) }
        }
    }
    private fun takeCaptureAction(source: Intent) {
        val action = source.getStringExtra("captureAction")?.let { name -> CaptureOverview.Action.entries.find { it.name == name } } ?: return
        source.removeExtra("captureAction")
        pagesHost.post { if (!isDestroyed) runCaptureAction(action) }
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
        captureRangeState?.text = MoteI18n.text(if (settings.enabled) "正在本机采集" else "采集已暂停")
        if (!::status.isInitialized) return
        // Capture controls reflect cheap live state before optional statistics/diagnostics.
        // A slow inventory must not make a successful Start look unresponsive.
        val action = if (settings.enabled) MoteI18n.text("暂停采集") else MoteI18n.text("开始采集")
        if (captureAction.text != action) {
            captureAction.text = action
            MoteUi.button(captureAction, primary = !settings.enabled)
            captureTitle.text = if (settings.enabled) MoteI18n.text("正在本机采集") else MoteI18n.text("采集已暂停")
            captureProgress.visibility = if (settings.enabled) View.VISIBLE else View.GONE
            status.text = settings.message()
        }
        if (QueueStorage.recovering) { status.text = MoteI18n.text("正在连接本机存储，文件整理将在后台继续…"); return }
        if (ConnectionGuard.reconfiguring()) { status.text = RuntimeSettings.progressLabel(); updateSaveBar(); saveHint.text = RuntimeSettings.progressLabel(); return }
        if (isDestroyed) return
        if (statusLoading) { statusRefreshPending = true; return }
        statusLoading = true
        val summaryToken = settingsSummaries.token()
        // Queue recovery, Keystore reads and diagnostic writes may wait for a worker.
        // Keep one request in flight; a slow scan must never accumulate refresh jobs.
        statusExecutor.execute {
            val result = runCatching { readStatus() }
            handler.post {
                statusLoading = false
                if (!resumed || isDestroyed || isFinishing) return@post
                if (!settingsSummaries.isCurrent(summaryToken)) {
                    statusRefreshPending = false; refreshStatus(); return@post
                }
                if (QueueStorage.recovering || ConnectionGuard.reconfiguring()) { refreshStatus(); return@post }
                result.onSuccess { snapshot ->
                    snapshot.config?.let { if (!applyingSettings && it != loadedConfig) reloadSettings(it) }
                    if (!applyingSettings && settingsSummaries.readResult(summaryToken, snapshot.config?.settingsSummary())) renderSettingsSummaries()
                    homeSyncDetailStatus.text = snapshot.syncFacts
                    homeSyncRate.text = MoteI18n.text("上传速率") + " · " + UploadMeter.label()
                    refreshManageMenu()
                    renderConnectionPage()
                    homeNoticeRow.bind(snapshot.notice)
                    captureTitle.text = snapshot.title
                    if (captureAction.text != snapshot.action) {
                        captureAction.text = snapshot.action
                        MoteUi.button(captureAction, primary = !settings.enabled)
                    }
                    captureProgress.visibility = if (settings.enabled) View.VISIBLE else View.GONE
                    status.text = snapshot.status
                    totalsStatus.text = snapshot.totals; if (::technicalStatus.isInitialized) technicalStatus.text = snapshot.technical
                    centralConnectionTitle.text = snapshot.connectionTitle; centralConnectionStatus.text = snapshot.connection
                    if (::mediaStatus.isInitialized) mediaStatus.text = snapshot.media
                    updateSaveBar()
                }.onFailure {
                    if (!applyingSettings && settingsSummaries.readResult(summaryToken, null)) renderSettingsSummaries()
                    captureProgress.visibility = View.GONE; status.text = MoteI18n.text("状态暂不可读取，已有记录保留在本机；稍后自动重试")
                }
                if (statusRefreshPending) { statusRefreshPending = false; refreshStatus() }
            }
        }
    }
    private fun readStatus(): StatusSnapshot {
        val c = runCatching { settings.read() }.getOrNull()
        val local = LocalStatusProducer.get(this).state.value
        if (c != null) runCatching { Diagnostics(this).sample(c) }
        val screenLive = c?.screenCollectionEnabled == true && (if (c.effectiveMode() == "projection") ProjectionService.running else CaptureAccessibilityService.connected)
        val systemLive = c?.observesSystem() == true && MediaCollectionService.connected
        val live = screenLive || systemLive
        val missingSource = c != null && (c.screenCollectionEnabled && !screenLive || c.observesSystem() && !systemLive)
        val state = if (settings.enabled && live && missingSource) MoteI18n.text("部分采集来源未连接，请检查权限") else if (settings.enabled && !live) MoteI18n.text("采集服务未连接：请恢复权限") else if (settings.state() == "capturing") MoteI18n.text("正在采集") else settings.message()
        val stats = runCatching { Operations.ledger(this).read().getJSONObject("counts") }.getOrNull()
        val totals = if (stats == null) MoteI18n.text("统计暂不可读取") else MoteI18n.text("本周期累计页面 {0} · 截图 {1} · 应用活动 {2} · 媒体 {3} · 笔记 {4} · 已确认 {5}\n拦截 {6} · 失败 {7} · 重试结果 {8}", stats.optLong("PAGE_QUEUED"), stats.optLong("SCREEN_QUEUED"), stats.optLong("ACTIVITY_QUEUED"), stats.optLong("MEDIA_QUEUED"), stats.optLong("NOTE_QUEUED"), stats.optLong("PAGE_ACK") + stats.optLong("SCREEN_ACK") + stats.optLong("NOTE_ACK") + stats.optLong("ACTIVITY_ACK") + stats.optLong("MEDIA_ACK") + stats.optLong("SYSTEM_EVENT_ACK"), stats.optLong("FRAME_BLOCKED"), stats.optLong("CAPTURE_FAILED") + stats.optLong("ACTIVITY_FAILED") + stats.optLong("MEDIA_FAILED"), stats.optLong("UPLOAD_RETRY"))
        val queueStats = local.active
        val pending = local.pending
        val bytes = queueStats?.quotaBytes?.div(1024.0 * 1024)
        val queueFull = c != null && bytes != null && bytes >= c.maxQueueMiB
        val title = when {
            settings.enabled && !live -> MoteI18n.text("等待采集权限")
            settings.enabled && missingSource -> MoteI18n.text("部分来源等待权限")
            settings.enabled && queueFull -> MoteI18n.text("本机空间已满")
            settings.enabled && settings.state() == "paused" -> MoteI18n.text("采集暂时等待")
            settings.enabled -> MoteI18n.text("正在本机采集")
            else -> MoteI18n.text("采集已暂停")
        }
        val action = if (settings.enabled) MoteI18n.text("暂停采集") else MoteI18n.text("开始采集")
        val syncWait = c?.takeIf { it.hasSyncConnection() }?.let { SyncSchedule.waitingReason(this, it) }
        val syncMessage = when {
            UploadHistoryRecovery.unavailable -> UploadHistoryRecovery.message()
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
            .put("syncState", when { UploadHistoryRecovery.unavailable -> "error"; c == null || !c.hasSyncConnection() -> "unconfigured"; local.error != null || queueStats == null || queueStats.blocked > 0 -> "blocked"; else -> settings.syncState().takeIf { it in setOf("idle", "waiting", "uploading", "error", "paused") } ?: "waiting" })
            .put("errorCode", when { UploadHistoryRecovery.unavailable -> "upload_history_unavailable"; local.error != null || queueStats == null -> "local_state_unavailable"; queueStats.blocked > 0 -> "retained_conflict"; else -> org.json.JSONObject.NULL }))
        val syncQueue = "${pending?.let { MoteI18n.text("待同步 {0} 条", it) } ?: MoteI18n.text("队列暂不可读取")}${bytes?.let { " · ${"%.1f".format(it)} MiB" } ?: ""}"
        val syncFacts = NativeStatus.summary(nativeFacts)
        val syncText = "$syncQueue\n$syncMessage\n$syncFacts"
        val periodTotals = if (stats == null) MoteI18n.text("累计统计暂不可读取") else MoteI18n.text("本周期累计页面 {0}    截图 {1}    活动 {2}    媒体 {3}    记录 {4}\n本周期已同步 {5} 条", stats.optLong("PAGE_QUEUED"), stats.optLong("SCREEN_QUEUED"), stats.optLong("ACTIVITY_QUEUED"), stats.optLong("MEDIA_QUEUED"), stats.optLong("NOTE_QUEUED"), stats.optLong("PAGE_ACK") + stats.optLong("SCREEN_ACK") + stats.optLong("NOTE_ACK") + stats.optLong("ACTIVITY_ACK") + stats.optLong("MEDIA_ACK") + stats.optLong("SYSTEM_EVENT_ACK"))
        val totalsText = periodTotals + if (QueueStorage.maintaining) MoteI18n.text(" · 后台整理中，可正常采集") else ""
        val technicalText = MoteI18n.text("{0}\n{1}\n{2}\n{3}\n无障碍 {4} · 使用情况 {5}\n最近采集 {6}", state, totals, syncText, settings.uploadStatus(), if (CaptureAccessibilityService.connected) MoteI18n.text("已连接") else MoteI18n.text("未连接"), if (ForegroundApps.usageAllowed(this)) MoteI18n.text("已授权") else MoteI18n.text("未授权"), settings.lastCapture() ?: MoteI18n.text("无")) + "\n" + MoteI18n.text("屏幕采集：{0}", settings.screenStatus())
        val connectionState = c?.takeIf { it.hasSyncConnection() }?.let { ConnectionClient(this).status() } ?: "unchecked"
        val connectionTitle = when {
            UploadHistoryRecovery.unavailable -> UploadHistoryRecovery.title()
            c == null || !c.hasSyncConnection() -> MoteI18n.text("未连接中央")
            settings.syncState() == "uploading" -> MoteI18n.text("正在同步中央")
            settings.syncState() == "error" || connectionState !in setOf("connected", "unchecked") -> MoteI18n.text("连接需要处理")
            connectionState == "unchecked" -> MoteI18n.text("已保存节点 · 待验证")
            else -> MoteI18n.text("已连接中央")
        }
        val connectionText = when {
            UploadHistoryRecovery.unavailable -> UploadHistoryRecovery.message()
            c == null || !c.hasSyncConnection() -> MoteI18n.text("记录只保存在本机；连接后按你的策略上传。")
            settings.syncState() == "error" -> settings.uploadStatus()
            pending != null && pending > 0 -> MoteI18n.text("待同步 {0} 条 · 节点：{1}", pending, c.server)
            connectionState == "unchecked" -> MoteI18n.text("节点已保存，但尚未完成最近一次连接验证：{0}", c.server)
            connectionState != "connected" -> MoteI18n.text("采集连接验证未通过，请检查已保存的地址、凭据和网络后重试。")
            else -> MoteI18n.text("节点：{0} · 最近一次验证成功", c.server)
        }
        val captureState = state + if (c?.screenCollectionEnabled == true && settings.enabled) "\n" + MoteI18n.text("屏幕采集：{0}", settings.screenStatus()) else ""
        val notice = c?.let { config ->
            val interrupted = (settings.enabled && (config.screenCollectionEnabled || config.observesSystem()) && !live && !missingSource) ||
                (!settings.enabled && settings.state() in setOf("permission_required", "error"))
            val screenPausedAt = settings.screenPausedAt()?.takeIf { !config.screenCollectionEnabled }
            // The shared row treats `captureLive` as a running capture service: a screen-only pause keeps it true.
            val captureServiceLive = CaptureAccessibilityService.connected || ProjectionService.running || MediaCollectionService.connected || screenPausedAt != null
            runCatching {
                HomeNotice.from(CaptureStatusFacts(
                    connection = when {
                        config.hasSyncConnection() -> CaptureConnection.CONNECTED
                        config.server.isNotBlank() && config.token.isNotBlank() -> CaptureConnection.RECONNECT
                        else -> CaptureConnection.UNCONFIGURED
                    },
                    captureEnabled = settings.enabled || interrupted,
                    captureLive = captureServiceLive,
                    screenPausedAt = screenPausedAt?.let { Instant.ofEpochMilli(it).toString() },
                    permission = if (missingSource) CapturePermission.MISSING else null,
                    storageFull = queueFull && settings.enabled,
                    interrupted = interrupted,
                    syncState = when {
                        !config.hasSyncConnection() -> CaptureSyncState.UNCONFIGURED
                        config.syncPaused -> CaptureSyncState.PAUSED
                        local.error != null || (local.active?.blocked ?: 0) > 0 -> CaptureSyncState.BLOCKED
                        settings.syncState() == "error" -> CaptureSyncState.ERROR
                        settings.syncState() == "uploading" -> CaptureSyncState.UPLOADING
                        settings.syncState() == "waiting" -> CaptureSyncState.WAITING
                        settings.syncState() == "paused" -> CaptureSyncState.PAUSED
                        else -> CaptureSyncState.IDLE
                    },
                    pending = local.pending,
                )).let { notice ->
                    if (notice?.titleKey == "屏幕采集已暂停" && screenPausedAt != null)
                        notice.copy(detail = CaptureOverview.since(screenPausedAt, Instant.now(), ZoneId.systemDefault()))
                    else notice
                }
            }.getOrNull()
        }
        return StatusSnapshot(title, action, captureState, syncText, totalsText, technicalText, connectionTitle, connectionText, MediaCollection.statusLabel(this), c, syncQueue, syncMessage, syncFacts, CaptureOverview.attention(settings.enabled, settings.state(), live, missingSource, queueFull), notice)
    }
    private fun mediaPermission() {
        MoteDialogBuilder(this).setTitle(MoteI18n.text("媒体播放状态授权"))
            .setMessage(MoteI18n.text("Android 通过通知使用权开放通知与媒体会话。开启通知采集后，Mote 会保存应用公开的标题、正文、持续状态以及发布和更新事件，并按同步策略上传。设备事件单独记录亮屏、熄屏和锁定状态。各来源需单独开启并点击开始；应用的“不记录”和“仅活动”规则仍适用。系统可能隐藏敏感通知；Mote 不回复通知、不控制播放。"))
            .setNegativeButton(MoteI18n.text("取消"), null).setPositiveButton(MoteI18n.text("打开系统设置")) { _, _ ->
                safeOpen(Intent(SystemSettings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }.show()
    }
    private fun notifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
        else safeOpen(Intent(SystemSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SystemSettings.EXTRA_APP_PACKAGE, packageName))
    }
    @Deprecated("Platform permission callback")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 101) updatePermissionStatuses()
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
        settingsSummaries.beginRead(); renderSettingsSummaries()
        if (!::settings.isInitialized) return
        resumeUi()
    }
    private fun resumeUi() {
        if (currentPage == Page.LIBRARY) libraryView?.resume()
        if (currentPage == Page.ASK) centralContent?.resume()
        if (currentPage == Page.ACTIVITY) activityContent?.resume()
        notePoll?.let { handler.removeCallbacks(it); handler.post(it) }
        if (currentPage == Page.OVERVIEW) homeSections?.show() else homeSections?.pause()
        loadHomeContent()
        updatePermissionStatuses()
        RuntimeSettings.observeProjectionConsent { if (::name.isInitialized) resumeProjectionAfterSettings() }
        RuntimeSettings.observeConfiguration {
            if (!applyingSettings && !isDestroyed) {
                settingsSummaries.beginRead(); renderSettingsSummaries(); refreshStatus()
            }
        }
        localStateJob = observeLocalState { snapshot ->
            refreshStatus()
            if (::loadedConfig.isInitialized && snapshot.active != null) {
                if (snapshot.active.records > 0 || (snapshot.sourcePending ?: 0) > 0) homeHasRecords = true
                val nextFirstUse = MoteNavigation.isFirstUse(loadedConfig.hasSyncConnection(), settings.enabled, settings.lastCapture(), homeHasRecords,homeArchiveEmpty)
                if (nextFirstUse != firstUse) {
                    firstUse = nextFirstUse
                } else if (::todaySummary.isInitialized) todaySummary.text = snapshot.imageLabel()
            }
            loadHomeContent()
            if (snapshot.revision.records != libraryRecordsRevision) {
                libraryRecordsRevision = snapshot.revision.records
                if (currentPage == Page.LIBRARY) libraryView?.recordsChanged(snapshot.revision.records, snapshot.active?.records?.takeIf { snapshot.error == null })
            }
        }
        handler.post(refresh)
    }
    override fun onPause() {
        resumed = false
        homeSections?.pause()
        centralContent?.pause()
        activityContent?.pause()
        localStateJob?.cancel(); localStateJob = null
        RuntimeSettings.observeProjectionConsent(null); RuntimeSettings.observeConfiguration(null)
        handler.removeCallbacks(refresh); notePoll?.let(handler::removeCallbacks)
        super.onPause()
    }
    override fun onStop() { super.onStop() }
    override fun onDestroy() { homeSections?.close(); homeTask.close(); libraryView?.close(); centralContent?.close(); activityContent?.close(); statusExecutor.shutdownNow(); handler.removeCallbacksAndMessages(null); super.onDestroy() }
    private fun dp(value: Int) = moteDp(value)

    private fun help(title: String, message: String) {
        text(title, NativeFontRole.ACTION, NativeColorRole.ACCENT).apply {
            moteGlyph(MoteGlyph.CHEV, NativeColorRole.ACCENT)
            minHeight = dp(MoteTheme.controlHeight); gravity = Gravity.CENTER_VERTICAL; isFocusable = true
            setOnClickListener { MoteDialogBuilder(this@MainActivity).setTitle(title).setMessage(message).setPositiveButton(MoteI18n.text("知道了"), null).show() }
        }
    }
    private fun page(page: Page, subtitle: String?) {
        buildingPage = page
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(MoteTheme.spacePage), dp(if (page == Page.OVERVIEW) 4 else MoteTheme.spacePage), dp(MoteTheme.spacePage), dp(28)) }
        val scroll = ScrollView(this).apply {
            isFillViewport = true; clipToPadding = false; visibility = View.GONE
            addView(content); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        pages[page] = scroll; pagesHost.addView(scroll, FrameLayout.LayoutParams(-1, -1))
        subtitle?.let { text(it, NativeFontRole.SUPPORT, NativeColorRole.MUTED).apply {
            isSingleLine = false; maxLines = Int.MAX_VALUE; ellipsize = null
            if (page == Page.OVERVIEW) (layoutParams as LinearLayout.LayoutParams).bottomMargin = dp(MoteTheme.spaceInline)
        } }
    }

    private fun ensurePage(page: Page) {
        if (pages.containsKey(page)) return
        val wasInitializing = initializing
        initializing = true
        try {
            when (page) {
                Page.OVERVIEW -> buildToday()
                Page.MANAGE -> buildManagement()
                Page.LIBRARY -> buildLibrary()
                Page.ASK -> {
                    val explicit = intent.getStringExtra("conversationId") != null || intent.getStringExtra("evidenceId") != null
                    val central = CentralContent(this, centralState, initialPage = if (explicit) "ask" else "conversations", openLocalPage = {
                        val next = Page.valueOf(it)
                        showPage(next, connectionEntryOrigin = if (next == Page.CONNECTION) ConnectionOrigin.LOCAL_ASK else null)
                    })
                    centralContent = central
                    central.root.visibility = View.GONE
                    central.root.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                    pages[Page.ASK] = central.root
                    pagesHost.addView(central.root, FrameLayout.LayoutParams(-1, -1))
                }
                Page.ACTIVITY -> {
                    val central = CentralContent(this, activityState, initialPage = "activity", openLocalPage = { next -> showPage(Page.valueOf(next), connectionEntryOrigin = if (next == "CONNECTION") ConnectionOrigin.LOCAL_ACTIVITY else null) })
                    activityContent = central
                    central.root.visibility = View.GONE
                    central.root.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                    pages[Page.ACTIVITY] = central.root
                    pagesHost.addView(central.root, FrameLayout.LayoutParams(-1, -1))
                }
                Page.NOTES -> buildNotes()
                Page.SOURCES -> buildSources()
                Page.SETTINGS -> buildSettings()
                Page.APPEARANCE -> buildAppearance()
                Page.PERMISSIONS -> buildPermissions()
                Page.ABOUT -> buildAbout()
                else -> buildSettingsPage(page, loadedConfig)
            }
            pages[page]?.let(MoteUi::styleSelects)
            baseline = baseline + controlValues(controls.filter { controlPages[it] == page })
        } finally { initializing = wasInitializing }
    }

    private fun showPage(page: Page, discardConfirmed: Boolean = false, connectionEntryOrigin: ConnectionOrigin? = null) {
        if (page != Page.OVERVIEW) homeSections?.pause() else homeSections?.show()
        if (page == Page.DEVELOPER && !RuntimeProfile.current.developerTools) {
            showPage(Page.SETTINGS, discardConfirmed, connectionEntryOrigin)
            return
        }
        if (!initializing && page != currentPage && !discardConfirmed && pageControlValues().any { (key, value) -> baseline[key] != value && (!applyingSettings || pendingSubmission?.get(key) != value) }) {
            MoteDialogBuilder(this).setTitle(MoteI18n.text("有未保存的更改"))
                .setMessage(MoteI18n.text("离开并丢弃修改？"))
                .setNegativeButton(MoteI18n.text("继续编辑"), null)
                .setPositiveButton(MoteI18n.text("丢弃修改")) { _, _ -> showPage(page, true, connectionEntryOrigin) }.show()
            return
        }
        ensurePage(page)
        if (page == Page.PERMISSIONS) {
            if (currentPage != Page.PERMISSIONS) permissionReturnPage = currentPage
            updatePermissionStatuses()
        }
        if (currentPage != page) {
            if (pageControlValues().isNotEmpty()) discardPageDraft()
            else pages[currentPage]?.let { scrollPositions[currentPage] = it.scrollY }
            connectionOrigin = if (page == Page.CONNECTION) connectionEntryOrigin else null
            if (currentPage == Page.ASK) centralContent?.pause()
            if (currentPage == Page.ACTIVITY) activityContent?.pause()
            currentFocus?.clearFocus()
            getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(pagesHost.windowToken, 0)
        }
        val enteringAsk = page == Page.ASK && currentPage != page
        val enteringActivity = page == Page.ACTIVITY && currentPage != page
        currentPage = page
        if (::homeRecordingBar.isInitialized) homeRecordingBar.setHome(page == Page.OVERVIEW)
        val designHeader = page in setOf(Page.MANAGE, Page.SETTINGS, Page.CONNECTION, Page.LIBRARY)
        headerTitle.text = if (page == Page.OVERVIEW) "Mote" else page.title
        headerTitle.visibility = if (page == Page.OVERVIEW || designHeader) View.GONE else View.VISIBLE
        NativePresentationStyles.bind(headerTitle, "local-heading") { (it as TextView).textSize = if (currentPage == Page.OVERVIEW) 17f else MoteTheme.fontAppbar.toFloat() }
        headerTitle.setPadding(0, dp(MoteTheme.spaceInline), dp(MoteTheme.spaceInline), dp(MoteTheme.spaceInline))
        headerMarkAction.visibility = if (page == Page.OVERVIEW) View.VISIBLE else View.GONE
        homeHeader.setPadding(dp(if (page == Page.OVERVIEW) 8 else if (page == Page.LIBRARY) 8 else if (designHeader) 6 else if (page.parent == null) MoteTheme.spacePage else 0), 0, dp(if (page == Page.OVERVIEW) 4 else if (page == Page.LIBRARY) 8 else if (designHeader) 6 else MoteTheme.spacePage), 0)
        homeHeader.minimumHeight = dp(if (page == Page.OVERVIEW) 56 else 48)
        headerBackAction.tag = "local-back:${page.name}"
        headerBackAction.visibility = if (page.parent != null) View.VISIBLE else View.GONE
        headerBackAction.contentDescription = if (page == Page.CONNECTION && connectionOrigin == ConnectionOrigin.CENTRAL_CALLER)
            MoteI18n.text("返回上一页") else pageBackTarget(page)?.let { MoteI18n.text("返回{0}", it.title) }
        homeHeader.visibility = if (page in setOf(Page.ASK, Page.ACTIVITY)) View.GONE else View.VISIBLE
        headerDivider.visibility = if (page != Page.OVERVIEW && homeHeader.visibility == View.VISIBLE && !designHeader) View.VISIBLE else View.GONE
        headerSearchAction.visibility = if (page in setOf(Page.OVERVIEW, Page.LIBRARY)) View.VISIBLE else View.GONE
        NativePresentationStyles.bind(headerSearchAction, "glyph-tint") {
            (it as ImageView).imageTintList = android.content.res.ColorStateList.valueOf(NativeColorRole.INK.color())
        }
        if (page == Page.LIBRARY) {
            headerSearchAction.setImageResource(MoteGlyph.SLIDERS.drawable)
            headerSearchAction.contentDescription = MoteI18n.text("筛选")
            headerSearchAction.tag = "library-filter"
            headerSearchAction.setOnClickListener { libraryView?.showFilters() }
        } else {
            headerSearchAction.setImageResource(MoteGlyph.SEARCH.drawable)
            headerSearchAction.contentDescription = MoteI18n.text("搜索资料"); headerSearchAction.tag = "home-search-action"
            headerSearchAction.setOnClickListener { openCentral(MoteNavigation.SEARCH) }
        }
        val compactHeader = page != Page.OVERVIEW && (resources.configuration.screenWidthDp < 360 || resources.configuration.fontScale > 1.2f)
        homeHeader.orientation = if (compactHeader) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
        headerHeading.layoutParams = if (compactHeader) LinearLayout.LayoutParams(-1, -2) else LinearLayout.LayoutParams(0, -2, 1f)
        headerActions.layoutParams = LinearLayout.LayoutParams(if (compactHeader) -1 else -2, -2)
        headerActions.visibility = headerSearchAction.visibility
        pages.forEach { (key, view) ->
            view.visibility = if (key == page) View.VISIBLE else View.GONE
            view.importantForAccessibility = if (key == page) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        navigation.select(MoteNavigation.localTab(page.name))
        (pages[page] as? ScrollView)?.let { scroll -> scroll.post { scroll.scrollTo(0, scrollPositions[page] ?: 0) } }
        if (enteringAsk && resumed) centralContent?.resume()
        if (enteringActivity && resumed) activityContent?.resume()
        updateSaveBar()
        if (page == Page.LIBRARY) loadLocalLibrary()
        if (page in setOf(Page.OVERVIEW, Page.MANAGE, Page.SOURCES)) loadHomeContent()
    }

    override fun onNewIntent(next: Intent) {
        super.onNewIntent(next); intent = next;centralContent?.captureAskConversationIntent()
        if (::pagesHost.isInitialized) next.getStringExtra("page")?.let { value -> requestedPage(value) }?.let {
            showPage(it, connectionEntryOrigin = if (it == Page.CONNECTION && next.getBooleanExtra("returnToCentral", false)) ConnectionOrigin.CENTRAL_CALLER else null)
            if (next.getStringExtra("page") == "OBSERVATIONS" && currentPage == Page.PRIVACY) pagesHost.post { showObservations() }
        }
        if (::pagesHost.isInitialized) takeCaptureAction(next)
    }

    // API 33+ uses the native OnBackInvokedDispatcher registered in onCreate; this is the API 29–32 fallback.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Deprecated("Native Activity back navigation")
    override fun onBackPressed() = navigateBack()

    private fun navigateBack() {
        if (initializing) { finish(); return }
        when {
            currentPage == Page.ASK && centralContent?.back() == true -> Unit
            currentPage == Page.ACTIVITY && activityContent?.back() == true -> Unit
            currentPage.parent != null -> navigatePageBack(currentPage)
            currentPage != Page.OVERVIEW -> showPage(Page.OVERVIEW)
            else -> finish()
        }
    }

    private fun pageBackTarget(page: Page): Page? = if (page == Page.CONNECTION && connectionOrigin == ConnectionOrigin.LOCAL_ASK) Page.ASK
        else if (page == Page.CONNECTION && connectionOrigin == ConnectionOrigin.LOCAL_ACTIVITY) Page.ACTIVITY
        else page.parent?.let(Page::valueOf)

    private fun navigatePageBack(page: Page) {
        if (page == Page.PRIVACY && ::appCaptureEditor.isInitialized && appCaptureEditor.backToList()) return
        if (page == Page.CONNECTION && connectionOrigin == ConnectionOrigin.CENTRAL_CALLER) returnConnectionToCaller()
        else pageBackTarget(page)?.let { showPage(it) }
    }

    /** A real caller return uses the same unsaved-settings confirmation as page navigation. */
    private fun returnConnectionToCaller(discardConfirmed: Boolean = false) {
        if (!discardConfirmed && pageControlValues().any { (key, value) -> baseline[key] != value && (!applyingSettings || pendingSubmission?.get(key) != value) }) {
            MoteDialogBuilder(this).setTitle(MoteI18n.text("有未保存的更改"))
                .setMessage(MoteI18n.text("离开并丢弃修改？"))
                .setNegativeButton(MoteI18n.text("继续编辑"), null)
                .setPositiveButton(MoteI18n.text("丢弃修改")) { _, _ -> returnConnectionToCaller(true) }.show()
            return
        }
        if (pageControlValues().isNotEmpty()) discardPageDraft()
        connectionOrigin = null
        finish()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBundle("library", libraryView?.saveState() ?: libraryState);outState.putInt("logExportHours",logExportHours)
        outState.putString("page", currentPage.name)
        outState.putString("permissionReturnPage", permissionReturnPage.name)
        if (currentPage == Page.CONNECTION) connectionOrigin?.let { outState.putString("connectionOrigin", it.name) }
        pageRuleImportTarget?.let { (id, version) -> outState.putString("pageRuleImportApp", id); outState.putString("pageRuleImportVersion", version) }
        outState.putBundle("centralContent", Bundle().also { state ->
            centralContent?.saveState(state) ?: centralState?.let(state::putAll)
        })
        outState.putBundle("activityContent", Bundle().also { state ->
            activityContent?.saveState(state) ?: activityState?.let(state::putAll)
        })
        super.onSaveInstanceState(outState)
    }

    // Keep unsaved sensitive settings in memory across rotation; never serialize credentials to a Bundle.
    @Deprecated("Native Activity in-memory configuration retention")
    override fun onRetainNonConfigurationInstance(): Any? = if (::loadedConfig.isInitialized) RetainedDraft(pageControlValues(), loadedConfig, if (::appCaptureEditor.isInitialized) appCaptureEditor.state() else null) else null

    private fun updateSaveBar() {
        if (!::saveBar.isInitialized || initializing) return
        val current = pageControlValues()
        val dirty = current.any { (key, value) -> baseline[key] != value }
        saveBar.visibility = if (currentPage!=Page.PROCESSING && current.isNotEmpty() && (dirty || applyingSettings)) View.VISIBLE else View.GONE
        processingSave?.isEnabled=!applyingSettings&&!ConnectionGuard.reconfiguring()
        (saveBar.getChildAt(1) as Button).isEnabled = !applyingSettings && !ConnectionGuard.reconfiguring()
        saveHint.text = if (applyingSettings) MoteI18n.text("正在保存…") else MoteI18n.text("有未保存的更改")
    }

    private fun pageControlValues() = controlValues(controls.filter { controlPages[it] == currentPage })

    private fun restoreControlValues(values: Map<String, String>) {
        val wasApplying = applyingConnectionFields
        applyingConnectionFields = true
        try { controls.forEach { view -> values[stableControlKeys.getValue(view)]?.let { value -> when (view) {
            is EditText -> { if (view.text.toString() != value) view.setText(value); view.error = null }
            is CheckBox -> view.isChecked = value.toBoolean()
            is Spinner -> view.setSelection(value.toInt())
        } } } } finally { applyingConnectionFields = wasApplying }
        updateSaveBar(); renderAppRules()
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
                discarded.forEach { controls.remove(it); controlPages.remove(it); stableControlKeys.remove(it); if (it is EditText) fieldLabels.remove(it) }
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
        Page.DEVELOPER -> buildDeveloper(config); Page.DIAGNOSTICS -> buildDiagnostics(config)
        else -> Unit
    }

    /** Rebuild every settings form from the committed snapshot after pairing or another activity saves. */
    private fun reloadSettings(config: CollectorConfig) {
        initializing = true; applyingConnectionFields = true
        try {
            val editablePages = controlPages.values.toSet()
            editablePages.forEach { page -> pages.remove(page)?.let(pagesHost::removeView) }
            controls.forEach { if (it is EditText) fieldLabels.remove(it) }
            controls.clear(); controlPages.clear(); stableControlKeys.clear()
            loadedConfig = config
            editablePages.forEach { buildSettingsPage(it, config) }
            baseline = controlValues()
        } finally { applyingConnectionFields = false; initializing = false }
        // The overview is already cached; revisiting it would reset its scroll and focus.
        if (currentPage != Page.SETTINGS) showPage(currentPage)
    }

    private fun controlValues(views: List<View> = controls) = views.associate { view ->
        stableControlKeys.getValue(view) to when (view) {
            is EditText -> view.text.toString()
            is CheckBox -> view.isChecked.toString()
            is Spinner -> view.selectedItemPosition.toString()
            else -> ""
        }
    }

    private fun track(view: View, key: String, stableKey: String = key) {
        view.tag = key; controls.add(view); controlPages[view] = buildingPage; stableControlKeys[view] = "${buildingPage.name}:$stableKey"
        when (view) {
            is EditText -> view.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: Editable?) { updateSaveBar() }
            })
            is CheckBox -> view.setOnCheckedChangeListener { _, _ -> updateSaveBar() }
            is Spinner -> view.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, selected: View?, position: Int, id: Long) { updateSaveBar() }
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            }
        }
    }

    private fun text(value: String, size: NativeFontRole, color: NativeColorRole = NativeColorRole.INK): TextView = TextView(this).apply {
        text = value; MoteUi.type(this, size); MoteUi.textColor(this, color)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }
        content.addView(this)
    }
    private fun section(value: String) {
        text(value, NativeFontRole.SECTION).apply {
            typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
            (layoutParams as LinearLayout.LayoutParams).apply { topMargin = dp(MoteTheme.spaceItem); bottomMargin = dp(4) }
        }
    }
    private fun lightTextAction(label: String, parent: LinearLayout=content, action: () -> Unit): TextView = object:TextView(this) { override fun getAccessibilityClassName(): CharSequence = Button::class.java.name }.apply {
        text=label; contentDescription=label; isFocusable=true; minimumHeight=dp(44); gravity=Gravity.START or Gravity.CENTER_VERTICAL
        MoteUi.type(this,NativeFontRole.SUPPORT); MoteUi.textColor(this,NativeColorRole.MUTED); background=MoteUi.clickable(this@MainActivity,android.graphics.Color.TRANSPARENT,0,false)
        setOnClickListener { action() }
    }.also { parent.addView(it,LinearLayout.LayoutParams(if(parent.orientation==LinearLayout.HORIZONTAL) -2 else -1,-2)) }
    private fun settingsRow(label: String, description: String, icon: String? = null, action: () -> Unit): LinearLayout {
        content.addView(View(this).apply { MoteUi.backgroundColor(this,NativeColorRole.DIVIDER) },LinearLayout.LayoutParams(-1,dp(1)))
        val row = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL; minimumHeight = dp(76); setPadding(0,dp(16),0,dp(16))
            tag = "menu:$label"; contentDescription = "$label，$description"; isFocusable = true
            background = MoteUi.clickable(this@MainActivity,NativeColorRole.BACKGROUND,0,false); setOnClickListener { action() }
        }
        if (icon != null) row.addView(TextView(this).apply {
            text = icon; gravity = Gravity.CENTER; MoteUi.type(this,NativeFontRole.SUPPORT); MoteUi.textColor(this,NativeColorRole.MUTED)
            background = MoteUi.shape(this@MainActivity,NativeColorRole.SURFACE,4,true); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        },LinearLayout.LayoutParams(dp(28),dp(32)).apply { marginEnd = dp(12) })
        row.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@MainActivity).apply { text = label; MoteUi.type(this,NativeFontRole.ACTION,medium = true); MoteUi.textColor(this,NativeColorRole.INK) })
            addView(TextView(this@MainActivity).apply { text = description; MoteUi.type(this,NativeFontRole.META); MoteUi.textColor(this,NativeColorRole.MUTED); setPadding(0,dp(6),0,0); tag = "row-detail" })
        },LinearLayout.LayoutParams(0,-2,1f))
        row.addView(MoteComponents.icon(this, MoteGlyph.CHEV, NativeColorRole.MUTED, 20), LinearLayout.LayoutParams(dp(20), dp(20)))
        content.addView(row); return row
    }

    private fun lightControl(label: String, actionLabel: String, action: () -> Unit): Pair<TextView, Button> {
        content.addView(View(this).apply { MoteUi.backgroundColor(this, NativeColorRole.DIVIDER) }, LinearLayout.LayoutParams(-1, dp(1)))
        val row = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(10), 0, dp(10)) }
        val labels = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        labels.addView(TextView(this).apply { text = label; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.INK) })
        val state = TextView(this).apply { MoteUi.type(this, NativeFontRole.META); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(0, dp(5), 0, 0) }
        labels.addView(state)
        row.addView(labels, LinearLayout.LayoutParams(0, -2, 1f))
        val control = MoteUi.action(Button(this), MoteUi.ButtonRole.TEXT).apply { text = actionLabel; MoteUi.textColor(this, NativeColorRole.ACCENT); setOnClickListener { action() } }
        row.addView(control)
        content.addView(row)
        return state to control
    }

    private fun menuGroup(body: () -> Unit) {
        val group = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; background = MoteUi.shape(this@MainActivity)
            setPadding(dp(MoteTheme.borderWidth), dp(MoteTheme.borderWidth), dp(MoteTheme.borderWidth), dp(MoteTheme.borderWidth))
        }
        content.addView(group, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(MoteTheme.spaceItem) })
        val previous = activeMenuGroup; activeMenuGroup = group
        try { body() } finally { activeMenuGroup = previous }
    }
    private fun card(role: NativeColorRole = NativeColorRole.SURFACE, body: () -> Unit) {
        val parent = content
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(16), dp(16), dp(8)); background = MoteUi.shape(this@MainActivity, role)
        }
        parent.addView(card, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8); bottomMargin = dp(14) })
        content = card
        try { body() } finally { content = parent }
    }
    private fun menu(label: String, description: String, icon: String, action: () -> Unit) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = dp(MoteTheme.controlHeight)
            setPadding(dp(MoteTheme.spacePanel), dp(MoteTheme.spaceInline), dp(MoteTheme.spacePanel), dp(MoteTheme.spaceInline))
            background = if (activeMenuGroup == null) MoteUi.clickable(this@MainActivity) else MoteUi.clickable(this@MainActivity, Color.TRANSPARENT, 0, false)
            tag = "menu:$label"; isFocusable = true; contentDescription = "$label，$description"; setOnClickListener { action() }
        }
        row.addView(ImageView(this).apply {
            setImageDrawable(MoteNavigationIcon(this@MainActivity, icon, false)); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(24), dp(24)).apply { marginEnd = dp(MoteTheme.spaceInline) })
        val labels = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS }
        labels.addView(TextView(this).apply { text = label; MoteUi.type(this, NativeFontRole.ROW, medium = true); MoteUi.textColor(this, NativeColorRole.INK) })
        if (description.isNotBlank()) labels.addView(TextView(this).apply { text = description; MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(0, dp(4), 0, 0) })
        row.addView(labels, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(MoteComponents.icon(this, MoteGlyph.CHEV, NativeColorRole.MUTED, 20), LinearLayout.LayoutParams(dp(20), dp(20)))
        val group = activeMenuGroup
        if (group != null && group.childCount > 0) group.addView(View(this).apply { MoteUi.backgroundColor(this, NativeColorRole.DIVIDER) }, LinearLayout.LayoutParams(-1, dp(MoteTheme.borderWidth)).apply { marginStart = dp(48); marginEnd = dp(MoteTheme.spacePanel) })
        (group ?: content).addView(row, LinearLayout.LayoutParams(-1, -2).apply { if (group == null) bottomMargin = dp(MoteTheme.spaceItem) })
    }
    private fun currentAppRules() = AppCollectionRules.fromLines(
        AppCollectionMode.fromChoices(appDefaultDuration.isChecked, appDefaultScreenshots.isChecked, appDefaultStructured.isChecked),
        appPolicies.text.toString())
    private fun renderAppRules() {
        if (::appCaptureEditor.isInitialized) appCaptureEditor.refresh()
    }
    private fun appModeLabel(mode: AppCollectionMode): String {
        val choices = buildList {
            if (mode.duration) add(MoteI18n.text("应用时长"))
            if (mode.screenshots) add(MoteI18n.text("截图"))
            if (mode.structured) add(MoteI18n.text("结构化内容"))
        }
        return choices.joinToString(" + ").ifBlank { MoteI18n.text("不记录") }
    }
    @Suppress("DEPRECATION")
    private fun appVersion(id: String): String = runCatching { packageManager.getPackageInfo(id, 0).versionName.orEmpty() }.getOrDefault("")
    private fun appLabel(id: String): String = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(id, 0)).toString() }.getOrDefault(id)
    private fun draftAppMode(id: String, c: CollectorConfig): AppCollectionMode = if (id in PrivacyRules.exclusions(c.excludedPackages)) AppCollectionMode.OFF else c.collectionRules.apps[id] ?: c.collectionRules.defaultMode
    private fun pageAdapterSummary(raw: String, id: String, version: String): String {
        if (version.isBlank()) return MoteI18n.text("应用未安装或版本不可读取；不会使用其他版本的字段规则")
        val adapters = runCatching { AppPageSetup.adapters(raw, id, version) }.getOrDefault(emptyList())
        if (adapters.isEmpty()) return MoteI18n.text("当前版本未配置字段规则；截图仍按独立选择执行")
        return adapters.joinToString("\n") { rule ->
            val kind = when (rule.kind) { "article" -> MoteI18n.text("文章"); "product" -> MoteI18n.text("商品"); else -> rule.kind }
            MoteI18n.text("已配置 {0} · {1}；实际页面仍需匹配", kind, rule.fields.joinToString("、") { field -> when (field) {
                "title" -> MoteI18n.text("标题"); "author" -> MoteI18n.text("作者"); "body" -> MoteI18n.text("正文")
                "url" -> MoteI18n.text("链接"); "item_id" -> MoteI18n.text("商品 ID"); else -> field
            } })
        }
    }
    private fun loadAppPageRules(id: String, version: String) {
        runCatching {
            val builtin = UiPageRules.parse(assets.open("ui-page-rules.json").bufferedReader().use { it.readText() })
                .filter { it.optInt("formatVersion") == 3 && it.optString("platform") == "android" && it.optString("appId") == id && version.isNotBlank() && it.optString("appVersion") == version }
            require(builtin.isNotEmpty()) { MoteI18n.text("内置规则没有适配当前安装版本，请配置字段或导入规则") }
            uiPageRules.setText(AppPageSetup.merge(uiPageRules.text.toString(), org.json.JSONArray(builtin).toString(), id, version))
            uiPageMode.setSelection(uiPageModes.indexOf("ui_preferred")); renderAppRules()
            toast(MoteI18n.text("字段规则已加入草稿；返回后保存生效，应用内容授权未改变"))
        }.onFailure { toast(it.message ?: MoteI18n.text("字段规则格式无效")) }
    }
    private fun editAppPageRule(id: String, version: String, onChanged: () -> Unit) {
        if (version.isBlank()) { toast(MoteI18n.text("无法读取应用版本，请重新选择已安装应用")); return }
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(12)) }
        form.addView(TextView(this).apply { text = MoteI18n.text("为 {0} · {1} 映射实际控件 ID。只提取可见文字，不点击、不滚动、不猜测链接。", appLabel(id), version); MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED) })
        val kind = Spinner(this).apply { adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf(MoteI18n.text("文章"), MoteI18n.text("商品"))) }; form.addView(kind)
        fun input(label: String, hint: String): EditText {
            form.addView(TextView(this).apply { text = label; MoteUi.type(this, NativeFontRole.SUPPORT); setPadding(0, dp(10), 0, 0) })
            return MoteUi.field(EditText(this)).apply { this.hint = hint; setSingleLine(); inputType = InputType.TYPE_CLASS_TEXT; form.addView(this) }
        }
        val title = input(MoteI18n.text("标题控件 ID（必填）"), "$id:id/title")
        val author = input(MoteI18n.text("作者控件 ID（文章，可选）"), "$id:id/author")
        val textBody = input(MoteI18n.text("正文控件 ID（文章必填）"), "$id:id/body")
        val url = input(MoteI18n.text("链接控件 ID（可选，不生成链接）"), "$id:id/url")
        val item = input(MoteI18n.text("商品 ID 控件（商品，可选）"), "$id:id/item_id")
        val activity = input(MoteI18n.text("页面 Activity（可选）"), "$id.DetailActivity")
        val region = input(MoteI18n.text("内容区块控件 ID（可选）"), "$id:id/content")
        val repeat = input(MoteI18n.text("重复商品卡片控件 ID（可选）"), "$id:id/card")
        val error = TextView(this).apply { MoteUi.textColor(this, NativeColorRole.WARNING); MoteUi.type(this, NativeFontRole.SUPPORT) }; form.addView(error)
        val dialog = MoteDialogBuilder(this).setTitle(MoteI18n.text("配置此版本字段"))
            .setView(ScrollView(this).apply { addView(form) }).setNegativeButton(MoteI18n.text("取消"), null)
            .setPositiveButton(MoteI18n.text("加入配置草稿"), null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            runCatching {
                val selectedKind = if (kind.selectedItemPosition == 0) "article" else "product"
                val fields = linkedMapOf("title" to title.text.toString(), "url" to url.text.toString())
                if (selectedKind == "article") { fields["author"] = author.text.toString(); fields["body"] = textBody.text.toString() }
                else fields["itemId"] = item.text.toString()
                val rule = AppPageSetup.fieldRule(id, version, selectedKind, fields, activity.text.toString(), region.text.toString(), if (selectedKind == "product") repeat.text.toString() else "")
                uiPageRules.setText(AppPageSetup.merge(uiPageRules.text.toString(), rule, id, version))
                uiPageMode.setSelection(uiPageModes.indexOf("ui_preferred")); onChanged(); dialog.dismiss()
            }.onFailure { error.text = it.message ?: MoteI18n.text("字段规则格式无效") }
        } }; dialog.show()
    }
    private fun showCapturePreview(config: CollectorConfig, firstStart: Boolean = false, appId: String? = null, expected: CollectorConfig = config, accept: () -> Unit = { startConfiguredCapture() }) {
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(12)) }
        fun detail(value: String) { body.addView(TextView(this).apply { text = value; MoteUi.type(this, NativeFontRole.BODY); MoteUi.textColor(this, NativeColorRole.INK); setPadding(0, 0, 0, dp(14)) }) }
        detail(MoteI18n.text("这里是生成的格式示例，不读取你的屏幕。实际记录由已授权应用、版本规则和可见内容决定。"))
        val ids = appId?.let(::setOf) ?: (config.collectionRules.apps.keys + PrivacyRules.exclusions(config.excludedPackages)).sorted().toSet()
        if (appId == null) detail(MoteI18n.text("未单独设置的应用：{0}\n屏幕与应用活动：{1}", appModeLabel(config.collectionRules.defaultMode), if (config.screenCollectionEnabled) MoteI18n.text("已选择") else MoteI18n.text("未选择")))
        ids.forEach { id ->
            val mode = draftAppMode(id, config)
            detail("${appLabel(id)} · ${appModeLabel(mode)}\n" + if (mode.structured) pageAdapterSummary(config.uiPageRules, id, appVersion(id)) else "")
        }
        val structuredAllowed = config.screenCollectionEnabled && if (appId == null) config.collectionRules.mayCollectStructured() else draftAppMode(appId, config).structured
        if (structuredAllowed) {
            detail(MoteI18n.text("结构化格式示例\n类型：可见内容\n字段：标题、正文、价格或控件状态等实际可见字段\n来源：可见文字、本机 OCR 或安全控件状态"))
            detail(MoteI18n.text("这些格式示例不代表所有应用已适配。字段仅记录匹配规则取得的可见内容；截图按独立选择执行。"))
            detail(MoteI18n.text("本机 OCR 补充：{0}", if (config.localContentOcr) MoteI18n.text("已选择") else MoteI18n.text("未选择")))
        }
        if (appId == null) detail(MoteI18n.text("通知：{0} · 设备事件：{1} · 媒体：{2}", if (config.notificationCollectionEnabled) MoteI18n.text("已选择") else MoteI18n.text("未选择"), if (config.deviceEventCollectionEnabled) MoteI18n.text("已选择") else MoteI18n.text("未选择"), if (config.mediaCollectionEnabled && config.metadataEnabled) MoteI18n.text("已选择") else MoteI18n.text("未选择")))
        detail(if (config.hasSyncConnection()) MoteI18n.text("记录按已保存的同步策略发送到：{0}", config.server) else MoteI18n.text("尚未连接中央，记录只保存在本机"))
        val builder = MoteDialogBuilder(this).setTitle(MoteI18n.text("开启前预览"))
            .setView(ScrollView(this).apply { addView(body) })
            .setNegativeButton(if (firstStart) MoteI18n.text("暂不开始") else MoteI18n.text("关闭预览"), null)
        if (firstStart) builder.setPositiveButton(MoteI18n.text("按此范围开始")) { _, _ ->
            if (expected != loadedConfig) { toast(MoteI18n.text("配置已变化，请重新预览后开始")); return@setPositiveButton }
            runCatching { settings.capturePreviewAccepted() }.onSuccess { accept() }.onFailure { toast(it.message ?: MoteI18n.text("无法持久保存设置，请检查存储空间")) }
        }
        builder.show()
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

    // Display labels remain translated; in-memory draft identity never depends on the selected language.
    private fun sourceField(source: String, value: String, placeholder: String, type: Int = InputType.TYPE_CLASS_TEXT, multiline: Boolean = false) = field(MoteI18n.text(source), value, placeholder, type, multiline, source)
    private fun sourceCheck(source: String, selected: Boolean) = check(MoteI18n.text(source), selected, source)
    private fun sourcePresetNumber(source: String, value: Int, placeholder: String, range: IntRange, presets: List<Int>) = presetNumber(MoteI18n.text(source), value, placeholder, range, presets, source)

    private fun presetNumber(label: String, value: Int, placeholder: String, range: IntRange, presets: List<Int>, stableKey: String = label): EditText {
        val result = field(label, value.toString(), placeholder, InputType.TYPE_CLASS_NUMBER, stableKey = stableKey)
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

    private fun field(label: String, value: String, placeholder: String, type: Int = InputType.TYPE_CLASS_TEXT, multiline: Boolean = false, stableKey: String = label): EditText {
        val labelView = text(label, NativeFontRole.SUPPORT, NativeColorRole.MUTED)
        return MoteUi.field(EditText(this)).apply {
            fieldLabels[this] = labelView
            MoteUi.textInput(this, type, multiline)
            setText(value); hint = placeholder
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO; isSaveEnabled = false
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(18) }; content.addView(this)
            if (buildingPage != Page.NOTES) track(this, label, stableKey)
        }
    }
    private fun check(label: String, selected: Boolean, stableKey: String = label) = CheckBox(this).apply {
        text = label; isChecked = selected; MoteUi.type(this, NativeFontRole.BODY); minHeight = dp(52); MoteUi.textColor(this, NativeColorRole.INK)
        buttonTintList = android.content.res.ColorStateList.valueOf(MoteUi.accent)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }; content.addView(this); track(this, label, stableKey)
    }
    private fun button(label: String, primary: Boolean = false, action: () -> Unit) = MoteUi.button(Button(this), primary).apply {
        text = label; setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) }; content.addView(this)
    }
    private fun rowButtons(left: String, leftAction: () -> Unit, right: String, rightAction: () -> Unit, leftPrimary: Boolean = false) {
        val compact = resources.configuration.screenWidthDp < 360 || resources.configuration.fontScale > 1.2f
        val row = LinearLayout(this).apply { orientation = if (compact) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        listOf(left to leftAction, right to rightAction).forEachIndexed { index, (label, action) ->
            row.addView(MoteUi.button(Button(this), primary = index == 0 && leftPrimary).apply { text = label; setOnClickListener { action() } },
                (if (compact) LinearLayout.LayoutParams(-1, -2) else LinearLayout.LayoutParams(0, -2, 1f)).apply { if (index == 0) { if (compact) bottomMargin = dp(MoteTheme.spaceInline) else marginEnd = dp(MoteTheme.spaceInline) } })
        }
        content.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) })
    }
    private fun toast(message: String) { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
}
