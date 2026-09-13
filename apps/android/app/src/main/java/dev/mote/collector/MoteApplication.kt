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
                    if (config.server.isNotBlank()) UploadWorker.schedule(this@MoteApplication, config)
                    if (settings.enabled && config.mode == "projection") {
                        settings.enabled = false
                        settings.status("permission_required", "投屏会话已结束，请点击开始并重新授权；已有队列仍会上传")
                    }
                } catch (_: Exception) { SupportEvents.record(this@MoteApplication, EventStage.QUEUE, EventCode.STORAGE); settings.status("error", "本地加密队列无法读取，请保留应用数据并检查设备密钥") }
            }
            shutdown()
        }
    }
}
