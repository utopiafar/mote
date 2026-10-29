package dev.mote.collector
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ManagedCalendarJournalTest {
    private val id = "11111111-1111-4111-8111-111111111111"
    private val operation = "22222222-2222-4222-8222-222222222222"
    private fun action() = JSONObject().put("id", id).put("operationId", operation).put("kind", "calendar.create").put("status", "executing").put("mutationAllowed", true).put("target", JSONObject().put("deviceId", "generated-device"))
    @Test fun retainedReceiptSurvivesReconstructionWithoutPermissionOrClaim() {
        val disk = mutableMapOf<String,String>(); val calls = mutableListOf<String>()
        val request: (String,JSONObject?) -> JSONObject = { path, body -> calls.add(path); assertEquals("generated-event", body!!.getString("externalId")); JSONObject() }
        ManagedCalendarJournal("generated-device", request, disk::get, { k,v -> disk[k]=v }).remember(action())
        disk[operation] = "generated-event"
        val restarted = ManagedCalendarJournal("generated-device", request, disk::get, { k,v -> disk[k]=v })
        assertNull(restarted.claim(id, operation) { fail("Receipt recovery must not request native permission") })
        assertEquals(listOf("/api/managed-calendar/$id/receipt"), calls)
    }
    @Test fun crashedAttemptCanOnlyReconcileAfterScopeWithdrawal() {
        val disk = mutableMapOf<String,String>();val request: (String,JSONObject?) -> JSONObject = { _,_ -> error("Generated grant revoked") }
        val journal = ManagedCalendarJournal("generated-device", request, disk::get, { k,v -> disk[k]=v })
        journal.remember(action());disk[operation]="attempting"
        val recovered=ManagedCalendarJournal("generated-device", request, disk::get, { k,v -> disk[k]=v }).claim(id,operation) {}!!
        assertEquals("uncertain",recovered.getString("status"));assertFalse(CalendarActionRules.mutationAllowed(recovered,null))
    }
    @Test fun missingAttemptCannotTurnFailedClaimIntoPermission() {
        val disk = mutableMapOf<String,String>();val request: (String,JSONObject?) -> JSONObject = { _,_ -> error("Generated offline") }
        val journal=ManagedCalendarJournal("generated-device",request,disk::get,{k,v->disk[k]=v});journal.remember(action())
        assertThrows(IllegalStateException::class.java) { journal.claim(id,operation) {} }
    }
    @Test fun foreignOrSubstitutedOperationCannotFlushOrExecute() {
        var calls=0;val disk=mutableMapOf("managed-$operation" to action().put("target",JSONObject().put("deviceId","other-device")).toString(),operation to "generated-event")
        val journal=ManagedCalendarJournal("generated-device",{_,_->calls++;JSONObject()},disk::get,{k,v->disk[k]=v})
        assertThrows(IllegalArgumentException::class.java) { journal.claim(id,operation) {} };assertEquals(0,calls)
    }
    @Test fun updateAndCancelRetainReceiptsWithoutAnotherClaimAfterWithdrawal() {
        for (kind in listOf("calendar.update", "calendar.cancel")) {
            val disk = mutableMapOf<String,String>(); val calls = mutableListOf<String>()
            val journal = ManagedCalendarJournal("generated-device", { path,body -> calls.add(path); assertEquals("original-event",body!!.getString("externalId")); JSONObject() }, disk::get, { key,value -> disk[key]=value })
            journal.remember(action().put("kind",kind)); disk[operation]="original-event"
            assertNull(journal.claim(id,operation) { fail("Retained receipt does not reclaim execution permission") })
            assertEquals(listOf("/api/managed-calendar/$id/receipt"),calls)
        }
    }
    @Test fun completionIsNotADeviceWriteCapability() {
        val disk = mutableMapOf<String,String>()
        val journal = ManagedCalendarJournal("generated-device", { _,_ -> JSONObject() }, disk::get, { key,value -> disk[key]=value })
        assertThrows(IllegalArgumentException::class.java) { journal.remember(action().put("kind","calendar.complete")) }
    }
}
