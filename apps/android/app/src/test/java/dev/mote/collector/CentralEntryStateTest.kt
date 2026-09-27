package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class CentralEntryStateTest {
    @Test fun defaultEndpointAndOrdinarySettingsSaveDoNotAuthorizeBrowsing() {
        val state = CentralEntryState()
        assertFalse(state.begin("http://127.0.0.1:47842", ""))
        assertEquals(CentralEntryState.Phase.NEEDS_NODE, state.phase)
        assertFalse(state.showWeb)
        state.finished()
        assertFalse(state.showWeb)
    }

    @Test fun explicitEndpointDoesNotRequireOrCarryCollectorCredentials() {
        val state = CentralEntryState()
        assertTrue(state.begin("https://central.fixture.invalid/", "https://central.fixture.invalid"))
        assertFalse(state.showWeb)
        state.finished()
        assertTrue(state.showWeb)
        assertEquals("https://central.fixture.invalid", state.server)
    }

    @Test fun mainFrameErrorStaysNativeEvenWhenWebViewReportsPageFinished() {
        val state = CentralEntryState()
        assertTrue(state.begin("https://central.fixture.invalid", "https://central.fixture.invalid"))
        state.failed()
        state.finished()
        assertEquals(CentralEntryState.Phase.FAILED, state.phase)
        assertFalse(state.showWeb)
        assertTrue(state.begin("https://central.fixture.invalid", "https://central.fixture.invalid"))
        state.finished()
        assertTrue(state.showWeb)
    }

    @Test fun resumingSameSelectedNodePreservesAnExistingPageAndPendingLoad() {
        val state = CentralEntryState()
        val endpoint = "https://central.fixture.invalid"
        assertFalse(state.canResume(endpoint, endpoint))
        state.begin(endpoint, endpoint)
        assertTrue(state.canResume(endpoint, endpoint))
        state.finished()
        assertTrue(state.canResume("$endpoint/", endpoint))
        assertFalse(state.canResume("https://other.fixture.invalid", "https://other.fixture.invalid"))
        assertFalse(state.canResume(endpoint, ""))
        state.failed()
        assertFalse(state.canResume(endpoint, endpoint))
    }

    @Test fun changedEndpointMustMatchTheExplicitSelectionAndOldOriginIsNotReused() {
        val state = CentralEntryState()
        val old = "http://127.0.0.1:47842"
        val next = "http://127.0.0.1:57515"
        assertTrue(state.begin(old, old))
        state.finished()
        assertFalse(state.begin(next, old))
        assertFalse(state.showWeb)
        assertTrue(state.begin(next, next))
        assertEquals(next, state.server)
        assertFalse(state.showWeb)
        state.finished()
        assertTrue(state.showWeb)
        assertFalse(state.begin("", ""))
    }
}
