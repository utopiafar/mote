package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** H06/H09: the home takes at most one row from the shared status contract. */
class HomeNoticeTest {
    private val cases by lazy { JSONArray(javaClass.classLoader!!.getResource("capture-status-cases.json")!!.readText()) }

    @Test fun everySharedCasePicksAtMostOneNotice() {
        assertEquals(20, cases.length())
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val factsJson = case.getJSONObject("facts")
            val expected = case.getJSONObject("expected")
            val facts = facts(factsJson)
            val expectedHome = expected.optJSONObject("home")
            val level = wire(CaptureStatusLevel.entries, CaptureStatusLevel::wire, expected.getString("level"))
            val notice = HomeNotice.from(facts)
            val name = case.getString("name")
            if (facts.connection == CaptureConnection.UNCONFIGURED && level != CaptureStatusLevel.NEEDS_ACTION) {
                assertEquals("$name: first use", HomeNotice.connect(), notice)
                continue
            }
            if (expectedHome == null) {
                assertNull("$name: no home row", notice)
                continue
            }
            val operation = wire(CaptureStatusOperation.entries, CaptureStatusOperation::wire, expectedHome.getString("operation"))
            assertEquals("$name: title", expectedHome.getString("titleKey"), notice?.titleKey)
            assertEquals("$name: action", actionKey(operation), notice?.actionKey)
            assertEquals("$name: level", level, notice?.level)
            assertEquals("$name: operation", HomeNotice.Operation.Capture(operation), notice?.operation)
        }
    }

    @Test fun unconnectedFirstUseIsTheOnlyStateThatAddsConnect() {
        val firstUse = CaptureStatusFacts(
            connection = CaptureConnection.UNCONFIGURED,
            captureEnabled = false,
            captureLive = false,
            syncState = CaptureSyncState.UNCONFIGURED,
        )
        assertEquals(HomeNotice.connect(), HomeNotice.from(firstUse))
        val interrupted = homeFacts(connection = CaptureConnection.UNCONFIGURED, permission = CapturePermission.MISSING)
        assertEquals("等待采集权限", HomeNotice.from(interrupted)?.titleKey)
        assertEquals(CaptureStatusLevel.NEEDS_ACTION, HomeNotice.from(interrupted)?.level)
    }

    private fun homeFacts(connection: CaptureConnection, permission: CapturePermission? = null) = CaptureStatusFacts(
        connection = connection, captureEnabled = true, captureLive = permission == null,
        permission = permission, syncState = if (connection == CaptureConnection.CONNECTED) CaptureSyncState.IDLE else CaptureSyncState.UNCONFIGURED,
    )

    private fun facts(json: JSONObject) = CaptureStatusFacts(
        connection = wire(CaptureConnection.entries, CaptureConnection::wire, json.getString("connection")),
        captureEnabled = json.getBoolean("captureEnabled"), captureLive = json.getBoolean("captureLive"),
        screenPausedAt = json.stringOrNull("screenPausedAt"),
        permission = json.stringOrNull("permission")?.let { wire(CapturePermission.entries, CapturePermission::wire, it) },
        storageFull = json.booleanOrNull("storageFull"), interrupted = json.booleanOrNull("interrupted"),
        syncState = wire(CaptureSyncState.entries, CaptureSyncState::wire, json.getString("syncState")),
        pending = if (json.has("pending") && !json.isNull("pending")) json.getInt("pending") else null,
        disconnected = json.booleanOrNull("disconnected"),
    )

    private fun actionKey(operation: CaptureStatusOperation) = when (operation) {
        CaptureStatusOperation.RESUME_CAPTURE, CaptureStatusOperation.RESUME_SEND -> "恢复"
        CaptureStatusOperation.RECONNECT -> "连接"
        CaptureStatusOperation.RESTART_CAPTURE -> "重新开启"
        CaptureStatusOperation.OPEN_PERMISSIONS, CaptureStatusOperation.OPEN_STORAGE, CaptureStatusOperation.OPEN_SYNC -> "处理"
    }

    private fun <T> wire(values: List<T>, wire: (T) -> String, value: String): T = values.first { wire(it) == value }
    private fun JSONObject.stringOrNull(key: String): String? = if (!has(key) || isNull(key)) null else getString(key)
    private fun JSONObject.booleanOrNull(key: String): Boolean? = if (!has(key) || isNull(key)) null else getBoolean(key)
}
