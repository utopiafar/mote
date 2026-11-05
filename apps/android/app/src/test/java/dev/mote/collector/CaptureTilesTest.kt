package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** The shared JSON cases decide the tile face too; this test never restates a facts→row expectation. */
class CaptureTilesTest {
    private val cases by lazy { JSONArray(javaClass.classLoader!!.getResource("capture-status-cases.json")!!.readText()) }

    /** The screen tile is on for every running row and off for every paused, stopped or interrupted row. */
    @Test fun theScreenTileFollowsTheSharedStatusRow() {
        assertEquals(20, cases.length())
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val expected = case.getJSONObject("expected").getString("id")
            val face = CaptureTiles.screen(facts(case.getJSONObject("facts")))
            val off = expected in setOf("screen_paused", "paused", "interrupted", "disconnected")
            assertEquals("${case.getString("name")}: switch", !off, face.active)
            val subtitle = when (expected) {
                "interrupted", "disconnected" -> "已停止"
                "screen_paused", "paused" -> "已暂停"
                else -> "采集中"
            }
            assertEquals("${case.getString("name")}: subtitle", subtitle, face.subtitle)
        }
    }

    /** The send tile is on exactly while the shared row reports the send pause; unconfigured devices show local only. */
    @Test fun theSendTileMirrorsTheConfiguredSendPause() {
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val facts = case.getJSONObject("facts")
            val expected = case.getJSONObject("expected").getString("id")
            val configured = facts.getString("connection") != "unconfigured"
            val paused = facts.getString("syncState") == "paused"
            val attention = facts.getString("syncState") in setOf("error", "blocked")
            val face = CaptureTiles.send(configured, paused, attention)
            assertEquals("${case.getString("name")}: switch", expected == "send_paused", face.active)
            val subtitle = when {
                !configured -> "仅保存在本机"
                paused -> "已暂停"
                attention -> "发送需要处理"
                else -> "发送中"
            }
            assertEquals("${case.getString("name")}: subtitle", subtitle, face.subtitle)
        }
    }

    /** The device-facts read feeding both tiles lands on the shared send-paused row. */
    @Test fun overviewFactsShiftOntoTheSharedRows() {
        val overview = CaptureOverview.Facts(
            enabled = true, state = "capturing", message = "", used = true,
            screenSelected = true, screenLive = true, projection = false, screenPausedAt = null,
            notifications = true, deviceEvents = true, media = false, systemLive = true,
            queueFull = false, folders = 0,
            connected = true, sendPaused = true, sendState = "paused", pending = 3, acknowledged = true
        )
        val facts = CaptureOverview.statusFacts(overview)
        assertEquals(CaptureStatusId.SEND_PAUSED, CaptureStatusMapping.status(facts).id)
        assertEquals(CaptureTileFace(true, "采集中"), CaptureTiles.screen(facts))
        assertEquals(CaptureTileFace(true, "已暂停"), CaptureTiles.send(overview.connected, overview.sendPaused, overview.sendState in setOf("error", "blocked")))
    }

    /** A stopped capture plugin leaves the tile off and says so. */
    @Test fun aStoppedCaptureShowsTheStoppedFace() {
        assertEquals(CaptureTileFace(false, "已停止"), CaptureTiles.screen(null))
    }

    /** The tile the owner taps to pause reports the paused row while other sources continue. */
    @Test fun anExplicitScreenPauseLeavesTheScreenTileOff() {
        val overview = CaptureOverview.Facts(
            enabled = true, state = "capturing", message = "", used = true,
            screenSelected = false, screenLive = false, projection = false, screenPausedAt = 1_760_000_000_000L,
            notifications = true, deviceEvents = false, media = false, systemLive = true,
            queueFull = false, folders = 0,
            connected = false, sendPaused = false, sendState = "unconfigured", pending = 0, acknowledged = true
        )
        val facts = CaptureOverview.statusFacts(overview)
        assertEquals(CaptureStatusId.SCREEN_PAUSED, CaptureStatusMapping.status(facts).id)
        assertEquals(CaptureTileFace(false, "已暂停"), CaptureTiles.screen(facts))
    }

    private fun facts(json: JSONObject) = CaptureStatusFacts(
        connection = wire(CaptureConnection.entries, CaptureConnection::wire, json.getString("connection")),
        captureEnabled = json.getBoolean("captureEnabled"), captureLive = json.getBoolean("captureLive"),
        screenPausedAt = json.stringOrNull("screenPausedAt"),
        permission = json.stringOrNull("permission")?.let { wire(CapturePermission.entries, CapturePermission::wire, it) },
        storageFull = json.booleanOrNull("storageFull"), interrupted = json.booleanOrNull("interrupted"),
        syncState = wire(CaptureSyncState.entries, CaptureSyncState::wire, json.getString("syncState")),
        pending = if (json.has("pending") && !json.isNull("pending")) json.getInt("pending") else null,
        disconnected = json.booleanOrNull("disconnected")
    )

    private fun <T> wire(values: List<T>, wire: (T) -> String, value: String): T = values.first { wire(it) == value }
    private fun JSONObject.stringOrNull(key: String): String? = if (!has(key) || isNull(key)) null else getString(key)
    private fun JSONObject.booleanOrNull(key: String): Boolean? = if (!has(key) || isNull(key)) null else getBoolean(key)
}
