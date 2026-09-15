package dev.mote.collector

import android.app.Application
import java.util.concurrent.Executors

class MoteApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (getProcessName() != packageName) return
        Notifications.create(this)
        QueueStorage.recovering = true
        Executors.newSingleThreadExecutor().apply {
            execute {
                SupportEvents.record(this@MoteApplication, EventStage.APP, EventCode.STARTED)
                val settings = Settings(this@MoteApplication)
                try {
                    queue().recoverOrphans()
                    val config = settings.read()
                    if (settings.syncState() == "uploading") settings.syncStatus(if (config.syncMode == "manual") "manual" else "waiting", "上次同步已中断，记录保留在本机")
                    UploadWorker.schedule(this@MoteApplication, config)
                    CaptureOcrWorker.schedule(this@MoteApplication, config)
                    SourceWork.schedule(this@MoteApplication)
                    if (settings.enabled && config.screenCollectionEnabled && config.mode == "projection" && !config.observesSystem()) {
                        settings.enabled = false
                        settings.status("permission_required", "投屏会话已结束，请点击开始并重新授权；已有记录保留，同步按所选策略运行")
                    }
                } catch (error: Exception) { QueueStorage.recoveryFailure = error.message ?: "本机存储恢复失败"; SupportEvents.record(this@MoteApplication, EventStage.QUEUE, EventCode.STORAGE); settings.status("error", "本地加密队列无法读取：${error.message ?: "请检查所选存储介质与设备密钥，保留应用数据"}") }
                finally { QueueStorage.recovering = false }
            }
            shutdown()
        }
    }
}
