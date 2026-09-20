package dev.mote.collector

import android.app.Application
import java.util.concurrent.Executors

class MoteApplication : Application() {
    companion object { @Volatile var visibleActivities = 0; private set }
    override fun onCreate() {
        super.onCreate()
        MoteI18n.initialize(this)
        if (getProcessName() != packageName) return
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
        Notifications.create(this)
        com.tom_roush.pdfbox.android.PDFBoxResourceLoader.init(this)
        FileEvidencePoller.start(this)
        QueueStorage.recovering = true
        LocalStateRepository.get(this)
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
                    // Launch noninteractive consumers after warming the legacy metadata;
                    // they must not race to rebuild the same library under a longer lock.
                    val current = settings.read()
                    local.pruneUploaded()
                    RetentionWorker.schedule(this@MoteApplication)
                    UploadWorker.schedule(this@MoteApplication, current)
                    CaptureOcrWorker.schedule(this@MoteApplication, current)
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
