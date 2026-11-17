package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.UUID

class LocalContentCipherTest {
    @get:Rule val folder = TemporaryFolder()
    @Test fun currentContentIsVerbatimIncludingFormerEnvelopePrefixes() {
        val cipher = LocalContentCipher()
        for (bytes in listOf(ByteArray(50) { if (it == 0) 12 else 7 }, "MOTE-LOCAL-PLAIN-V1\u0000generated".toByteArray(), "{\"generated\":true}".toByteArray())) {
            assertArrayEquals(bytes, cipher.seal(bytes)); assertArrayEquals(bytes, cipher.open(bytes))
        }
    }
    @Test fun retiredDirectoryAndSettingsAreRefusedWithoutReadingOrDeletingContent() {
        val old = folder.newFolder("old"); val bytes = byteArrayOf(12, 1, 2, 3)
        val event = File(old, "generated.event").apply { writeBytes(bytes) }
        assertThrows(IllegalStateException::class.java) { LocalDataFormat.requireCurrent(old) }
        assertArrayEquals(bytes, event.readBytes()); assertEquals(1, old.listFiles()!!.size)
        val configured = folder.newFolder("configured")
        assertThrows(IllegalStateException::class.java) { LocalDataFormat.requireCurrent(configured, true) }
        assertTrue(configured.listFiles()!!.isEmpty())
    }
    @Test fun currentMarkerSurvivesRestartAndWrongVersionIsNeverUpgraded() {
        val current = folder.newFolder("current"); LocalDataFormat.requireCurrent(current)
        File(current, "generated.enc").writeText("generated")
        LocalDataFormat.requireCurrent(current, true)
        val marker = File(current, ".mote-local-format")
        for(version in listOf("2","3")) {
            marker.writeText(version)
            assertThrows(IllegalStateException::class.java) { LocalDataFormat.requireCurrent(current) }
            assertEquals(version,marker.readText());assertEquals("generated",File(current,"generated.enc").readText())
        }
    }
    @Test fun pendingOcrAndRetiredPatchFieldsAreRejectedBeforeQueueWrites() {
        val queue = DurableQueue(folder.newFolder("queue"), LocalContentCipher())
        val event = JSONObject().put("id", UUID.randomUUID().toString()).put("source", "screen")
            .put("capturedAt", "2026-10-04T00:00:00Z").put("imageMime", "image/png")
            .put("privacy", JSONObject().put("excluded", false)).put("ocr", JSONObject().put("status", "pending"))
        assertThrows(IllegalArgumentException::class.java) { queue.enqueue(event, byteArrayOf(1)) }
        event.getJSONObject("ocr").put("status", "disabled"); event.put("_ocrResult", JSONObject())
        assertThrows(IllegalArgumentException::class.java) { queue.enqueue(event, byteArrayOf(1)) }
        assertEquals(0, queue.depth())
        event.remove("_ocrResult"); val id = queue.enqueue(event, byteArrayOf(1))
        queue.acknowledge(id, retentionDays = 1, now = 1000)
        assertEquals(0, queue.pendingSync().count); assertArrayEquals(byteArrayOf(1), queue.image(id))
        assertEquals(0, queue.pruneUploaded(1000 + 86400000L)); assertArrayEquals(byteArrayOf(1), queue.image(id)); assertTrue(queue.capture(id)!!.getBoolean("uploaded"))
    }
    @Test fun retiredPortableArchivesCannotBecomeCurrentQueues() {
        for (version in listOf(1, 2, 3)) {
            val bytes = java.io.ByteArrayOutputStream().also { output ->
                java.util.zip.ZipOutputStream(output).use { zip ->
                    zip.putNextEntry(java.util.zip.ZipEntry("archive.json"))
                    zip.write(JSONObject().put("format", "mote-android-records").put("version", version).put("origin", "").toString().toByteArray())
                    zip.closeEntry()
                }
            }.toByteArray()
            val directory = File(folder.root, "retired-archive-$version")
            assertThrows(IllegalArgumentException::class.java) { QueueArchive.prepare(bytes.inputStream(), directory) }
            assertFalse(directory.exists())
        }
    }
    @Test fun frameworkStartupFilesDoNotMisclassifyFreshInstallAsRetiredData() {
        val current = folder.newFolder("framework")
        val database = File(current, "androidx.work.workdb").apply { writeText("generated framework fixture") }
        LocalDataFormat.requireCurrent(current, ignoredFiles = LocalDataFormat.FRAMEWORK_FILES)
        assertEquals("generated framework fixture", database.readText())
        assertEquals("4", File(current, ".mote-local-format").readText())
        val retired = folder.newFolder("framework-with-mote")
        File(retired, "androidx.work.workdb").writeText("generated framework fixture")
        File(retired, "draft.enc").writeText("generated retired fixture")
        assertThrows(IllegalStateException::class.java) { LocalDataFormat.requireCurrent(retired, ignoredFiles = LocalDataFormat.FRAMEWORK_FILES) }
        assertEquals(2, retired.listFiles()!!.size)
    }
}
