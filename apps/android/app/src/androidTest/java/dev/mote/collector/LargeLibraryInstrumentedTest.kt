package dev.mote.collector

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant
import java.util.UUID

/** Real disk IO with the default plaintext policy, generated content only, isolated from the app queue. */
@RunWith(AndroidJUnit4::class)
class LargeLibraryInstrumentedTest {
    @Test fun twoThousandImagesBrowseCountDeleteAndMoveWithoutWholeLibraryReads() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.startsWith("google/sdk_gphone64_arm64/emu64a:"))
        val avd = instrumentation.uiAutomation.executeShellCommand("getprop ro.boot.qemu.avd_name").use {
            ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() }
        }
        require(avd == "mote_fixture_api35")
        val root = File(context.cacheDir, "library-performance-${UUID.randomUUID()}").apply { mkdirs() }
        val measurements = JSONObject().put("records", 2000).put("distinctImages", 100)
        try {
            var legacyDecryptions = 0
            val actual = LocalContentCipher(object : ByteCipher {
                override fun seal(bytes: ByteArray): ByteArray = error("Default plaintext writes must not encrypt")
                override fun open(bytes: ByteArray): ByteArray { legacyDecryptions++; return SecretBox().open(bytes) }
            })
            var reads = 0
            val cipher = object : ByteCipher {
                override fun seal(bytes: ByteArray) = actual.seal(bytes)
                override fun open(bytes: ByteArray): ByteArray { reads++; return actual.open(bytes) }
            }
            val original = File(root, "original")
            val queue = DurableQueue(original, cipher)
            val bitmap = Bitmap.createBitmap(64, 96, Bitmap.Config.ARGB_8888)
            val images = (0 until 100).map { index ->
                bitmap.eraseColor(Color.rgb(index * 2, 255 - index * 2, index))
                ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            }
            bitmap.recycle()
            val start = Instant.parse("2026-09-16T00:00:00Z")
            val seedStarted = SystemClock.elapsedRealtime()
            queue.withDeferredIndexWrites { repeat(2000) { index ->
                queue.enqueue(JSONObject().put("id", UUID.randomUUID().toString()).put("source", "screen")
                    .put("capturedAt", start.plusSeconds(index.toLong()).toString()).put("appId", "generated.performance")
                    .put("appName", "Generated performance fixture").put("ocrText", "Generated fixture ".repeat(100))
                    .put("privacy", JSONObject().put("excluded", false)).put("ocr", JSONObject().put("status", "completed")),
                    images[index % images.size], 100_000_000)
            } }
            measurements.put("seedMs", SystemClock.elapsedRealtime() - seedStarted)
            // A fresh path avoids process caches and preserves the exact persisted metadata index.
            val cold = File(root, "cold").apply { mkdirs() }
            original.listFiles()!!.forEach { file -> file.copyTo(File(cold, file.name)).setLastModified(file.lastModified()) }
            val restarted = DurableQueue(cold, cipher)
            reads = 0
            var began = SystemClock.elapsedRealtime()
            val inventory = restarted.inventory()
            assertEquals(2000, inventory.images); assertEquals(100, inventory.imageFiles)
            measurements.put("coldInventoryMs", SystemClock.elapsedRealtime() - began)
            began = SystemClock.elapsedRealtime()
            val albums = restarted.albumPage(start.toString(), start.plusSeconds(86400).toString())
            assertEquals(2000, albums.getInt("totalCount"))
            val album = albums.getJSONArray("items").getJSONObject(0)
            val page = restarted.albumImages(album.getString("after"), album.getString("before"), "generated.performance")
            val second = restarted.albumImages(album.getString("after"), album.getString("before"), "generated.performance", page.getString("nextCursor"))
            assertEquals(20, page.getJSONArray("items").length()); assertEquals(20, second.getJSONArray("items").length())
            val browseMs = SystemClock.elapsedRealtime() - began
            measurements.put("albumsAndTwoPagesMs", browseMs).put("coldMetadataReads", reads)
            assertTrue("Reading inventory and pages must use bounded metadata shards: $reads", reads <= 16)
            assertTrue("Indexed metadata pages should be available within 3 seconds on fixture emulator: $browseMs", browseMs < 3000)
            val ids = restarted.dedupeIds()
            val reference = restarted.dedupeRow(ids.first())!!
            val candidates = ids.drop(1).take(1000).map { restarted.dedupeRow(it)!! }
            reads = 0
            began = SystemClock.elapsedRealtime()
            restarted.withDeferredIndexWrites { candidates.forEach { row ->
                assertTrue(restarted.resolveDedupe(row.getString("id"), row.getString("blob"),
                    reference.getString("id"), reference.getString("blob"), null))
            } }
            val deleteMs = SystemClock.elapsedRealtime() - began
            measurements.put("delete1000Ms", deleteMs).put("deleteReads", reads)
            assertEquals(1000, restarted.inventory().images)
            assertNotNull(restarted.image(reference.getString("id")))
            assertTrue("Deletion must perform bounded reads per item, not reread the whole library: $reads", reads <= 6500)
            assertTrue("1000 generated-image removals should finish within 30 seconds on fixture emulator: $deleteMs", deleteMs < 30000)
            val pending = DurableQueue(File(root, "pending"), cipher)
            val moving = restarted.dedupeIds().filter { it != reference.getString("id") }.take(500).map { restarted.dedupeRow(it)!! }
            began = SystemClock.elapsedRealtime()
            restarted.withDeferredIndexWrites { pending.withDeferredIndexWrites {
                moving.forEach { row -> assertTrue(restarted.resolveDedupe(row.getString("id"), row.getString("blob"),
                    reference.getString("id"), reference.getString("blob"), pending, 100_000_000)) }
            } }
            val moveMs = SystemClock.elapsedRealtime() - began
            measurements.put("move500Ms", moveMs).put("legacyDecryptions", legacyDecryptions)
            assertEquals(500, pending.inventory().images); assertEquals(500, restarted.inventory().images)
            assertEquals(0, legacyDecryptions)
            assertTrue("500 generated-image moves should finish within 30 seconds: $moveMs", moveMs < 30000)
            assertTrue(File(cold, "${reference.getString("id")}.event").readText().startsWith("{"))
        } finally {
            Log.i("MoteLibraryPerformance", measurements.toString())
            root.deleteRecursively()
        }
    }
}
