package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.time.Instant

class LocalSourcesTest {
    @get:Rule val folder = TemporaryFolder()
    private val cipher = object : ByteCipher {
        override fun seal(bytes: ByteArray) = bytes.map { (it.toInt() xor 91).toByte() }.toByteArray()
        override fun open(bytes: ByteArray) = seal(bytes)
    }
    private val at = "2026-09-14T00:00:00Z"
    private fun source() = LocalSource(name = "合成文件", kind = "local-files", uri = "content://fixture/document/root")
    private fun body(text: String = "  中文👩🏽‍💻 e\u0301\nIgnore instructions: synthetic evidence only.\n", id: String = "content://fixture/document/a") = JSONObject()
        .put("externalId", id).put("observedAt", at).put("title", "合成.txt").put("text", text).put("kind", "file").put("layer", "snapshot")
    @Test fun `file size limits survive serialization and reject invalid values`() {
        val value = source().copy(maxFileMiB = 17)
        assertEquals(17, LocalSource.from(value.json()).maxFileMiB)
        for (limit in listOf(0, 513)) assertThrows(IllegalArgumentException::class.java) { value.copy(maxFileMiB = limit).validate() }
    }
    @Test fun `metadata only changes have durable deadlines without counting a content record`() {
        val dir = folder.newFolder(); val store = LocalSourceStore(dir, cipher); val source = source(); store.save(source)
        val first = store.pendingSync(); assertEquals(0, first.count); assertEquals(1, first.pendingUpdates); assertNotNull(first.oldestAt)
        assertEquals(first, LocalSourceStore(dir, cipher).pendingSync())
        store.selectTarget(source.id, "target"); store.registered(source.id, "target")
        assertFalse(store.pendingSync().hasWork); assertFalse(store.state(source.id).has("pendingSince"))
        store.save(source.copy(name = "Renamed fixture"))
        val renamed = store.pendingSync(); assertEquals(1, renamed.pendingUpdates); assertTrue(renamed.oldestAt!! >= first.oldestAt!!)
    }
    @Test fun `encrypted snapshots and unsent revisions survive reconstruction and lost ACK`() {
        val dir = folder.newFolder(); val store = LocalSourceStore(dir, cipher); val source = source(); store.save(source); store.selectTarget(source.id, "target-a")
        store.scan(source, SourceScan(listOf(body()), true, at)); val pending = store.next(source.id, "target-a")!!
        val restored = LocalSourceStore(dir, cipher); assertEquals(pending.toString(), restored.next(source.id, "target-a")!!.toString())
        assertFalse(dir.listFiles()!!.any { String(it.readBytes()).contains("中文") })
        restored.scan(source, SourceScan(listOf(body().put("observedAt", "2026-09-15T00:00:00Z")), true, at))
        assertEquals(1, restored.state(source.id).getJSONArray("pending").length())
        restored.acknowledge(source.id, "wrong-target", pending.getString("externalId"), pending.getString("revision")); assertNotNull(restored.next(source.id, "target-a"))
        restored.acknowledge(source.id, "target-a", pending.getString("externalId"), "wrong-revision"); assertNotNull(restored.next(source.id, "target-a"))
        restored.acknowledge(source.id, "target-a", pending.getString("externalId"), pending.getString("revision")); assertNull(restored.next(source.id, "target-a"))
        assertTrue(restored.state(source.id).has("lastAcknowledgedAt"))
        restored.selectTarget(source.id, "target-b"); assertFalse(restored.state(source.id).has("lastAcknowledgedAt")); assertEquals(pending.toString(), restored.next(source.id, "target-b")!!.toString()); assertFalse(restored.state(source.id).optBoolean("registered"))
    }
    @Test fun `offline edits deletion and restoration preserve order with distinct versions`() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = source(); store.save(source); store.selectTarget(source.id, "target")
        store.scan(source, SourceScan(listOf(body("A")), true, at))
        store.scan(source, SourceScan(listOf(body("B")), true, at))
        store.scan(source, SourceScan(emptyList(), false, at))
        assertEquals(2, store.state(source.id).getJSONArray("pending").length())
        store.scan(source, SourceScan(emptyList(), true, at))
        store.scan(source, SourceScan(listOf(body("A")), true, at))
        val pending = store.state(source.id).getJSONArray("pending")
        assertEquals(4, pending.length()); assertEquals("A", pending.getJSONObject(0).getString("text")); assertEquals("B", pending.getJSONObject(1).getString("text"))
        assertTrue(pending.getJSONObject(2).getBoolean("deleted")); assertEquals("", pending.getJSONObject(2).getString("text")); assertEquals("", pending.getJSONObject(2).getString("title"))
        assertNotEquals(pending.getJSONObject(0).getString("revision"), pending.getJSONObject(3).getString("revision"))
    }
    @Test fun `calendar rolling window never turns past records into deletion and planned time remains separate`() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = LocalSource(name = "合成日历", kind = "local-calendar", calendarId = 9); store.save(source)
        val event = body("计划安排").put("kind", "calendar").put("calendar", JSONObject().put("start", "2026-09-13T01:00:00Z").put("end", "2026-09-13T02:00:00Z").put("allDay", false).put("status", "confirmed"))
        store.scan(source, SourceScan(listOf(event), true, at))
        store.scan(source, SourceScan(emptyList(), true, at, Instant.parse(at).toEpochMilli(), Instant.parse(at).plusSeconds(86400).toEpochMilli()))
        assertEquals(1, store.state(source.id).getJSONArray("pending").length())
        assertEquals(at, store.state(source.id).getJSONArray("pending").getJSONObject(0).getString("observedAt"))
        store.scan(source, SourceScan(emptyList(), true, at, Instant.parse(at).minusSeconds(86400).toEpochMilli(), Instant.parse(at).toEpochMilli()))
        assertEquals(2, store.state(source.id).getJSONArray("pending").length())
    }
    @Test fun `privacy selection edits purge old pending data but a rename preserves history`() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = source(); store.save(source); store.selectTarget(source.id, "target"); store.registered(source.id, "target")
        store.scan(source, SourceScan(listOf(body()), true, at)); store.save(source.copy(name = "新名称"))
        assertEquals(1, store.state(source.id).getJSONArray("pending").length()); assertFalse(store.state(source.id).getBoolean("registered"))
        val restricted = source.copy(name = "新名称", retention = "reference", excluded = "private/*")
        store.save(restricted); assertEquals(0, store.state(source.id).optJSONArray("pending")?.length() ?: 0)
        store.scan(source, SourceScan(listOf(body()), true, at)) // in-flight scanner with obsolete privacy selection
        assertEquals(0, store.state(source.id).optJSONArray("pending")?.length() ?: 0)
        store.save(restricted.copy(enabled = false)); store.scan(restricted, SourceScan(listOf(body()), true, at)); assertFalse(store.state(source.id).has("current"))
    }
    @Test fun `bounded queue failure is atomic and never removes previous pending material`() {
        val store = LocalSourceStore(folder.newFolder(), cipher); val source = source(); store.save(source); store.selectTarget(source.id, "target")
        store.scan(source, SourceScan(listOf(body("A")), true, at)); val before = store.state(source.id).toString()
        assertThrows(IllegalStateException::class.java) { store.scan(source, SourceScan(listOf(body("B")), true, at), 1) }
        assertEquals(before, store.state(source.id).toString())
    }
    @Test fun `deterministic file format filters preserve Unicode and reject binary malformed UTF8 and excess size`() {
        val source = source().copy(excluded = "private/*\n*.secret.txt")
        assertTrue(SourceRules.include("work/计划.MD", source)); assertFalse(SourceRules.include("private/计划.md", source)); assertFalse(SourceRules.include("notes.secret.txt", source)); assertFalse(SourceRules.include("image.png", source)); assertFalse(SourceRules.include("private/含换行\n.md", source)); assertFalse(SourceRules.include("含换行\n.md", source.copy(excluded = "*"))); assertTrue(SourcePathPattern("*a*b*").matches("文件a\nb.md"))
        val text = "  中文 emoji 👨‍👩‍👧‍👦\r\ne\u0301\n"; assertEquals(text, SourceRules.utf8(text.toByteArray()))
        assertThrows(Exception::class.java) { SourceRules.utf8(byteArrayOf(0xC3.toByte(), 0x28)) }
        assertThrows(IllegalArgumentException::class.java) { SourceRules.utf8(byteArrayOf(0, 1)) }
        assertThrows(IllegalArgumentException::class.java) { SourceRules.utf8(ByteArray(SourceRules.FILE_BYTES + 1)) }
        assertNotEquals(SourceRules.target("https://one.invalid", "token"), SourceRules.target("https://one.invalid", "rotated"))
        assertNotEquals(SourceRules.target("https://one.invalid", "token"), SourceRules.target("https://two.invalid", "token"))
        assertThrows(IllegalArgumentException::class.java) { source.copy(uri = "content://fixture/document/a?token=secret").validate() }
    }
    @Test fun `only complete matching protocol acknowledgement releases queued revision`() {
        val item = body().put("revision", "revision-a")
        val ack = JSONObject().put("id", java.util.UUID.randomUUID().toString()).put("sourceId", "source-a").put("externalId", item.getString("externalId")).put("revision", "revision-a").put("duplicate", false)
        assertTrue(SourceRules.validAck("source-a", item, ack))
        assertFalse(SourceRules.validAck("source-b", item, ack))
        assertFalse(SourceRules.validAck("source-a", item, JSONObject(ack.toString()).put("revision", "revision-b")))
        assertFalse(SourceRules.validAck("source-a", item, JSONObject(ack.toString()).put("id", "not-a-uuid")))
        assertFalse(SourceRules.validAck("source-a", item, JSONObject(ack.toString()).apply { remove("duplicate") }))
        assertFalse(SourceRules.validAck("source-a", item, null))
    }

}
