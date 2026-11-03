package dev.mote.collector

import android.app.Application
import dev.mote.collector.plugins.CapturePlugin
import dev.mote.collector.plugins.DurableTransportPlugin
import dev.mote.collector.plugins.NativePluginHost
import dev.mote.collector.plugins.NativePluginRegistry
import dev.mote.collector.plugins.SystemEntriesPlugin
import dev.mote.collector.plugins.registerBuiltinPlugins
import java.util.concurrent.Executors

class MoteApplication : Application() {
    /** Build-native plugin host: providers ship in the APK; activation and
     * binding come only from the real snapshot. View scopes die with the
     * Activity view; durable owners (capture, uploads, drafts) do not. */
    lateinit var pluginHost: NativePluginHost; private set
    companion object { @Volatile var visibleActivities = 0; private set }
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        MoteAppearance.refresh()
    }
    override fun onCreate() {
        super.onCreate()
        MoteI18n.initialize(this)
        NativeUiPacks.initialize(this)
        MoteAppearance.initialize(this)
        if (getProcessName() != packageName) return
        val buildId = runCatching { packageManager.getPackageInfo(packageName, 0).versionName ?: "dev" }.getOrDefault("dev")
        pluginHost = NativePluginHost(NativePluginRegistry().apply { registerBuiltinPlugins(buildId) })
        try { LocalDataFormat.requireCurrent(this) } catch (error: Exception) {
            QueueStorage.recoveryFailure = error.message
            return
        }
        val transport = try { DurableTransportPlugin.start(this, pluginHost) } catch (error: Exception) {
            QueueStorage.recoveryFailure = error.message ?: MoteI18n.text("本机存储恢复失败")
            return
        }
        runCatching { CapturePlugin.start(pluginHost) }
        HttpJson.onUnauthorized = { url, token -> Settings(this).rejectCredential(url, token) }
        HttpJson.onRequest = { Diagnostics(this).add("httpRequests") }
        HttpJson.onComplete = { Diagnostics(this).timing("httpMs", it) }
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: android.app.Activity) { visibleActivities++; ProjectionService.instance?.onWindowChanged() }
            override fun onActivityStopped(activity: android.app.Activity) { visibleActivities = (visibleActivities - 1).coerceAtLeast(0) }
            override fun onActivityCreated(activity: android.app.Activity, state: android.os.Bundle?) = Unit
            override fun onActivityResumed(activity: android.app.Activity) = Unit
            override fun onActivityPaused(activity: android.app.Activity) = Unit
            override fun onActivitySaveInstanceState(activity: android.app.Activity, state: android.os.Bundle) = Unit
            override fun onActivityDestroyed(activity: android.app.Activity) = Unit
        })
        SystemEntriesPlugin.start(this, pluginHost)
        // Remove jobs left by releases with the retired local visual model.
        androidx.work.WorkManager.getInstance(this).cancelUniqueWork("mote-nsfw-download")
        QueueStorage.recovering = true
        Executors.newSingleThreadExecutor().apply {
            execute {
                SupportEvents.record(this@MoteApplication, EventStage.APP, EventCode.STARTED)
                val settings = Settings(this@MoteApplication)
                try {
                    // Only resolve the selected location (including an interrupted migration)
                    // before accepting captures. Library maintenance is independent work.
                    val local = queue()
                    val config = settings.read()
                    if (settings.enabled && config.screenCollectionEnabled && config.mode == "projection" && !config.observesSystem()) {
                        settings.enabled = false
                        settings.status("permission_required", MoteI18n.text("投屏会话已结束，请点击开始并重新授权；已有记录保留，同步按所选策略运行"))
                    }
                    QueueStorage.recovering = false
                    QueueStorage.maintaining = true
                    LocalStateChanges.changed(immediate = true)
                    CaptureAccessibilityService.instance?.refreshSchedule()
                    MediaCollectionService.refresh()
                    if (settings.syncState() == "uploading") settings.syncStatus(if (config.syncMode == "manual") "manual" else "waiting", MoteI18n.text("上次同步已中断，记录保留在本机"))
                    // This scan yields the queue lock between records; it never gates Start.
                    runCatching { local.recoverOrphans() }.onFailure {
                        SupportEvents.record(this@MoteApplication, EventStage.QUEUE, EventCode.STORAGE)
                    }
                    runCatching {
                        BulkDedupeStore(this@MoteApplication).quarantine().recoverOrphans()
                    }.onFailure {
                        SupportEvents.record(this@MoteApplication, EventStage.QUEUE, EventCode.STORAGE)
                    }
                    runCatching {
                        imageDedupeDiagnostics().prune()
                        ImageDedupeDiagnosticsMaintenance.configure(this@MoteApplication, config.imageDedupeDiagnosticsEnabled)
                    }
                    // Launch noninteractive consumers after warming current metadata;
                    // they must not race to rebuild the same library under a longer lock.
                    val current = settings.read()
                    transport.restoreHistory(local, settings)
                    local.pruneUploaded()
                    RetentionWorker.schedule(this@MoteApplication)
                    transport.scheduleUpload(current)
                    SourceWork.schedule(this@MoteApplication)
                } catch (error: Exception) {
                    SupportEvents.record(this@MoteApplication, EventStage.QUEUE, EventCode.STORAGE)
                    if (QueueStorage.recovering) {
                        QueueStorage.recoveryFailure = error.message ?: MoteI18n.text("本机存储恢复失败")
                        settings.status("error", MoteI18n.text("本地队列无法读取：{0}", error.message ?: MoteI18n.text("请检查所选存储介质，保留应用数据")))
                    }
                }
                finally { QueueStorage.recovering = false; QueueStorage.maintaining = false; LocalStateChanges.changed(records = true, immediate = true) }
            }
            shutdown()
        }
    }
}
