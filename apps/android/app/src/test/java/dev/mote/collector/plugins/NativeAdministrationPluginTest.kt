package dev.mote.collector.plugins

import dev.mote.collector.MemoryDetailPanel
import dev.mote.collector.MoteI18n
import dev.mote.collector.MoteNavigation
import dev.mote.collector.SettingsSummaryConfig
import dev.mote.collector.SettingsSummaryState
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Administration is one build-native scope owning the Central manager, the
 * committed settings summary and the processing presentation. */
class NativeAdministrationPluginTest {
    private fun started(): Pair<NativePluginHost, AdministrationOwner> {
        val registry = NativePluginRegistry().apply { NativeAdministrationPlugin.register(this, "generated-build") }
        val host = NativePluginHost(registry)
        val identity = PluginInstanceIdentity("dev.mote.administration", "generated-installation", NativeAdministrationPlugin.INSTANCE_ID)
        val scope = (host.createScope(PluginInstanceDescriptor(identity, setOf(NativeAdministrationPlugin.CAPABILITY), requires = listOf(NativeAdministrationPlugin.requirement()))) as PluginResult.Ok).value
        return host to NativeAdministrationPlugin.open(host, scope)
    }

    @Test fun builtinProviderRegistersTheAdministrationScopeAndServices() {
        val registry = NativePluginRegistry().apply { NativeAdministrationPlugin.register(this, "generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(NativeAdministrationPlugin.requirement()))

        val (host, owner) = started()
        assertTrue(owner.active)
        assertEquals(
            setOf("administration.central", "administration.settings", "administration.runtime", "administration.connection"),
            host.scope(NativeAdministrationPlugin.INSTANCE_ID)!!.services.keys,
        )
        assertTrue(host.scope(NativeAdministrationPlugin.INSTANCE_ID)!!.jobs.containsKey("administration.summary"))
    }

    @Test fun settingsSummaryAndProcessingPresentationBelongToTheOwner() {
        val (host, owner) = started()
        val summary = owner.settingsSummary()
        val config = SettingsSummaryConfig("https://generated.invalid", syncPaused = true)
        summary.committed(config)
        assertEquals(SettingsSummaryState.Current(config), summary.state)
        assertEquals("等待你确认", owner.processing().stateKey("blocked", "awaiting_confirmation"))
        assertEquals("处理结果未知", owner.processing().stateKey("waiting", "processor_response_unknown"))

        host.stopScope(NativeAdministrationPlugin.INSTANCE_ID)
        assertFalse(owner.active)
        val stopped = runCatching { owner.processing() }
        assertTrue(stopped.isFailure)
    }

    /** AN5-01: the "m" pages keep the current bottom tab and return to it. */
    @Test fun manageDestinationsKeepTheCurrentTabAndReturnToIt() {
        assertEquals(listOf("memory", "skills", "connections", "settings"), ManageDestination.entries.map { it.navId })
        assertEquals("SERVICES", ManageDestination.CONNECTIONS.page)
        for (destination in ManageDestination.entries) {
            assertNull("a manage page never selects a bottom tab", MoteNavigation.tabId(destination.page))
            assertEquals("ASK", ManageBack.target(destination.page, "ASK"))
            assertEquals("LIBRARY", ManageBack.target(destination.page, "LIBRARY"))
        }
        assertNull(ManageBack.target("LIBRARY", "ASK"))
    }

    /** AN5-03: phone settings keep their own groups and add notifications and
     * the one Central workspace entry. */
    @Test fun settingsKeepPhoneGroupsAndAddNotificationsAndCentralWorkspace() {
        assertEquals(
            listOf("连接与设备", "外观与语言", "备份与恢复", "诊断与支持", "通知", "关于与更新", "中央工作台"),
            SettingsAction.entries.map { it.label },
        )
        assertEquals("choices", SettingsAction.NOTIFICATIONS.group)
        assertEquals("workbench", SettingsAction.CENTRAL_WORKBENCH.group)
        assertTrue(SettingsAction.CENTRAL_WORKBENCH.external)
    }

    /** AN5-02: a rejected local connection reads as reauthorization, not healthy. */
    @Test fun localConnectionStatusFollowsTheLastAttempt() {
        assertEquals(MoteI18n.text("已连接"), AdministrationConnectionStatus.label("connected"))
        assertEquals(MoteI18n.text("尚未测试连接"), AdministrationConnectionStatus.label("unchecked"))
        assertEquals(MoteI18n.text("需要重新授权"), AdministrationConnectionStatus.label("authentication"))
        assertEquals(MoteI18n.text("需要重新授权"), AdministrationConnectionStatus.label("permission"))
        assertEquals(MoteI18n.text("网络不可用"), AdministrationConnectionStatus.label("network"))
        assertTrue(AdministrationConnectionStatus.needsReauthorization("authentication"))
        assertTrue(AdministrationConnectionStatus.needsReauthorization("permission"))
        assertTrue(AdministrationConnectionStatus.needsReauthorization("expired"))
        assertFalse(AdministrationConnectionStatus.needsReauthorization("connected"))
    }

    /** AN5-02: external cards project the owner API state and action set verbatim. */
    @Test fun connectionServiceCardsFollowTheServerStateAndActions() {
        val view = ConnectionServicesProjection.view(JSONObject("""
            {"revision":"generated-revision","services":[
              {"id":"gmail","name":"Gmail","kind":"service","state":"reauth",
               "jobs":[{"kind":"gmail","every":"5m","lastAt":"2026-11-20T10:00:00Z","lastCount":2}],
               "tools":["calendar.manage"],"actions":["reauth","remove"]},
              {"id":"generated-agent","name":"Generated Agent","kind":"ai-access","state":"connected",
               "jobs":[],"tools":[],"actions":["remove"]},
              {"id":"connected-service","name":"Connected service","kind":"service","state":"connected",
               "jobs":[],"tools":[],"actions":["sync","dry-run","pause","remove"]}
            ]}
        """.trimIndent()))
        assertEquals("generated-revision", view.revision)
        assertEquals(3, view.services.size)
        val reauth = view.services.first { it.id == "gmail" }
        assertEquals("需要重新授权", ConnectionServicesProjection.stateLabel(reauth.state))
        assertEquals(listOf("重新授权", "移除"), reauth.actions.map(ConnectionServicesProjection::actionLabel))
        assertTrue(ConnectionServicesProjection.attention(reauth.state))
        assertTrue(ConnectionServicesProjection.jobLabel(reauth.jobs.single()).startsWith("取数 · gmail · 5m"))
        assertTrue(ConnectionServicesProjection.jobLabel(reauth.jobs.single()).endsWith("2 条"))
        val access = view.services.first { it.id == "generated-agent" }
        assertEquals("AI 接入", ConnectionServicesProjection.kindLabel(access.kind))
        assertEquals("外部服务", ConnectionServicesProjection.kindLabel(reauth.kind))
        assertEquals(listOf("移除"), access.actions.map(ConnectionServicesProjection::actionLabel))
        val connected = view.services.first { it.id == "connected-service" }
        assertEquals(listOf("立即同步", "试运行", "暂停", "移除"), connected.actions.map(ConnectionServicesProjection::actionLabel))
        assertFalse(ConnectionServicesProjection.attention(connected.state))
    }

    /** AN5-05: Memory detail keeps the four "More" actions and the D28 delete copy. */
    @Test fun memoryDetailKeepsFourMoreActionsAndTheD28DeleteCopy() {
        assertEquals(listOf("纠正这条记忆", "历史与有效时间", "生成信息", "删除记忆"), MemoryDetailPanel.moreItems)
        assertEquals("删除这条记忆？", MemoryDetailPanel.deleteTitle)
        assertEquals("原始资料保留。同一批旧证据不会重新生成这个结论；有新证据时可以重新判断。", MemoryDetailPanel.deleteMessage)
        assertEquals("确认删除", MemoryDetailPanel.deleteConfirm)
    }
}
