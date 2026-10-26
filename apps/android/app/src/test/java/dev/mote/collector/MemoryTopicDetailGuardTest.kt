package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MemoryTopicDetailGuardTest {
    private fun row() = JSONObject().put("id", "selected").put("version", 1).put("status", "published").put("fingerprint", "fixture")
    @Test fun sameDirectoryCannotValidateChangedDetail() {
        val guard = MemoryTopicDetailGuard(); assertTrue(guard.accept("selected", row()))
        assertTrue(guard.current("selected", row()))
        for (changed in listOf(row().put("version", 2), row().put("status", "stale"), row().put("supersededBy", "replacement"), row().put("id", "other"), row().put("fingerprint", "changed"))) {
            assertFalse(guard.current("selected", changed)); assertFalse(guard.accept("selected", changed))
        }
    }
    @Test fun reselectRequiresFreshSnapshotAndRejectsMissingVersion() {
        val guard = MemoryTopicDetailGuard(); assertTrue(guard.accept("selected", row()))
        guard.clear(); assertTrue(guard.accept("selected", row().put("version", 2)))
        assertFalse(guard.current("selected", row())); assertFalse(guard.accept("selected", row().put("version", JSONObject.NULL)))
    }
}
