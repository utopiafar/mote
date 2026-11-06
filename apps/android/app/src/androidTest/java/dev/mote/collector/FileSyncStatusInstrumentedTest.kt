package dev.mote.collector

import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.provider.DocumentsContract
import android.view.View
import android.view.ViewGroup
import android.widget.ScrollView
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Run only in the isolated file-fixture package on an emulator; all files and HTTP are generated. */
@RunWith(AndroidJUnit4::class)
class FileSyncStatusInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun views(root: View): List<View> = buildList { add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) } }
    private fun waitFor(label: String, test: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 15_000
        while (!test()) { check(SystemClock.elapsedRealtime() < deadline) { label }; Thread.sleep(30) }
    }
    private fun fixture(action: (LocalSource, File) -> Unit) {
        require(context.packageName == "dev.mote.collector.filefixture" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context); val previous = settings.read(); val language = MoteI18n.preference()
        require(!settings.enabled && !ProjectionService.running && !CaptureAccessibilityService.connected)
        val run = "status-${System.nanoTime()}"
        val root = File(context.filesDir, "generated-file-sync/$run").apply { mkdirs() }
        val uri = DocumentsContract.buildTreeDocumentUri(context.packageName + ".file-fixtures", run)
        val source = LocalSource(name = "Generated folder progress", kind = "local-files", tree = true, uri = uri.toString(), extensions = "txt", retention = "archive")
        try {
            MoteI18n.select(context, "zh-CN")
            settings.save(previous.copy(server = "", token = "", syncPaused = false), confirmCentralEndpoint = true)
            context.localSources().save(source)
            action(source, root)
        } finally {
            context.localSources().remove(source.id); context.fileArchives().remove(source.id); root.deleteRecursively()
            settings.save(previous, confirmCentralEndpoint = true); MoteI18n.select(context, language)
        }
    }
    private fun labels(scenario: ActivityScenario<*>): List<String> {
        var labels = emptyList<String>()
        scenario.onActivity { labels = views(it.window.decorView).filterIsInstance<TextView>().map { view -> view.text.toString() } }
        return labels
    }
    private fun renderProof(scenario: ActivityScenario<*>, name: String) {
        // FLAG_SECURE remains enabled. Render only this generated native fixture view for layout QA.
        scenario.onActivity { activity ->
            val view = activity.window.decorView
            val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bitmap))
            val directory = File(context.filesDir, "generated-status-proof").apply { mkdirs() }
            File(directory, "$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }
    private fun ack(row: JSONObject): JSONObject {
        val manifest = row.getJSONObject("pending").getJSONObject("manifest"); val item = manifest.getJSONObject("item"); val id = UUID.randomUUID().toString()
        return JSONObject().put("id", id).put("sourceId", manifest.getString("sourceId")).put("externalId", item.getString("externalId")).put("revision", item.getString("revision"))
            .put("duplicate", false).put("sha256", manifest.getString("sha256")).put("sizeBytes", manifest.getLong("sizeBytes"))
            .put("receipt", JSONObject().put("version", 2).put("id", id).put("kind", "file-revision").put("state", "received").put("duplicate", false)
                .put("sourceId", manifest.getString("sourceId")).put("externalId", item.getString("externalId")).put("revision", item.getString("revision")))
    }
    @Test fun openDetailAutomaticallyFollowsStabilityQueueRealUpload503RetryAndReceipt() = fixture { source, root ->
        val original = "Generated original paragraph.\n".repeat(250)
        File(root, "one.txt").writeText(original)
        assertTrue(FileSources(context).scan(source))
        val queue = context.fileArchives(); val candidate = queue.rows(source.id).single(); val external = candidate.getJSONObject("candidate").getString("externalId")
        val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        val requestArrived = CountDownLatch(1); val fail = CountDownLatch(1); val retryArrived = CountDownLatch(1); val succeed = CountDownLatch(1)
        val service = Executors.newSingleThreadExecutor(); val client = Executors.newSingleThreadExecutor()
        try {
            ActivityScenario.launch<FileContentActivity>(Intent(context, FileContentActivity::class.java).putExtra("sourceId", source.id).putExtra("externalId", external)).use { scenario ->
                waitFor("Initial stability and folder inventory must be visible") { labels(scenario).any { it.contains("等待文件稳定") } && labels(scenario).any { it.contains("0/1") } }
                queue.saveRow(source.id, queue.row(source.id, external).put("stableSince", System.currentTimeMillis() - 61_000))
                waitFor("Elapsed stability must update without another scan or a tap") { labels(scenario).any { it.contains("排队等待保存与上传") } }
                val saved = FileSources(context).prepare(source)!!
                File(root, "two.txt").writeText("Generated second file")
                assertTrue(FileSources(context).scan(source))
                waitFor("Saved bytes and growing folder inventory must refresh automatically") { labels(scenario).any { it.contains("排队等待上传或续传") } && labels(scenario).any { it.contains("0/2") } }
                waitFor("Saved original preview must be laid out before reading") {
                    var ready = false
                    scenario.onActivity { activity ->
                        val scroll = views(activity.window.decorView).filterIsInstance<ScrollView>().first()
                        ready = views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.contains("Generated original paragraph") } && scroll.getChildAt(0).height - scroll.height >= 300
                    }
                    ready
                }
                scenario.onActivity {
                    val scroll = views(it.window.decorView).filterIsInstance<ScrollView>().first()
                    scroll.scrollTo(0, 300)
                    assertEquals("The reading position must be established before upload", 300, scroll.scrollY)
                }
                val response = service.submit {
                    repeat(4) { index -> server.accept().use { socket ->
                        socket.soTimeout = 10_000
                        val input = socket.getInputStream(); val header = java.io.ByteArrayOutputStream()
                        while (!header.toString("UTF-8").endsWith("\r\n\r\n")) { val byte = input.read(); check(byte >= 0); header.write(byte); check(header.size() < 65536) }
                        val headers = header.toString("UTF-8"); val length = Regex("(?im)^Content-Length: ([0-9]+)").find(headers)?.groupValues?.get(1)?.toInt() ?: 0
                        val bytes = ByteArray(length); var read = 0
                        while (read < length) { val count = input.read(bytes, read, length - read); check(count > 0); read += count }
                        val body = when (index) {
                            0 -> { assertTrue(headers.startsWith("POST /api/file-sync/v1/uploads ")); requestArrived.countDown(); assertTrue(fail.await(15, TimeUnit.SECONDS)); JSONObject() }
                            1 -> { retryArrived.countDown(); assertTrue(succeed.await(15, TimeUnit.SECONDS)); JSONObject().put("uploadId", "11111111-1111-4111-8111-111111111111").put("partBytes", FileArchiveQueue.PART_BYTES).put("parts", JSONArray()) }
                            2 -> { assertTrue(headers.startsWith("PUT /api/file-sync/v1/uploads/")); assertArrayEquals(original.toByteArray(), bytes); JSONObject().put("part", 0).put("bytes", bytes.size).put("hash", FileSnapshotMetadata.hash(bytes)) }
                            else -> { assertTrue(headers.contains("/commit ")); ack(saved) }
                        }.toString().toByteArray()
                        socket.getOutputStream().write("HTTP/1.1 ${if (index == 0) 503 else 200} Fixture\r\nContent-Length: ${body.size}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n".toByteArray()); socket.getOutputStream().write(body)
                    } }
                }
                val config = CollectorConfig(server = "http://127.0.0.1:${server.localPort}", token = "generated-file-status-fixture-token-123456", debugHttp = true, wifiOnly = false)
                val attempt = client.submit<Boolean> { FileUpload.sync(context, source, config) { true } }
                assertTrue(requestArrived.await(10, TimeUnit.SECONDS))
                waitFor("A real HTTP attempt must be shown as uploading") { labels(scenario).any { it == "正在上传 · 等待中央确认" } }
                scenario.onActivity { assertEquals("Status refresh must preserve reading position", 300, views(it.window.decorView).filterIsInstance<ScrollView>().first().scrollY) }
                renderProof(scenario, "uploading-detail")
                fail.countDown()
                assertThrows(java.util.concurrent.ExecutionException::class.java) { attempt.get(10, TimeUnit.SECONDS) }
                waitFor("HTTP 503 must remain visible after the attempt exits") { labels(scenario).any { it.contains("上传失败") && it.contains("HTTP 503") } }
                val retry = client.submit<Boolean> { FileUpload.sync(context, source, config) { true } }
                assertTrue(retryArrived.await(10, TimeUnit.SECONDS))
                waitFor("Retry must replace failure with the actual live upload state") { labels(scenario).any { it == "正在上传 · 等待中央确认" } }
                succeed.countDown(); assertFalse("Second generated file is still waiting", retry.get(10, TimeUnit.SECONDS)); response.get(10, TimeUnit.SECONDS)
                waitFor("Receipt and folder progress must refresh without a tap") { labels(scenario).any { it.contains("中央已收到") } && labels(scenario).any { it.contains("1/2") } }
                scenario.moveToState(Lifecycle.State.CREATED)
                scenario.moveToState(Lifecycle.State.RESUMED)
                waitFor("Resume must reload the receipt") { labels(scenario).any { it.contains("1/2") } }
                scenario.recreate()
                waitFor("Recreation must not display the old uploading or retry state") { labels(scenario).any { it.contains("1/2") } && labels(scenario).none { it.contains("HTTP 503") || it == "正在上传 · 等待中央确认" } }
            }
        } finally { fail.countDown(); succeed.countDown(); server.close(); client.shutdownNow(); service.shutdownNow() }
    }
    @Test fun sourceManagementShowsPartialInventoryAnd212FileOverallProgress() = fixture { source, root ->
        repeat(212) { File(root, "$it.txt").writeText("Generated $it") }
        assertFalse(FileSources(context).scan(source))
        assertFalse(context.fileArchives().progress(source).scanComplete)
        ActivityScenario.launch<SourcesActivity>(Intent(context, SourcesActivity::class.java).putExtra("detailSourceId", source.id)).use { scenario ->
            waitFor("Partial totals must be qualified") { labels(scenario).any { it.contains("扫描尚未完成，总数会继续更新") } }
            assertTrue(FileSources(context).scan(source))
            waitFor("Complete folder totals must update automatically") { labels(scenario).any { it.contains("0/212") && it.contains("等待稳定 212") && !it.contains("扫描尚未完成") } }
            renderProof(scenario, "folder-progress")
        }
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
            waitFor("Home must expose the same complete folder progress and actual scan timestamp") { labels(scenario).any { it.contains("0/212") && !it.contains("最近扫描 尚无") } }
            scenario.onActivity { activity ->
                val card = views(activity.window.decorView).single { it.tag == "source:" + source.id }
                val scroll = views(activity.window.decorView).filterIsInstance<ScrollView>().first { it.isShown }
                val location = IntArray(2); val scrollLocation = IntArray(2)
                card.getLocationInWindow(location); scroll.getLocationInWindow(scrollLocation)
                scroll.scrollBy(0, location[1] - scrollLocation[1] - 24)
            }
            renderProof(scenario, "home-progress")
        }
    }
}
