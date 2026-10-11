package dev.mote.collector

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Generated development-emulator navigation only; no files, screenshots or model calls. */
@RunWith(AndroidJUnit4::class)
class SourcesEntryInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) }
    }
    private fun fixture(action: () -> Unit) {
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context)
        val previous = settings.read()
        val language = MoteI18n.preference()
        require(!settings.enabled && !ProjectionService.running && !CaptureAccessibilityService.connected)
        val sourceIds = context.localSources().sources().map { it.id }
        val draftFiles = listOf("FILE", "FOLDER").map { java.io.File(context.noBackupFilesDir, "file-task-${SourceRules.hash(it)}.enc") }
        draftFiles.forEach { it.delete() }
        try {
            MoteI18n.select(context, "zh-CN")
            settings.save(previous.copy(server = "", token = ""), confirmCentralEndpoint = true)
            action()
        } finally {
            assertEquals("Cancellation must never create a source", sourceIds, context.localSources().sources().map { it.id })
            draftFiles.forEach { it.delete() }
            settings.save(previous, confirmCentralEndpoint = true)
            MoteI18n.select(context, language)
        }
    }
    private fun pickerMonitor(tree: Boolean): Instrumentation.ActivityMonitor {
        // An action-only IntentFilter also matches an explicit Activity Intent with no action.
        // Intercept only the system picker so the actual FileTaskActivity still starts.
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? =
                if (intent.action == if (tree) Intent.ACTION_OPEN_DOCUMENT_TREE else Intent.ACTION_OPEN_DOCUMENT)
                    Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
                else null
        }
        instrumentation.addMonitor(monitor)
        return monitor
    }
    private fun recreate(activity: FileTaskActivity): FileTaskActivity {
        instrumentation.runOnMainSync { activity.recreate() }
        val deadline = SystemClock.elapsedRealtime() + 10_000
        var recreated: FileTaskActivity? = null
        while (recreated == null && SystemClock.elapsedRealtime() < deadline) {
            instrumentation.runOnMainSync {
                recreated = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                    .filterIsInstance<FileTaskActivity>().firstOrNull { it !== activity }
            }
            if (recreated == null) Thread.sleep(25)
        }
        return requireNotNull(recreated) { "The source page must resume after recreation" }
    }
    private fun fileEntry(useAddMenu: Boolean, folder: Boolean = false) = fixture {
        val picker = pickerMonitor(folder)
        val sources = instrumentation.addMonitor(FileTaskActivity::class.java.name, null, false)
        var current: FileTaskActivity? = null
        try {
            ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { scenario ->
                scenario.onActivity { activity ->
                    if (useAddMenu) activity.openGeneratedAdd(if (folder) MoteAddAction.FOLDER else MoteAddAction.FILE)
                    else views(activity.window.decorView).single { it.tag == if (folder) "add:FOLDER" else "add:FILE" }.performClick()
                }
                current = instrumentation.waitForMonitorWithTimeout(sources, 10_000) as? FileTaskActivity
                assertNotNull("The actual file entry must open the source page", current)
                instrumentation.waitForIdleSync()
                assertEquals("Entering the page must not open a file picker", 0, picker.hits)
                instrumentation.runOnMainSync {
                    (views(current!!.window.decorView).single { it.tag == "file-task:description" } as android.widget.EditText).setText("Generated call recording background")
                    if (folder) (views(current!!.window.decorView).single { it.tag == "file-task:preset:audio" } as Button).performClick()
                }
                current = recreate(current!!)
                instrumentation.waitForIdleSync()
                assertEquals("Recreating the page before selection must not open a picker", 0, picker.hits)
                instrumentation.runOnMainSync {
                    assertEquals("Generated call recording background", (views(current!!.window.decorView).single { it.tag == "file-task:description" } as android.widget.EditText).text.toString())
                    if (folder) assertEquals(1, (views(current!!.window.decorView).single { it.tag == "file-task:retention" } as android.widget.Spinner).selectedItemPosition)
                }
                instrumentation.runOnMainSync {
                    views(current!!.window.decorView).filterIsInstance<Button>()
                        .single { it.tag == "file-task:pick" }.performClick()
                }
                instrumentation.waitForIdleSync()
                assertEquals("An explicit file action opens the picker once", 1, picker.hits)
                assertFalse("Cancelling the picker keeps the source page open", current!!.isFinishing)
                current = recreate(current!!)
                instrumentation.waitForIdleSync()
                assertEquals("Cancelling and recreating must not reopen the picker", 1, picker.hits)
                instrumentation.runOnMainSync { current!!.finish() }
                current = null
            }
        } finally {
            instrumentation.runOnMainSync { current?.finish() }
            instrumentation.removeMonitor(sources)
            instrumentation.removeMonitor(picker)
        }
    }

    @Test fun homeFileEntryWaitsForSelectionAndDoesNotReopenAfterCancelOrRecreation() = fileEntry(false)
    @Test fun sharedAddFileEntryWaitsForSelectionAndDoesNotReopenAfterCancelOrRecreation() = fileEntry(true)

    @Test fun homeFolderEntryWaitsForSelectionAndKeepsDescriptionAndAudioPreset() = fileEntry(false, folder = true)
    @Test fun sharedAddFolderEntryWaitsForSelectionAndKeepsDescriptionAndAudioPreset() = fileEntry(true, folder = true)
    @Test fun actualSystemPickersOpenOnlyOnSelectionAndCancellationKeepsTheTaskDraft() = fixture {
        for (mode in listOf("FILE", "FOLDER")) {
            ActivityScenario.launch<FileTaskActivity>(Intent(context, FileTaskActivity::class.java).putExtra("addAction", mode)).use { scenario ->
                val readyDeadline = SystemClock.elapsedRealtime() + 10000; var ready = false
                while (!ready && SystemClock.elapsedRealtime() < readyDeadline) { scenario.onActivity { ready = views(it.window.decorView).any { view -> view.tag == "file-task:description" } }; if (!ready) Thread.sleep(25) }
                assertTrue(ready)
                scenario.onActivity { activity ->
                    val rows = views(activity.window.decorView)
                    (rows.single { it.tag == "file-task:description" } as EditText).setText("Generated native picker draft")
                    rows.single { it.tag == "file-task:pick" }.performClick()
                }
                val deadline = SystemClock.elapsedRealtime() + 10000
                while (instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.endsWith(".documentsui") != true && SystemClock.elapsedRealtime() < deadline) Thread.sleep(30)
                assertTrue("The actual Android DocumentsUI must open", instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.endsWith(".documentsui") == true)
                instrumentation.uiAutomation.executeShellCommand("input keyevent 4").close()
                val returnDeadline = SystemClock.elapsedRealtime() + 10000
                while (instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() != context.packageName && SystemClock.elapsedRealtime() < returnDeadline) Thread.sleep(30)
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    assertFalse(activity.isFinishing)
                    assertEquals("Generated native picker draft", (views(activity.window.decorView).single { it.tag == "file-task:description" } as EditText).text.toString())
                    assertFalse((views(activity.window.decorView).single { it.tag == "file-task:confirm" } as Button).isEnabled)
                }
            }
        }
    }

    @Test fun selectingExistingGeneratedFileAndFolderReusesTheirSettingsAndKeepsTheNewDescriptionDraft() = fixture {
        val run = "task-existing-${System.nanoTime()}"
        val root = java.io.File(context.filesDir, "generated-file-sync/$run").apply { mkdirs() }
        java.io.File(root, "generated-note.txt").writeText("Generated existing URI fixture")
        val authority = context.packageName + ".file-fixtures"
        val fixturePreferences = context.getSharedPreferences("file-fixture", 0)
        fixturePreferences.edit().putBoolean("discovery", true).commit()
        context.contentResolver.notifyChange(android.provider.DocumentsContract.buildRootsUri(authority), null)
        fun clickSystemLabel(label: String) {
            val deadline = SystemClock.elapsedRealtime() + 10000
            while (SystemClock.elapsedRealtime() < deadline) {
                fun find(node: android.view.accessibility.AccessibilityNodeInfo?): android.view.accessibility.AccessibilityNodeInfo? {
                    node ?: return null
                    if (node.text?.toString()?.equals(label, ignoreCase = true) == true || node.contentDescription?.toString()?.equals(label, ignoreCase = true) == true) return node
                    repeat(node.childCount) { index -> find(node.getChild(index))?.let { return it } }
                    return null
                }
                var node = find(instrumentation.uiAutomation.rootInActiveWindow)
                while (node != null) {
                    if (node.isClickable && node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)) return
                    node = node.parent
                }
                Thread.sleep(30)
            }
            error("Missing actual system picker label: $label")
        }
        try {
            for (folder in listOf(false, true)) {
                val uri = if (folder) android.provider.DocumentsContract.buildTreeDocumentUri(authority, run)
                    else android.provider.DocumentsContract.buildDocumentUri(authority, "$run/generated-note.txt")
                val old = LocalSource(name = "Generated stored settings", kind = "local-files", uri = uri.toString(), tree = folder, enabled = false,
                    retention = "reference", extensions = "txt", excluded = "private/*", intervalMinutes = 127, maxFileMiB = 23, allowRead = true,
                    centralProcessingConsent = true, syncContinuously = true, initialSync = if (folder) "new_only" else "all",
                    description = "Generated saved description", contextVersion = 4, contextTarget = "generated-confirmed-target")
                val store = context.localSources(); store.save(old)
                try {
                    ActivityScenario.launch<FileTaskActivity>(Intent(context, FileTaskActivity::class.java).putExtra("addAction", if (folder) "FOLDER" else "FILE")).use { scenario ->
                        val deadline = SystemClock.elapsedRealtime() + 10000; var ready = false
                        while (!ready && SystemClock.elapsedRealtime() < deadline) { scenario.onActivity { ready = views(it.window.decorView).any { view -> view.tag == "file-task:description" } }; if (!ready) Thread.sleep(25) }
                        assertTrue(ready)
                        scenario.onActivity { activity ->
                            val rows = views(activity.window.decorView)
                            (rows.single { it.tag == "file-task:description" } as EditText).setText("Generated unsaved selection description")
                            if (folder) rows.single { it.tag == "file-task:preset:audio" }.performClick()
                            rows.single { it.tag == "file-task:pick" }.performClick()
                        }
                        clickSystemLabel("Show roots"); clickSystemLabel("Generated file fixtures"); clickSystemLabel(run)
                        if (folder) { clickSystemLabel("Use this folder"); clickSystemLabel("Allow") }
                        else clickSystemLabel("generated-note.txt")
                        val pickedDeadline = SystemClock.elapsedRealtime() + 10000; var selected = false; var feedback = ""
                        while (!selected && SystemClock.elapsedRealtime() < pickedDeadline) { scenario.onActivity {
                            val rows = views(it.window.decorView); selected = (rows.single { view -> view.tag == "file-task:confirm" } as Button).isEnabled
                            feedback = rows.filterIsInstance<android.widget.TextView>().joinToString(" | ") { view -> view.text.toString() }
                        }; if (!selected) Thread.sleep(25) }
                        assertTrue("Actual system selection must finish ($folder): $feedback", selected)
                        assertEquals("Selection must not change the saved source", old, store.sources().single { it.id == old.id })
                        scenario.recreate(); instrumentation.waitForIdleSync()
                        scenario.onActivity { activity ->
                            val rows = views(activity.window.decorView)
                            assertEquals("Generated unsaved selection description", (rows.single { it.tag == "file-task:description" } as EditText).text.toString())
                            assertEquals(2, (rows.single { it.tag == "file-task:retention" } as Spinner).selectedItemPosition)
                            assertEquals("txt", (rows.single { it.tag == "file-task:extensions" } as EditText).text.toString())
                            assertEquals("Generated stored settings", (rows.single { it.tag == "file-task:name" } as EditText).text.toString())
                            rows.single { it.tag == "file-task:confirm" }.performClick()
                        }
                        val saveDeadline = SystemClock.elapsedRealtime() + 10000
                        while (store.sources().single { it.id == old.id }.description == old.description && SystemClock.elapsedRealtime() < saveDeadline) Thread.sleep(25)
                        assertEquals(old.copy(description = "Generated unsaved selection description", contextDirty = true), store.sources().single { it.id == old.id })
                        assertEquals("Repeated URI must not create a duplicate source", 1, store.sources().size)
                    }
                } finally {
                    store.remove(old.id); context.fileArchives().remove(old.id)
                    runCatching { context.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                }
            }
        } finally {
            fixturePreferences.edit().remove("discovery").commit()
            context.contentResolver.notifyChange(android.provider.DocumentsContract.buildRootsUri(authority), null)
            root.deleteRecursively()
        }
    }

    @Test fun existingFileSettingsAndCapturedPendingBytesSurviveDescriptionEditAndBackgroundAck() = fixture {
        val old = LocalSource(name = "Generated original settings", kind = "local-files", uri = "content://generated/task-file.txt", enabled = false,
            retention = "archive", extensions = "txt", excluded = "private/*", intervalMinutes = 127, maxFileMiB = 23, allowRead = true,
            centralProcessingConsent = true, syncContinuously = false, description = "Earlier generated background", contextDirty = true)
        val store = context.localSources(); val queue = context.fileArchives(); val bytes = "Generated immutable pending content".toByteArray()
        store.save(old)
        val item = org.json.JSONObject().put("externalId", old.uri).put("uri", old.uri).put("title", "task-file.txt").put("kind", "file").put("layer", "original").put("text", "")
            .put("mimeType", "text/plain").put("observedAt", "2026-10-12T00:00:00Z").put("metadata", org.json.JSONObject().put("version", 1).put("file", org.json.JSONObject().put("sizeBytes", bytes.size)))
        queue.observe(old, item, queue.configure(old).getString("generation"), 0)
        val pending = queue.prepare(old, { java.io.ByteArrayInputStream(bytes) }, { true }, captureImmediately = true)!!.toString()
        try {
            ActivityScenario.launch<FileTaskActivity>(Intent(context, FileTaskActivity::class.java).putExtra("sourceId", old.id)).use { scenario ->
                val deadline = SystemClock.elapsedRealtime() + 10000
                var ready = false
                while (!ready && SystemClock.elapsedRealtime() < deadline) { scenario.onActivity { ready = views(it.window.decorView).any { view -> view.tag == "file-task:description" } }; if (!ready) Thread.sleep(25) }
                assertTrue(ready)
                scenario.onActivity { activity ->
                    val rows = views(activity.window.decorView)
                    assertFalse(rows.any { it.tag == "file-task:context-conflict" })
                    assertEquals(1, (rows.single { it.tag == "file-task:retention" } as Spinner).selectedItemPosition)
                    assertEquals("txt", (rows.single { it.tag == "file-task:extensions" } as EditText).text.toString())
                    (rows.single { it.tag == "file-task:description" } as EditText).setText("Corrected generated background")
                }
                // The actual background metadata ACK must not make the open task lose a later edit.
                val acked = store.confirmContext(old, "generated-target", SourceContextSnapshot(old.id, 1, old.description, "a".repeat(64)))!!
                assertFalse(acked.contextDirty)
                scenario.onActivity { activity -> views(activity.window.decorView).single { it.tag == "file-task:confirm" }.performClick() }
                val savedDeadline = SystemClock.elapsedRealtime() + 10000
                while (store.sources().single { it.id == old.id }.description != "Corrected generated background" && SystemClock.elapsedRealtime() < savedDeadline) Thread.sleep(25)
                val updated = store.sources().single { it.id == old.id }
                assertEquals(old.copy(description = updated.description, contextVersion = 1, contextTarget = "generated-target", contextDirty = true), updated)
                assertEquals("Corrected generated background", updated.description)
                assertEquals(pending, queue.next(old.id).toString()); assertArrayEquals(bytes, queue.part(old.id, 0)); assertTrue(queue.state(old.id).getBoolean("importCaptured"))
            }
        } finally { store.remove(old.id); queue.remove(old.id) }
    }

    @Test fun metadataRefreshAckKeepsTextTypedWhileThePrivateCacheWriteIsBlocked() = fixture {
        val settings = Settings(context)
        val store = context.localSources()
        val old = LocalSource(name = "Generated refresh race", kind = "local-files", uri = "content://generated/refresh-race.txt", enabled = false, centralProcessingConsent = true)
        store.save(old)
        val server = java.net.ServerSocket(0, 4, java.net.InetAddress.getByName("127.0.0.1"))
        val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
        val requested = java.util.concurrent.CountDownLatch(1)
        val respond = java.util.concurrent.CountDownLatch(1)
        val config = settings.read().copy(server = "http://127.0.0.1:${server.localPort}", token = "generated-refresh-owner-token-1234567890", debugHttp = true, syncMode = "manual", wifiOnly = false)
        val response = executor.submit {
            server.accept().use { socket ->
                socket.soTimeout = 10000
                val header = java.io.ByteArrayOutputStream()
                while (!header.toString("UTF-8").endsWith("\r\n\r\n")) { val byte = socket.getInputStream().read(); check(byte >= 0); header.write(byte) }
                assertTrue(header.toString("UTF-8").startsWith("GET /api/sources/${old.id}/context "))
                requested.countDown(); assertTrue(respond.await(10, java.util.concurrent.TimeUnit.SECONDS))
                val body = SourceContextSnapshot(old.id, 3, "Generated central background", "a".repeat(64)).json().toString().toByteArray()
                socket.getOutputStream().write("HTTP/1.1 200 Fixture\r\nContent-Length: ${body.size}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n".toByteArray())
                socket.getOutputStream().write(body)
            }
        }
        try {
            settings.save(config, confirmCentralEndpoint = true)
            ActivityScenario.launch<FileTaskActivity>(Intent(context, FileTaskActivity::class.java).putExtra("sourceId", old.id)).use { scenario ->
                assertTrue("The actual task must request current central metadata", requested.await(10, java.util.concurrent.TimeUnit.SECONDS))
                // Pause only the private cache write after the HTTP result has entered its UI callback.
                val lock = LocalSourceStore::class.java.getDeclaredField("lock").apply { isAccessible = true }.get(null)
                synchronized(lock) {
                    respond.countDown()
                    val deadline = SystemClock.elapsedRealtime() + 10000
                    var blocked = false
                    while (!blocked && SystemClock.elapsedRealtime() < deadline) {
                        blocked = Thread.getAllStackTraces().any { (thread, stack) -> thread.state == Thread.State.BLOCKED && stack.any { frame -> frame.className == LocalSourceStore::class.java.name && frame.methodName == "confirmContext" } }
                        if (!blocked) Thread.sleep(25)
                    }
                    assertTrue("Metadata ACK must be blocked before its UI callback", blocked)
                    scenario.onActivity { activity ->
                        (views(activity.window.decorView).single { it.tag == "file-task:description" } as EditText).setText("User's newer generated draft")
                    }
                }
                val deadline = SystemClock.elapsedRealtime() + 10000
                while (store.sources().single { it.id == old.id }.contextVersion != 3 && SystemClock.elapsedRealtime() < deadline) Thread.sleep(25)
                var ready = false
                while (!ready && SystemClock.elapsedRealtime() < deadline) {
                    scenario.onActivity { activity ->
                        val status = views(activity.window.decorView).filterIsInstance<android.widget.TextView>()
                        ready = status.any { it.text.toString().contains("版本 3") }
                    }
                    if (!ready) Thread.sleep(25)
                }
                assertTrue("The version 3 ACK callback must complete", ready)
                scenario.onActivity { activity ->
                    assertEquals("User's newer generated draft", (views(activity.window.decorView).single { it.tag == "file-task:description" } as EditText).text.toString())
                    views(activity.window.decorView).single { it.tag == "file-task:confirm" }.performClick()
                }
                val savedDeadline = SystemClock.elapsedRealtime() + 10000
                while (store.sources().single { it.id == old.id }.description != "User's newer generated draft" && SystemClock.elapsedRealtime() < savedDeadline) Thread.sleep(25)
                val updated = store.sources().single { it.id == old.id }
                assertEquals("User's newer generated draft", updated.description)
                assertEquals(3, updated.contextVersion); assertTrue(updated.contextDirty); assertEquals(SourceRules.target(config.server, config.token), updated.contextTarget)
            }
            response.get(10, java.util.concurrent.TimeUnit.SECONDS)
        } finally { respond.countDown(); server.close(); executor.shutdownNow(); store.remove(old.id) }
    }

    @Test fun generatedTaskScreensRetainSecureWindowAndRenderInBothLanguages() = fixture {
        for (language in listOf("zh-CN", "en")) {
            MoteI18n.select(context, language)
            for (mode in listOf("FILE", "FOLDER")) {
                ActivityScenario.launch<FileTaskActivity>(Intent(context, FileTaskActivity::class.java).putExtra("addAction", mode)).use { scenario ->
                    val deadline = SystemClock.elapsedRealtime() + 10000; var ready = false
                    while (!ready && SystemClock.elapsedRealtime() < deadline) { scenario.onActivity { ready = views(it.window.decorView).any { view -> view.tag == "file-task:description" } }; if (!ready) Thread.sleep(25) }
                    assertTrue(ready); instrumentation.waitForIdleSync()
                    scenario.onActivity { activity ->
                        assertTrue(activity.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE != 0)
                        val root = activity.window.decorView
                        val image = android.graphics.Bitmap.createBitmap(root.width, root.height, android.graphics.Bitmap.Config.ARGB_8888)
                        root.draw(android.graphics.Canvas(image))
                        val directory = java.io.File(context.filesDir, "generated-file-task-ui").apply { mkdirs() }
                        java.io.File(directory, "$language-$mode.png").outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; image.recycle()
                        assertFalse("New tasks require an explicit selection", (views(root).single { it.tag == "file-task:confirm" } as Button).isEnabled)
                    }
                }
            }
        }
    }
}
