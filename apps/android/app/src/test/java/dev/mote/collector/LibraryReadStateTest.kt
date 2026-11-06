package dev.mote.collector

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The two independent Library readers must publish one truthful page state. */
class LibraryReadStateTest {
    private fun LibraryReadState.localEmpty() {
        localSettled(epoch, LibraryReadState.Stream.CAPTURES)
        localSettled(epoch, LibraryReadState.Stream.SOURCES)
    }

    @Test fun `signed out with an empty local library shows one status and a local empty state`() {
        val state = LibraryReadState().apply { begin() }
        state.localEmpty()
        state.centralPending(state.epoch, LibraryReadState.Stream.CAPTURES)
        state.centralPending(state.epoch, LibraryReadState.Stream.SOURCES)
        assertEquals("", state.status())
        assertEquals("本机没有资料，正在读取中央…", state.emptyText("", false, localMore = false, more = true))
        state.centralFailed(state.epoch, LibraryReadState.Stream.CAPTURES, LibraryReadState.signedOut())
        state.centralFailed(state.epoch, LibraryReadState.Stream.SOURCES, LibraryReadState.signedOut())
        assertEquals("先登录中央，各页面会共用这次登录", state.status())
        assertEquals("本机没有资料。", state.emptyText("", false, localMore = false, more = false))
        assertTrue("the old all-empty claim must wait for Central", state.emptyText("", false, false, false) != "这里还没有内容。点击添加，选择文件、屏幕或记录。")
    }

    @Test fun `one shared failure is shown once even when the readers finish with different transport errors`() {
        val state = LibraryReadState().apply { begin() }
        state.localEmpty()
        state.centralFailed(state.epoch, LibraryReadState.Stream.CAPTURES, LibraryReadState.signedOut())
        state.centralFailed(state.epoch, LibraryReadState.Stream.SOURCES,
            LibraryReadState.centralFailure(IllegalStateException("登录会话已变更，请重新打开中央页面。"), signedOut = true))
        assertEquals("先登录中央，各页面会共用这次登录", state.status())
        assertEquals(1, state.status().lines().size)
        state.begin(); state.localEmpty()
        state.centralFailed(state.epoch, LibraryReadState.Stream.CAPTURES, LibraryReadState.centralFailure(CentralFailure(403, "forbidden"), false))
        state.centralFailed(state.epoch, LibraryReadState.Stream.SOURCES, LibraryReadState.centralFailure(CentralFailure(403, "forbidden"), false))
        assertEquals(1, state.status().lines().size)
        assertTrue(state.status().startsWith("当前连接没有执行此操作的权限"))
    }

    @Test fun `a confirmed local filter still has a real empty state`() {
        val state = LibraryReadState().apply { begin() }
        state.localEmpty()
        state.centralReadable(state.epoch, LibraryReadState.Stream.CAPTURES)
        state.centralReadable(state.epoch, LibraryReadState.Stream.SOURCES)
        assertEquals("当前筛选下没有资料。", state.emptyText("", true, localMore = false, more = false))
        assertEquals("当前筛选下暂无本机资料。", state.emptyText("local", true, localMore = false, more = false))
        assertEquals("本机没有资料。", state.emptyText("local", false, localMore = false, more = false))
    }

    @Test fun `the whole library is only empty after Central finished reading`() {
        val state = LibraryReadState().apply { begin() }
        state.localEmpty()
        assertNull(state.emptyText("central", false, localMore = false, more = false))
        assertEquals("本机没有资料，正在读取中央…", state.emptyText("", false, localMore = false, more = true))
        assertEquals("当前筛选下暂无本机资料。", state.emptyText("", true, localMore = false, more = true))
        state.centralReadable(state.epoch, LibraryReadState.Stream.CAPTURES)
        state.centralReadable(state.epoch, LibraryReadState.Stream.SOURCES)
        assertEquals("这里还没有内容。点击添加，选择文件、屏幕或记录。", state.emptyText("", false, localMore = false, more = false))
        assertEquals("中央没有资料。", state.emptyText("central", false, localMore = false, more = false))
    }

    @Test fun `more pages never claim the filter is empty`() {
        val state = LibraryReadState().apply { begin() }
        state.localEmpty()
        state.centralReadable(state.epoch, LibraryReadState.Stream.CAPTURES)
        state.centralReadable(state.epoch, LibraryReadState.Stream.SOURCES)
        assertNull(state.emptyText("", false, localMore = false, more = true))
        assertNull(state.emptyText("central", false, localMore = false, more = true))
        assertEquals("本机没有资料。", state.emptyText("local", false, localMore = false, more = true))
        assertNull(state.emptyText("", false, localMore = true, more = true))
    }

    @Test fun `reconnecting clears the old failure and restores the settled empty state`() {
        val state = LibraryReadState().apply { begin() }
        state.localEmpty()
        state.centralFailed(state.epoch, LibraryReadState.Stream.CAPTURES,
            LibraryReadState.centralFailure(java.io.IOException("offline"), false))
        state.centralFailed(state.epoch, LibraryReadState.Stream.SOURCES,
            LibraryReadState.centralFailure(java.io.IOException("offline"), false))
        assertEquals("中央暂不可用 · 保留本机状态，恢复连接后重试", state.status())
        assertEquals(1, state.status().lines().size)
        state.begin(); state.localEmpty()
        state.centralReadable(state.epoch, LibraryReadState.Stream.CAPTURES)
        state.centralReadable(state.epoch, LibraryReadState.Stream.SOURCES)
        assertEquals("", state.status())
        assertEquals("这里还没有内容。点击添加，选择文件、屏幕或记录。", state.emptyText("", false, localMore = false, more = false))
    }

    @Test fun `a denied Central read keeps the local empty state without claiming all is empty`() {
        val state = LibraryReadState().apply { begin() }
        state.localEmpty()
        state.centralFailed(state.epoch, LibraryReadState.Stream.CAPTURES, LibraryReadState.centralFailure(CentralFailure(403, "forbidden"), false))
        state.centralFailed(state.epoch, LibraryReadState.Stream.SOURCES, LibraryReadState.centralFailure(CentralFailure(403, "forbidden"), false))
        assertEquals("本机没有资料。", state.emptyText("", false, localMore = false, more = false))
        assertNull(state.emptyText("central", false, localMore = false, more = false))
    }

    @Test fun `a skipped retry cannot erase the denial that stopped it`() {
        val state = LibraryReadState().apply { begin() }
        state.localEmpty()
        state.centralFailed(state.epoch, LibraryReadState.Stream.CAPTURES, LibraryReadState.centralFailure(CentralFailure(403, "forbidden"), false))
        state.centralSkipped(state.epoch, LibraryReadState.Stream.SOURCES)
        state.centralSkipped(state.epoch, LibraryReadState.Stream.CAPTURES)
        assertTrue(state.status().startsWith("当前连接没有执行此操作的权限"))
    }

    @Test fun `a local read failure cannot claim emptiness`() {
        val state = LibraryReadState().apply { begin() }
        state.localSettled(state.epoch, LibraryReadState.Stream.CAPTURES)
        state.localFailed(state.epoch, LibraryReadState.Stream.SOURCES, "资料暂不可读取，请稍后重试。")
        assertEquals("资料暂不可读取，请稍后重试。", state.status())
        assertNull(state.emptyText("", false, localMore = false, more = false))
    }

    @Test fun `quick filter switches ignore reports from the older page`() {
        val state = LibraryReadState()
        val stale = state.begin()
        state.begin()
        state.localSettled(stale, LibraryReadState.Stream.CAPTURES)
        state.localSettled(stale, LibraryReadState.Stream.SOURCES)
        state.centralFailed(stale, LibraryReadState.Stream.CAPTURES, LibraryReadState.signedOut())
        state.centralFailed(stale, LibraryReadState.Stream.SOURCES, LibraryReadState.signedOut())
        assertEquals("", state.status())
        assertNull(state.emptyText("", false, localMore = false, more = false))
        state.localEmpty()
        state.centralPending(state.epoch, LibraryReadState.Stream.CAPTURES)
        assertEquals("", state.status())
        assertEquals("本机没有资料，正在读取中央…", state.emptyText("", false, localMore = false, more = true))
    }

    @Test fun `failure priority keeps the actionable state when readers disagree`() {
        val state = LibraryReadState().apply { begin() }
        state.localEmpty()
        state.centralFailed(state.epoch, LibraryReadState.Stream.CAPTURES, LibraryReadState.signedOut())
        state.centralFailed(state.epoch, LibraryReadState.Stream.SOURCES,
            LibraryReadState.centralFailure(java.io.IOException("offline"), false))
        assertEquals("先登录中央，各页面会共用这次登录", state.status())
    }
}
