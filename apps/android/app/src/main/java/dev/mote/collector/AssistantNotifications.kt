package dev.mote.collector

import org.json.JSONObject
import java.net.URLEncoder
import java.time.Instant

/** The server's existing wire projection. No client-side eligibility or semantic rules. */
internal data class AssistantNotice(val id: String, val revision: Long, val title: String, val reason: String, val eligibleAt: String, val expiresAt: String) {
    companion object {
        fun snapshot(value: JSONObject): List<AssistantNotice> {
            val items = value.getJSONArray("items"); require(items.length() <= 1)
            return (0 until items.length()).map { index ->
                val v = items.getJSONObject(index)
                AssistantNotice(v.getString("id"), v.getLong("revision"), v.getString("title"), v.getString("reason"), v.getString("eligibleAt"), v.getString("expiresAt")).also {
                    require(MoteLink.uuidId(it.id) != null && it.revision in 1..9007199254740991L && it.title.length in 1..500 && it.reason.length in 1..2000)
                    require(Instant.parse(it.expiresAt).isAfter(Instant.parse(it.eligibleAt)))
                }
            }
        }
    }
}

internal data class AssistantNoticeCursor(val origin: String, val id: String, val eligibleAt: String, val shownAt: Long)

/** One bounded presentation cursor, never an inbox or a delivery ledger.
 * A content update cancels stale OS text without alerting again. Only a new
 * server occurrence (e.g. later-until) changes eligibleAt. The server spaces
 * eligible instants; this client also keeps the configured gap between its
 * actual displays when polling was delayed. */
internal class AssistantNoticePresenter(
    private val cursor: () -> AssistantNoticeCursor?,
    private val save: (AssistantNoticeCursor) -> Unit,
    private val post: (AssistantNotice) -> Unit,
    private val cancel: () -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private var active: AssistantNotice? = null
    private var activeOrigin: String? = null
    @Synchronized fun clear() { active = null; activeOrigin = null; cancel() }
    @Synchronized fun expire() { if (active?.let { Instant.parse(it.expiresAt).toEpochMilli() <= now() } == true) clear() }
    @Synchronized fun update(origin: String, snapshot: JSONObject, allowed: Boolean) {
        val event = AssistantNotice.snapshot(snapshot).firstOrNull { Instant.parse(it.eligibleAt).toEpochMilli() <= now() && now() < Instant.parse(it.expiresAt).toEpochMilli() }
        if (!allowed || event == null) { clear(); return }
        if (activeOrigin == origin && active == event) return
        clear()
        val key = AssistantNoticeCursor(origin, event.id, event.eligibleAt, now())
        // A frequency/quiet-hours edit may project an older slot again. It must
        // not replay an alert that precedes this device's presentation cursor.
        if (cursor()?.let { it.origin == origin && !Instant.parse(it.eligibleAt).isBefore(Instant.parse(event.eligibleAt)) } == true) return
        // The server only spaces eligible instants; without a delivery ledger a
        // delayed poll could otherwise show this event too soon after the last one.
        // Its slot length is the server interval capped at 24 hours.
        val interval = Instant.parse(event.expiresAt).toEpochMilli() - Instant.parse(event.eligibleAt).toEpochMilli()
        if (cursor()?.let { it.origin == origin && now() < it.shownAt + interval } == true) return
        try { post(event); save(key.copy(shownAt = now())); active = event; activeOrigin = origin }
        catch (error: Exception) { clear(); throw error }
    }
}

/** Narrow current-card projection for the notification's read-only inbox.
 * No captured text can supply an origin, path or executable command. */
internal data class AssistantCardPreview(val id: String, val revision: Long, val title: String, val body: String, val readAt: String?) {
    companion object {
        fun read(value: JSONObject): AssistantCardPreview {
            if (value.getString("state") == "stale" || value.optBoolean("evidenceStale")) throw CentralFailure(404, "not_found")
            require(value.getString("state") in setOf("open", "resolved"))
            return AssistantCardPreview(value.getString("id"), value.getLong("revision"), value.getString("title"), value.getString("body"), if (value.isNull("readAt")) null else value.getString("readAt")).also {
                require(MoteLink.uuidId(it.id) != null && it.revision in 1..9007199254740991L && it.title.length in 1..500 && it.body.length in 1..32000)
                it.readAt?.let(Instant::parse)
            }
        }
    }
}

internal class AssistantNotificationReader(private val client: CentralClient) {
    data class Page(val items: List<AssistantCardPreview>, val nextCursor: String?)
    private val scope = "scope=" + URLEncoder.encode("{\"kind\":\"all\"}", "UTF-8")
    fun snapshot() = client.get("/api/assistant-notifications?$scope").also(AssistantNotice::snapshot)
    fun page(cursor: String? = null): Page {
        val value = client.get("/api/assistant-cards?$scope&limit=30" + (cursor?.let { "&cursor=" + URLEncoder.encode(it, "UTF-8") } ?: ""))
        val items = value.getJSONArray("items"); require(items.length() <= 30)
        val next = if (value.isNull("nextCursor")) null else value.getString("nextCursor").also { require(it.length in 1..1000) }
        return Page((0 until items.length()).map { AssistantCardPreview.read(items.getJSONObject(it)) }, next)
    }
    fun card(id: String, markRead: Boolean = false): AssistantCardPreview {
        require(MoteLink.uuidId(id) != null)
        val path = "/api/assistant-cards/$id"
        val card = AssistantCardPreview.read(client.get("$path?$scope")); require(card.id == id)
        // Reading the OS projection is read-only. Only the owner's card click
        // sends feedback to the card store, the one cross-device read-state authority.
        if (!markRead || card.readAt != null) return card
        return try {
            AssistantCardPreview.read(client.post("$path/feedback?$scope", JSONObject().put("expectedRevision", card.revision).put("action", "read"))).also { require(it.id == id && it.readAt != null) }
        } catch (error: CentralFailure) {
            if (error.status == 409) card(id) else throw error
        }
    }
}
