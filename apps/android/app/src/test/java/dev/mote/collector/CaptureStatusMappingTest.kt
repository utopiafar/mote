package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** The shared JSON cases are the contract; this test never restates an expected row. */
class CaptureStatusMappingTest {
    private val cases by lazy { JSONArray(javaClass.classLoader!!.getResource("capture-status-cases.json")!!.readText()) }

    @Test fun everySharedCasePicksTheSameRowAndLevel() {
        assertEquals(20, cases.length())
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val expected = row(case.getJSONObject("expected"))
            assertEquals(case.getString("name"), expected, CaptureStatusMapping.status(facts(case.getJSONObject("facts"))))
            assertEquals("${case.getString("name")}: table", expected, CaptureStatusMapping.row(expected.id))
        }
    }

    @Test fun tableCoversTheTwelveStatesInSharedOrder() {
        assertEquals(listOf(
            CaptureStatusId.CAPTURING, CaptureStatusId.PENDING_SYNC, CaptureStatusId.SCREEN_PAUSED, CaptureStatusId.PAUSED,
            CaptureStatusId.SEND_PAUSED, CaptureStatusId.LOCAL_ONLY, CaptureStatusId.RECONNECT, CaptureStatusId.STORAGE_FULL,
            CaptureStatusId.INTERRUPTED, CaptureStatusId.PERMISSION, CaptureStatusId.SEND_ATTENTION, CaptureStatusId.DISCONNECTED
        ), CaptureStatusMapping.table.map { it.id })
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

    private fun row(json: JSONObject) = CaptureStatusRow(
        id = wire(CaptureStatusId.entries, CaptureStatusId::wire, json.getString("id")),
        level = wire(CaptureStatusLevel.entries, CaptureStatusLevel::wire, json.getString("level")),
        home = json.optJSONObject("home")?.let {
            CaptureStatusHome(it.getString("titleKey"), wire(CaptureStatusOperation.entries, CaptureStatusOperation::wire, it.getString("operation")))
        },
        notification = json.optJSONObject("notification")?.let {
            CaptureStatusNotification(it.getString("titleKey"), wire(CaptureStatusOperation.entries, CaptureStatusOperation::wire, it.getString("operation")),
                it.getJSONArray("platforms").let { platforms -> (0 until platforms.length()).map { index -> wire(CaptureStatusPlatform.entries, CaptureStatusPlatform::wire, platforms.getString(index)) } })
        },
        androidOngoing = json.stringOrNull("androidOngoing"),
        macIcon = json.stringOrNull("macIcon")?.let { wire(CaptureStatusMacIcon.entries, CaptureStatusMacIcon::wire, it) },
        central = json.optJSONObject("central")?.let {
            CaptureStatusCentral(it.getString("textKey"), wire(CaptureStatusTone.entries, CaptureStatusTone::wire, it.getString("tone")))
        }
    )

    private fun <T> wire(values: List<T>, wire: (T) -> String, value: String): T = values.first { wire(it) == value }
    private fun JSONObject.stringOrNull(key: String): String? = if (!has(key) || isNull(key)) null else getString(key)
    private fun JSONObject.booleanOrNull(key: String): Boolean? = if (!has(key) || isNull(key)) null else getBoolean(key)
}
