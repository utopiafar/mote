package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** Y04 send-state copy and Y01/Y03 source-row projection for the 采集与同步 page. */
class CaptureSyncPresentationTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private val now = Instant.parse("2026-11-05T13:42:00Z") // 21:42 local
    private val server = "https://mote.example.net"

    private fun send(
        server: String = this.server, connected: Boolean = true, paused: Boolean = false,
        state: String = "idle", pending: Int? = 0, acknowledgedAt: String? = "2026-11-05T13:42:00Z",
    ) = CaptureSyncPresentation.send(server, connected, paused, state, pending, acknowledgedAt, now, zone)

    @Test fun syncedShowsTheLastAcknowledgedTime() {
        val view = send()
        assertEquals(CaptureSyncPresentation.SendState.SYNCED, view.state)
        assertEquals("mote.example.net", view.host)
        assertEquals("已同步 · 21:42", view.text)
        assertFalse(view.warn); assertNull(view.actionLabel)
    }

    @Test fun pendingNamesTheCountAndOffersSendNow() {
        val view = send(pending = 12)
        assertEquals(CaptureSyncPresentation.SendState.PENDING, view.state)
        assertEquals("待同步 12 条", view.text)
        assertEquals("立即发送", view.actionLabel)
    }

    @Test fun pausedSendStaysAPlainStateWithoutAnAction() {
        val view = send(paused = true)
        assertEquals(CaptureSyncPresentation.SendState.PAUSED, view.state)
        assertEquals("发送已暂停", view.text)
        assertNull(view.actionLabel)
    }

    @Test fun invalidCredentialsAndSendErrorsAskForReconnect() {
        for (view in listOf(send(connected = false), send(state = "error"), send(state = "blocked"))) {
            assertEquals(CaptureSyncPresentation.SendState.RECONNECT, view.state)
            assertEquals("需要重新连接", view.text)
            assertTrue(view.warn)
            assertEquals("连接", view.actionLabel)
        }
    }

    @Test fun aNeverConfiguredCentralStaysLocalWithoutAnAction() {
        val view = send(server = "", connected = false)
        assertEquals(CaptureSyncPresentation.SendState.LOCAL, view.state)
        assertEquals("尚未连接", view.host)
        assertEquals("仅保存在本机", view.text)
        assertNull(view.actionLabel)
    }

    @Test fun pausedTakesPrecedenceOverPendingButNotReconnect() {
        assertEquals(CaptureSyncPresentation.SendState.PAUSED, send(paused = true, pending = 9).state)
        assertEquals(CaptureSyncPresentation.SendState.RECONNECT, send(connected = false, paused = true, pending = 9).state)
    }

    @Test fun hostStripsSchemeAndPath() {
        assertEquals("mote.example.net", CaptureSyncPresentation.host("https://mote.example.net/"))
        assertEquals("127.0.0.1:47842", CaptureSyncPresentation.host("http://127.0.0.1:47842/api"))
        assertEquals("尚未连接", CaptureSyncPresentation.host("  "))
    }

    @Test fun sendMethodSummarizesWifiOnlyOrTheSyncMode() {
        assertEquals("仅 Wi-Fi", CaptureSyncPresentation.sendMethodLabel("realtime", wifiOnly = true))
        assertEquals("仅 Wi-Fi", CaptureSyncPresentation.sendMethodLabel("batch", wifiOnly = true))
        assertEquals("仅手动发送", CaptureSyncPresentation.sendMethodLabel("manual", wifiOnly = false))
        assertEquals("有新内容时发送", CaptureSyncPresentation.sendMethodLabel("realtime", wifiOnly = false))
        assertEquals("有新内容时发送", CaptureSyncPresentation.syncModeLabel("realtime"))
        assertEquals("定时发送", CaptureSyncPresentation.syncModeLabel("interval"))
    }

    private fun sources(
        screen: CaptureSyncPresentation.KindFacts = CaptureSyncPresentation.KindFacts(false),
        observations: CaptureSyncPresentation.KindFacts = CaptureSyncPresentation.KindFacts(false),
        media: CaptureSyncPresentation.KindFacts = CaptureSyncPresentation.KindFacts(false),
        files: List<CaptureSyncPresentation.SourceFacts> = emptyList(),
        calendars: List<CaptureSyncPresentation.SourceFacts> = emptyList(),
    ) = CaptureSyncPresentation.sources(screen, observations, media, files, calendars, now, zone)

    @Test fun onlyAddedSourcesAreListed() {
        val rows = sources(
            screen = CaptureSyncPresentation.KindFacts(present = true, lastAt = "2026-11-05T13:40:00Z"),
            files = listOf(
                CaptureSyncPresentation.SourceFacts("f1", enabled = true, status = "synced", lastScan = ""),
                CaptureSyncPresentation.SourceFacts("f2", enabled = true, status = "synced", lastScan = "")),
            calendars = listOf(CaptureSyncPresentation.SourceFacts("c1", enabled = true, status = "synced", lastScan = "2026-11-05T02:00:00Z")))
        assertEquals(listOf("屏幕与应用活动", "同步文件夹", "本机日历"), rows.map { it.title })
        assertEquals("21:40", rows[0].detail)
        assertEquals("2 个", rows[1].detail)
        assertEquals("今天", rows[2].detail)
        assertTrue(rows.none { it.warn || it.actionLabel != null })
    }

    @Test fun aKindNeedingAttentionShowsStatusAndHandle() {
        val rows = sources(observations = CaptureSyncPresentation.KindFacts(present = true, needsAction = true))
        val row = rows.single()
        assertEquals("通知与设备事件", row.title)
        assertEquals("等待采集权限", row.detail)
        assertTrue(row.warn)
        assertEquals("处理", row.actionLabel)
    }

    @Test fun aSourceNeedingAttentionSurfacesItsIdForDetails() {
        val rows = sources(files = listOf(
            CaptureSyncPresentation.SourceFacts("ok", enabled = true, status = "synced", lastScan = ""),
            CaptureSyncPresentation.SourceFacts("bad", enabled = true, status = "permission", lastScan = "")))
        val row = rows.single()
        assertEquals("等待采集权限", row.detail)
        assertEquals("处理", row.actionLabel)
        assertEquals("bad", row.attentionSourceId)
    }

    @Test fun sourceStatusesKeepTheirCompactCopy() {
        for ((status, detail) in listOf(
            "consent" to "需要确认发送范围", "context-conflict" to "资料说明冲突",
            "context-http" to "资料说明等待确认", "provider" to "暂时无法读取", "paused" to "中央已暂停")) {
            val rows = sources(calendars = listOf(CaptureSyncPresentation.SourceFacts("x", enabled = true, status = status, lastScan = "")))
            assertEquals(status, detail, rows.single().detail)
            assertTrue(status, rows.single().warn)
        }
    }

    @Test fun fullyDisabledKindsReportPaused() {
        val rows = sources(files = listOf(CaptureSyncPresentation.SourceFacts("f", enabled = false, status = "synced", lastScan = "")))
        assertEquals("已暂停", rows.single().detail)
        assertFalse(rows.single().warn)
        assertNull(rows.single().actionLabel)
    }

    @Test fun recencyUsesTodayTimeYesterdayAndDates() {
        assertEquals("21:40", CaptureSyncPresentation.recentLabel("2026-11-05T13:40:00Z", now, zone))
        assertEquals("昨天", CaptureSyncPresentation.recentLabel("2026-11-04T13:40:00Z", now, zone))
        assertTrue(CaptureSyncPresentation.recentLabel("2026-10-04T13:40:00Z", now, zone).isNotBlank())
        assertEquals("", CaptureSyncPresentation.recentLabel(null, now, zone))
        assertEquals("", CaptureSyncPresentation.recentLabel("not-a-date", now, zone))
    }

    @Test fun calendarRecencyStaysAtDayGranularity() {
        assertEquals("今天", CaptureSyncPresentation.dayLabel("2026-11-05T02:00:00Z", now, zone))
        assertEquals("昨天", CaptureSyncPresentation.dayLabel("2026-11-04T02:00:00Z", now, zone))
        assertTrue(CaptureSyncPresentation.dayLabel("2026-10-04T02:00:00Z", now, zone).isNotBlank())
        assertEquals("", CaptureSyncPresentation.dayLabel(null, now, zone))
    }

    @Test fun addSourceOffersTheFiveEntriesWithOnlyCloudLeavingTheApp() {
        assertEquals(
            listOf("导入文件", "同步文件夹", "连接本机日历", "屏幕与应用活动", "云端来源"),
            CaptureSyncPresentation.addKinds.map { it.titleKey })
        assertEquals(listOf(false, false, false, false, true), CaptureSyncPresentation.addKinds.map { it.opensCentral })
    }

    @Test fun addSourceHidesSingleInstanceKindsThatAreAlreadyAdded() {
        assertEquals(listOf("导入文件", "同步文件夹", "连接本机日历", "屏幕与应用活动", "云端来源"),
            CaptureSyncPresentation.availableAddKinds(emptySet()).map { it.titleKey })
        assertEquals(listOf("导入文件", "同步文件夹", "云端来源"),
            CaptureSyncPresentation.availableAddKinds(setOf(CaptureSyncPresentation.SourceKind.CALENDAR, CaptureSyncPresentation.SourceKind.SCREEN)).map { it.titleKey })
        assertEquals(listOf("导入文件", "同步文件夹", "屏幕与应用活动", "云端来源"),
            CaptureSyncPresentation.availableAddKinds(setOf(CaptureSyncPresentation.SourceKind.CALENDAR)).map { it.titleKey })
        assertEquals(listOf("导入文件", "同步文件夹", "连接本机日历", "云端来源"),
            CaptureSyncPresentation.availableAddKinds(setOf(CaptureSyncPresentation.SourceKind.SCREEN)).map { it.titleKey })
    }

    @Test fun storageUsesHumanSizes() {
        assertEquals("1.2 GB", CaptureSyncPresentation.storageLabel(1288490189L))
        assertEquals("36.0 MiB", CaptureSyncPresentation.storageLabel(37748736L))
        assertEquals("12 KiB", CaptureSyncPresentation.storageLabel(12288L))
        assertEquals("", CaptureSyncPresentation.storageLabel(null))
    }
}
