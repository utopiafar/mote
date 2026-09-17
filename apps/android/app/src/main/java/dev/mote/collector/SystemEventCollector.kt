package dev.mote.collector

import android.app.KeyguardManager
import android.app.Notification
import android.content.Context
import android.os.Handler
import android.os.PowerManager
import android.os.SystemClock
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** Raw platform observations, never inferred user intent. All persistence runs on the observer worker. */
internal class SystemEventCollector(private val context: Context, private val worker: Handler) {
    private val settings = Settings(context)
    private val pending = AtomicInteger()
    @Volatile private var session = UUID.randomUUID().toString()
    private var lastState: String? = null
    private val seen = object : LinkedHashMap<String, String>(128, .75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 512
    }
    private fun allowed(c: CollectorConfig) = settings.enabled && MediaCollectionService.connected && !ConnectionGuard.changing() && !QueueStorage.recovering &&
        MediaCollection.permissionAllowed(context) && context.getSystemService(android.app.NotificationManager::class.java).areNotificationsEnabled() &&
        MediaPrivacy.powerAllowed(c, Diagnostics.battery(context))

    fun notification(sbn: StatusBarNotification, removed: Boolean, reason: Int? = null) {
        val c = settings.read()
        if (!c.notificationCollectionEnabled || !allowed(c) || sbn.packageName == context.packageName) return
        val mode = MediaPrivacy.mode(sbn.packageName, c)
        if (mode == AppCollectionMode.OFF) return
        // Never read textual extras for an activity-only app.
        val n = sbn.notification
        val payload = JSONObject().put("action", if (removed) "removed" else "posted")
            .put("notificationKey", SourceRules.hash(sbn.key)).put("postedAt", Instant.ofEpochMilli(sbn.postTime).toString())
            .put("ongoing", sbn.isOngoing).put("groupSummary", n.flags and Notification.FLAG_GROUP_SUMMARY != 0)
        reason?.let { payload.put("removalReason", it) }
        n.category?.let { payload.put("category", it.take(200)) }
        if (!removed && mode == AppCollectionMode.CONTENT) {
            n.channelId?.let { payload.put("channelId", it.take(300)) }
            val extras = n.extras
            mapOf("title" to Notification.EXTRA_TITLE, "text" to Notification.EXTRA_TEXT,
                "bigText" to Notification.EXTRA_BIG_TEXT, "subText" to Notification.EXTRA_SUB_TEXT).forEach { (key, field) ->
                extras.getCharSequence(field)?.toString()?.let { payload.put(key, it.take(4000)) }
            }
            extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.take(20)?.let { lines ->
                payload.put("textLines", JSONArray(lines.map { it.toString().take(2000) }))
            }
        }
        val event = envelope(c, "notification", mode).put("appId", sbn.packageName.take(300))
            .put("appName", CollectorMetadata.appName(context, sbn.packageName))
        event.getJSONObject("metadata").put("notification", payload)
        submit(c, event) {
            val key = payload.getString("notificationKey")
            // Repeated platform delivery is deduplicated, distinct updates and removals remain events.
            val hash = SourceRules.hash(payload.toString())
            if (!removed && seen[key] == hash) false else {
                if (removed) seen.remove(key) else {
                    if (seen.containsKey(key)) payload.put("action", "updated")
                    seen[key] = hash
                }; true
            }
        }
    }

    fun state(action: String) {
        val c = settings.read()
        if (!c.deviceEventCollectionEnabled || !allowed(c)) { lastState = null; return }
        val locked = context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
        val interactive = context.getSystemService(PowerManager::class.java).isInteractive
        val state = "$locked:$interactive"
        if (action == "state_observed" && lastState == state) return
        val payload = JSONObject().put("action", action).put("keyguardLocked", locked).put("screenInteractive", interactive)
        val event = envelope(c, "device_event", AppCollectionMode.CONTENT)
        event.getJSONObject("metadata").put("deviceEvent", payload)
        submit(c, event) {
            if (action == "state_observed" && lastState == state) false else { lastState = state; true }
        }
    }

    fun refresh() {
        val c = settings.read()
        if (!allowed(c)) { seen.clear(); lastState = null; Notifications.showEvents(context, null); return }
        if (!c.notificationCollectionEnabled) seen.clear()
        state("state_observed")
        Notifications.showEvents(context, listOfNotNull(
            if (c.notificationCollectionEnabled) MoteI18n.text("通知事件已启用") else null,
            if (c.deviceEventCollectionEnabled) MoteI18n.text("亮屏与锁定事件已启用") else null
        ).takeIf { it.isNotEmpty() }?.joinToString(" · "))
    }
    fun reset() { seen.clear(); lastState = null; session = UUID.randomUUID().toString() }
    private fun envelope(c: CollectorConfig, source: String, mode: AppCollectionMode): JSONObject {
        val at = Instant.now().toString()
        return JSONObject().put("id", UUID.randomUUID().toString()).put("deviceId", settings.deviceId).put("deviceName", c.deviceName)
            .put("platform", "android").put("capturedAt", at).put("durationMs", 0).put("source", source)
            .put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none")
                .put("collection", if (mode == AppCollectionMode.ACTIVITY) "activity" else "content"))
            .put("metadata", JSONObject().put("version", 1).put("observedAt", at)
                .put("collector", JSONObject().put("method", "notification_listener"))
                .put("observation", JSONObject().put("sessionId", session).put("elapsedRealtimeMs", SystemClock.elapsedRealtime())))
    }
    private fun submit(c: CollectorConfig, event: JSONObject, accept: () -> Boolean) {
        if (pending.incrementAndGet() > 128) { pending.decrementAndGet(); reportFailure(); return }
        val epoch = MediaCollection.epoch.get()
        worker.post {
            try {
                ConnectionGuard.sync {
                    if (!allowed(c) || settings.read() != c || MediaCollection.epoch.get() != epoch) return@sync
                    val before = LinkedHashMap(seen); val previousState = lastState
                    if (!accept()) return@sync
                    try {
                        settings.ensureDataOrigin(c)
                        context.queue().enqueue(event, null, c.maxQueueMiB * 1024L * 1024L)
                    } catch (error: Exception) { seen.clear(); seen.putAll(before); lastState = previousState; throw error }
                    UploadWorker.schedule(context, c)
                }
            } catch (_: Exception) { reportFailure() }
            finally { pending.decrementAndGet() }
        }
    }
    private fun reportFailure() {
        settings.status("error", MoteI18n.text("部分系统事件未能保存，请检查本机存储；事件历史可能不完整"))
    }
}
