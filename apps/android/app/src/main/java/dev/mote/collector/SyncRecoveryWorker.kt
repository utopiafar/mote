package dev.mote.collector

import android.content.Context
import androidx.work.*
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit

/** Explicit recovery only. Does not delete local data or treat remote existence as an acknowledgement. */
class SyncRecoveryWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = ConnectionGuard.sync { run() } ?: Result.retry()
    private fun run(): Result {
        val settings = Settings(applicationContext); val config = settings.read()
        val state = applicationContext.getSharedPreferences("sync-recovery", Context.MODE_PRIVATE)
        fun report(message: String) { state.edit().putString("message", message).putString("at", Instant.now().toString()).commit() }
        try {
            if (inputData.getString("syncStamp") != SyncSchedule.stamp(config)) { report(MoteI18n.text("连接或同步策略已变化，本次操作已停止；请重新发起")); return Result.failure() }
            config.validateConnection()
            SyncSchedule.waitingReason(applicationContext, config)?.let { report(it); return Result.retry() }
            if (inputData.getBoolean("replay", false)) {
                report(MoteI18n.text("正在准备全量补传…"))
                val records = applicationContext.queue().requeueRetained()
                if (isStopped) return Result.success()
                val versions = applicationContext.localSources().requeueRetained(minOf(64L, config.maxQueueMiB.toLong()) * 1024 * 1024)
                if (isStopped) return Result.success()
                UploadWorker.schedule(applicationContext, config, true)
                report(MoteI18n.text("已安排补传 {0} 条本机采集记录及 {1} 个保留来源版本；实际上传进度见下方同步状态。冲突和中央已删除记录保持隔离。", records, versions))
                return Result.success()
            }
            // Durable checkpoint belongs to this WorkRequest; network retries resume its last checked batch.
            if (state.getString("job", null) != id.toString()) state.edit().clear().putString("job", id.toString()).commit()
            var cursor = state.getString("cursor", null)
            var present = state.getInt("present", 0); var unavailable = state.getInt("unavailable", 0)
            repeat(20) {
                if (isStopped || ConnectionGuard.reconfiguring()) return Result.retry()
                SyncSchedule.waitingReason(applicationContext, config)?.let { report(it); return Result.retry() }
                val ids = applicationContext.queue().syncIds(cursor)
                if (ids.isEmpty()) {
                    report(MoteI18n.text("检查完成：中央可见 {0} 条，不可见 {1} 条。检查范围为手机仍保留的采集记录；不可见可能是缺失、删除或无权限，不会自动恢复。来源快照由全量补传时核验。", present, unavailable))
                    return Result.success()
                }
                val (code, response) = HttpJson.post("${config.server}/api/capture-browser/reconcile",
                    JSONObject().put("deviceId", settings.deviceId).put("ids", JSONArray(ids)), config.token)
                if (code == 401 || code == 403) { report(MoteI18n.text("检查失败：连接授权失效，请重新连接同一节点后重试")); return Result.failure() }
                if (code == 404) { report(MoteI18n.text("中央节点尚不支持两端检查，请升级中央端代码；未修改本机状态")); return Result.failure() }
                check(code == 200) { MoteI18n.text("检查响应未确认") }
                val items = response?.getJSONArray("items") ?: error(MoteI18n.text("检查响应缺失"))
                require(items.length() == ids.size)
                val states = ids.indices.map { index ->
                    val item = items.getJSONObject(index); require(item.getString("id") == ids[index])
                    item.getString("state").also { require(it in setOf("present", "unavailable")) }
                }
                present += states.count { it == "present" }; unavailable += states.count { it == "unavailable" }
                cursor = ids.last()
                check(state.edit().putString("cursor", cursor).putInt("present", present).putInt("unavailable", unavailable).commit())
                report(MoteI18n.text("已检查 {0} 条 · 中央可见 {1} · 不可见 {2}", present + unavailable, present, unavailable))
            }
            return Result.retry()
        } catch (_: Exception) {
            report(MoteI18n.text("操作未完成，已完成的步骤保留；请检查网络或存储。本次手动操作可再次点击继续，未删除任何副本。"))
            return Result.failure()
        }
    }
    companion object {
        fun start(context: Context, replay: Boolean) {
            val config = Settings(context).read(); config.validateConnection()
            val request = OneTimeWorkRequestBuilder<SyncRecoveryWorker>().setConstraints(SyncSchedule.constraints(config))
                .setInputData(workDataOf("replay" to replay, "syncStamp" to SyncSchedule.stamp(config)))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniqueWork("mote-sync-recovery", ExistingWorkPolicy.KEEP, request)
            context.getSharedPreferences("sync-recovery", Context.MODE_PRIVATE).edit().putString("message", MoteI18n.text("操作已请求；重复点击会合并，等待网络条件或当前操作完成")).apply()
        }
    }
}
