package dev.mote.collector

import android.app.Application
import dev.mote.collector.plugins.SystemEntriesPlugin
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35])
class MoteQuickEntriesTest {
    @Test fun launcherListsChatAndOpensTheMainConversation() {
        val entries = SystemEntriesPlugin.quickEntries(SystemEntriesPlugin.Availability(active = true))
        assertEquals(listOf("记录", "拍照", "录音", "聊天"), entries.map { it.label })

        val chat = entries.single { it.label == "聊天" }
        val destination = chat.destination(RuntimeEnvironment.getApplication())
        assertEquals(MainActivity::class.java.name, destination.component?.className)
        val page = requireNotNull(destination.getStringExtra("page"))
        assertEquals(TabFrame.ASK_PAGE, page)
        assertEquals("chat", MoteNavigation.tabId(page))
    }
}
