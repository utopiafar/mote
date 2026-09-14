package dev.mote.collector

import android.app.Application
import java.util.concurrent.Executors

class MoteApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (getProcessName() != packageName) return
        SupportEvents.record(this, EventStage.APP, EventCode.STARTED)
        Notifications.create(this)
        Executors.newSingleThreadExecutor().apply {
            execute {
                val settings = Settings(this@MoteApplication)
                try {
                    queue().recoverOrphans()
                    val config = settings.read()
                    if (settings.syncState() == "uploading") settings.syncStatus(if (config.syncMode == "manual") "manual" else "waiting", "上次同步已中断，记录保留在本机")
                    UploadWorker.schedule(this@MoteApplication, config)
                    SourceWork.schedule(this@MoteApplication)
                    if (settings.enabled && config.mode == "projection") {
                        settings.enabled = false
                        settings.status("permission_required", "投屏会话已结束，请点击开始并重新授权；已有记录保留，同步按所选策略运行")
                    }
                } catch (_: Exception) { SupportEvents.record(this@MoteApplication, EventStage.QUEUE, EventCode.STORAGE); settings.status("error", "本地加密队列无法读取，请保留应用数据并检查设备密钥") }
            }
            shutdown()
        }
    }
}
