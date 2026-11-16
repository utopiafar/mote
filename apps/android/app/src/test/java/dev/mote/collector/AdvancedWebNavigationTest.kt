package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AdvancedWebNavigationTest {
    private val id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private val target = AdvancedWebTarget.Recording(id, AdvancedWebTarget.RecordingTool.SPEAKERS)
    private val selected = AdvancedWebAccess("https://central.example", 4, true)
    private val code = "a".repeat(43)

    @Test fun onlyTypedPublicTargetsCanReachTheSelectedNode() {
        assertEquals("#/library?evidence=capture%3A$id&recordingTool=speakers", target.hash())
        assertEquals("#/system/models?category=audio&prepare=dialogue", AdvancedWebTarget.Models(AdvancedWebTarget.Preparation.AUDIO).hash())
        for (bad in listOf("../$id", "$id&loginTicket=forged", "https://evil.example", "1-1-1-1-1")) assertThrows(IllegalArgumentException::class.java) { AdvancedWebTarget.Recording(bad, AdvancedWebTarget.RecordingTool.RAW) }
        for (server in listOf("javascript:alert(1)", "https://user:secret@evil.example", "https://central.example/other", "https://central.example?token=secret", "https://central.example/#/ask")) {
            var called = false
            assertThrows(Exception::class.java) { AdvancedWebNavigation.prepare(target, selected.copy(server=server), { selected.copy(server=server) }, { true }) { called=true;JSONObject().put("code",code) } }
            assertFalse(called)
        }
    }
    @Test fun currentSessionUsesOnlyTheSingleUseCodeAndRechecksAtTheActualLaunch() {
        var current=selected;var visit=true;val opened=mutableListOf<String>()
        val result=AdvancedWebNavigation.prepare(target,selected,{current},{visit}) { JSONObject().put("code",code) } as AdvancedWebResult.Ready
        result.launch({current},{visit},opened::add);assertEquals(listOf("${selected.server}/${target.hash()}&loginTicket=$code"),opened);assertFalse(result.toString().contains(code))
        current=selected.copy(generation=5);assertThrows(IllegalStateException::class.java) { result.launch({current},{visit},opened::add) }
        current=selected;visit=false;assertThrows(IllegalStateException::class.java) { result.launch({current},{visit},opened::add) };assertEquals(1,opened.size)
    }
    @Test fun delayedTicketsCannotSurviveNodeLogoutObjectOrCredentialChanges() {
        for (change in listOf("node","logout","object","credential")) {
            var current=selected;var visit=true
            assertThrows(IllegalStateException::class.java) { AdvancedWebNavigation.prepare(target,selected,{current},{visit}) {
                when(change){"node"->current=selected.copy(server="https://other.example",generation=5);"logout"->current=selected.copy(authenticated=false,generation=5);"object"->visit=false;else->current=selected.copy(generation=5)}
                JSONObject().put("code",code)
            } }
        }
    }
    @Test fun absentOrCollectorAccessOpensOnlyThePublicTargetForExistingWebLogin() {
        val empty=selected.copy(authenticated=false);var calls=0
        val anonymous=AdvancedWebNavigation.prepare(target,empty,{empty},{true}) { calls++;error("No credential") } as AdvancedWebResult.Ready
        assertEquals(0,calls);assertEquals("${selected.server}/${target.hash()}",anonymous.url)
        val denied=AdvancedWebNavigation.prepare(target,selected,{selected},{true}) { throw CentralFailure(403,"connection_scope_denied") } as AdvancedWebResult.Ready
        assertEquals(anonymous.url,denied.url);assertFalse(denied.url.contains("loginTicket"))
    }
    @Test fun aRealUnauthorizedClientStillSignsOutAndRetainsOnlyThePublicIntentForLogin() {
        var current=selected;var signedOut=0
        val client=CentralClient(selected.server,"generated-expired-session",{_,_,_,_,_->401 to JSONObject().put("error","unauthorized")},unauthorized={signedOut++;current=selected.copy(generation=5,authenticated=false)})
        val result=AdvancedWebNavigation.prepare(target,selected,{current},{true}) { client.post("/api/login/ticket",JSONObject()) }
        assertEquals(1,signedOut);assertTrue(result is AdvancedWebResult.LoginRequired);assertEquals(target,(result as AdvancedWebResult.LoginRequired).target);assertEquals(current,result.access)
        assertFalse(result.toString().contains("generated-expired-session"))
    }
    @Test fun explicitCancellationDuringUnauthorizedRecoveryCannotRetainAnOldIntent() {
        var current=selected;var visit=true
        assertThrows(IllegalStateException::class.java) { AdvancedWebNavigation.prepare(target,selected,{current},{visit}) { visit=false;current=selected.copy(generation=5,authenticated=false);throw CentralFailure(401,"unauthorized") } }
    }
    @Test fun loginPollingBeforeTheUnauthorizedCallbackKeepsOnlyTheCurrentPublicTarget() {
        val intent=AdvancedWebIntent();var page=true;val visit=intent.begin(selected,target){page}
        val signedOut=selected.copy(generation=5,authenticated=false)
        intent.observe(signedOut);assertEquals(target,intent.login?.target);assertEquals(signedOut,intent.login?.access)
        page=false // Rendering the existing login replaces the private reader.
        assertFalse(visit());assertEquals(target,intent.consumeLogin(selected.server,5));assertNull(intent.login)
        assertNull("a login result consumes the intent once",intent.consumeLogin(selected.server,5))
    }
    @Test fun changedNodeExplicitLogoutOrObjectCannotBeAdoptedByLoginPolling() {
        for(change in listOf("node","logout","object","credential")){
            val intent=AdvancedWebIntent();var page=true;val visit=intent.begin(selected,target){page}
            when(change){"logout"->intent.cancel();"object"->page=false}
            val after=if(change=="node")selected.copy(server="https://other.example",generation=5,authenticated=false) else if(change=="credential")selected.copy(generation=5) else selected.copy(generation=5,authenticated=false)
            intent.observe(after);assertNull(change,intent.login)
            if(change=="logout"||change=="object")assertFalse(visit())
            intent.observe(after.copy(generation=6,authenticated=false));assertNull("a cleared request cannot be revived by a later logout",intent.login)
        }
    }
    @Test fun sessionAndTicketExpiryAreCheckedAgainBeforeOpeningTheBrowser() {
        var now=1000L;val scoped=selected.copy(expiresAt=2000)
        val result=AdvancedWebNavigation.prepare(target,scoped,{scoped},{true},{now}) { JSONObject().put("code",code) } as AdvancedWebResult.Ready
        now=2000;assertThrows(IllegalStateException::class.java) { result.launch({scoped},{true}) { error("Must not launch") } }
        now=1000;val ticket=AdvancedWebNavigation.prepare(target,selected,{selected},{true},{now}) { JSONObject().put("code",code) } as AdvancedWebResult.Ready
        now=61000;assertThrows(IllegalStateException::class.java) { ticket.launch({selected},{true}) { error("Must not launch") } }
    }
    @Test fun malformedTicketOrTransportFailureNeverBecomesAnAuthenticatedLink() {
        for(response in listOf(JSONObject(),JSONObject().put("code","bad"),JSONObject().put("code","/".repeat(43)))) assertThrows(IllegalArgumentException::class.java) { AdvancedWebNavigation.prepare(target,selected,{selected},{true}) { response } }
        assertThrows(CentralFailure::class.java) { AdvancedWebNavigation.prepare(target,selected,{selected},{true}) { throw CentralFailure(503) } }
    }
}
