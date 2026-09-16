package dev.mote.collector

import android.app.UiAutomation
import android.os.Process
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID

/** Three separately invoked phases allow a genuine adb force-stop between offline write and recovery. */
@RunWith(AndroidJUnit4::class)
class ComplexNotesInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val args get() = InstrumentationRegistry.getArguments()
    private val stateFile get() = File(context.filesDir, "complex-notes-fixture.json")
    private fun guard() {
        assumeTrue("Run phased offline tests with scripts/run-complex-fixtures.py", args.containsKey("fixtureRound"))
        val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        val avd = automation.executeShellCommand("getprop ro.boot.qemu.avd_name").use {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() }
        }
        check(avd == "mote_fixture_api35") { "Dedicated synthetic fixture AVD required; never run on a personal device" }
        check(args.getString("fixtureRound")?.toIntOrNull() in 1..20) { "Explicit fixtureRound required" }
    }
    private fun sha(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun state() = JSONObject(stateFile.readText())
    private fun writeState(value: JSONObject) { stateFile.writeText(value.toString()) } // Synthetic metadata/fixtures only.
    private fun field(view: android.view.View, hint: String): android.widget.EditText? {
        if (view is android.widget.EditText && view.hint?.toString() == hint) return view
        if (view is android.view.ViewGroup) for (index in 0 until view.childCount) field(view.getChildAt(index), hint)?.let { return it }
        return null
    }
    private fun get(path: String): JSONObject {
        val config = Settings(context).read()
        val connection = URL(config.server + path).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 5000; connection.readTimeout = 15000; connection.instanceFollowRedirects = false
            connection.setRequestProperty("Authorization", "Bearer ${config.token}")
            assertEquals(200, connection.responseCode)
            return connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
        } finally { connection.disconnect() }
    }
    @Test fun stageOfflineComplexNotesAndPreparedRetry() {
        guard()
        check(!Settings(context).enabled)
        assertEquals("Do not overwrite pending observations", 0, context.queue().depth())
        val url = args.getString("fixtureServer") ?: error("fixtureServer required")
        val token = args.getString("fixtureToken") ?: error("fixtureToken required")
        val round = args.getString("fixtureRound")!!.toInt()
        // Caller must withhold adb reverse until recoverOfflinePreparedRetry has finished.
        assertThrows(Exception::class.java) {
            URL("$url/api/health").openConnection().apply { connectTimeout = 1000; readTimeout = 1000 }.getInputStream().use { it.read() }
        }
        val settings = Settings(context)
        context.getSharedPreferences("mote", 0).edit().putString("deviceId", "android-complex-${UUID.randomUUID()}").commit()
        val config = settings.read().copy(server = url, token = token, deviceName = "Android complex synthetic round $round", debugHttp = true, wifiOnly = false, contentEncryptionEnabled = false)
        settings.save(config); val drafts = QuickNotes.draft(context); drafts.clear()
        val records = JSONArray()
        val fixtures = ComplexNoteFixtures.cases(round)
        var editorMs = 0L
        fixtures.forEach { fixture ->
            if (fixture.name == "maximum-length") {
                ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { activity ->
                    val started = SystemClock.elapsedRealtime()
                    activity.onActivity { field(it.window.decorView, "记下此刻的想法…")!!.setText(fixture.text) }
                    activity.recreate(); activity.awaitMainUi()
                    activity.onActivity { assertEquals(fixture.text, field(it.window.decorView, "记下此刻的想法…")!!.text.toString()) }
                    editorMs = SystemClock.elapsedRealtime() - started
                    assertEquals(fixture.text, drafts.read().text)
                }
            }
            val id = QuickNotes.save(context, fixture.text, fixture.mood)
            val saved = JSONObject(File(context.noBackupFilesDir, "queue/$id.event").readText())
            records.put(JSONObject().put("id", id).put("name", fixture.name).put("text", fixture.text).put("mood", fixture.mood).put("capturedAt", saved.getString("capturedAt")))
            assertEquals("", drafts.read().text)
        }
        val pending = ComplexNoteFixtures.Case("post-enqueue-scheduler-failure", "合成提交边界 #$round：已写入队列后模拟调度失败，重启后不能创建新 UUID。🙂\n  原文仍保留。", "等待重试")
        assertThrows(IllegalStateException::class.java) { QuickNotes.save(context, pending.text, pending.mood) { throw IllegalStateException("Synthetic scheduler failure") } }
        val prepared = drafts.read().prepared ?: error("A post-enqueue scheduling failure must retain the prepared submission")
        records.put(JSONObject().put("id", prepared.getString("id")).put("name", pending.name).put("text", pending.text).put("mood", pending.mood).put("capturedAt", prepared.getString("capturedAt")))
        assertEquals(records.length(), context.queue().depth())
        writeState(JSONObject().put("round", round).put("phase", "offline").put("stagePid", Process.myPid()).put("deviceId", settings.deviceId)
            .put("editorRecreationMs", editorMs).put("prepared", prepared).put("records", records))
        println("MOTE_COMPLEX round=$round phase=offline records=${records.length()} editorRecreationMs=$editorMs")
    }
    @Test fun recoverOfflinePreparedRetry() {
        guard(); val before = state(); check(before.getString("phase") == "offline")
        assertNotEquals("Caller must force-stop the application between phases", before.getInt("stagePid"), Process.myPid())
        assertEquals(before.getString("deviceId"), Settings(context).deviceId)
        val records = before.getJSONArray("records")
        assertEquals(records.length(), context.queue().depth())
        val drafts = QuickNotes.draft(context); val pending = drafts.read()
        assertEquals(before.getJSONObject("prepared").toString(), pending.prepared!!.toString())
        ActivityScenario.launch(MainActivity::class.java).awaitMainUi().use { activity ->
            activity.onActivity { assertEquals(pending.text, field(it.window.decorView, "记下此刻的想法…")!!.text.toString()) }
            activity.recreate(); activity.awaitMainUi()
            activity.onActivity { assertEquals(pending.text, field(it.window.decorView, "记下此刻的想法…")!!.text.toString()) }
        }
        val id = QuickNotes.save(context, pending.text, pending.mood)
        assertEquals(pending.prepared.getString("id"), id)
        assertEquals("Recovery must reuse the existing queue record", records.length(), context.queue().depth())
        assertEquals("", drafts.read().text)
        val recreated = context.queue(); recreated.recoverOrphans()
        assertEquals(records.length(), recreated.depth())
        before.put("phase", "recovered").put("recoveryPid", Process.myPid()); writeState(before)
        println("MOTE_COMPLEX round=${before.getInt("round")} phase=recovered records=${records.length()} samePreparedId=true")
    }
    @Test fun synchronizeAndCompareCentralEvidence() {
        guard(); val before = state(); check(before.getString("phase") == "recovered")
        val settings = Settings(context); assertEquals(before.getString("deviceId"), settings.deviceId)
        UploadWorker.schedule(context, settings.read(), true)
        val deadline = System.nanoTime() + 120_000_000_000L
        while (context.queue().depth() > 0 && System.nanoTime() < deadline) Thread.sleep(100)
        assertEquals("Central must acknowledge every original observation", 0, context.queue().depth())
        val expected = before.getJSONArray("records"); val results = JSONArray()
        for (index in 0 until expected.length()) {
            val item = expected.getJSONObject(index)
            val actual = get("/api/captures/${item.getString("id")}")
            assertEquals(item.getString("text"), actual.getString("ocrText"))
            // The central archive intentionally normalizes ISO timestamps to millisecond precision.
            assertEquals(java.time.Instant.parse(item.getString("capturedAt")).toEpochMilli(), java.time.Instant.parse(actual.getString("capturedAt")).toEpochMilli())
            assertEquals("note", actual.getString("source")); assertEquals(0, actual.getLong("durationMs")); assertTrue(actual.isNull("blobHash"))
            if (item.getString("mood").isBlank()) assertTrue(actual.isNull("mood")) else assertEquals(item.getString("mood"), actual.getString("mood"))
            val duplicate = JSONObject().put("id", actual.getString("id")).put("deviceId", actual.getString("deviceId"))
                .put("deviceName", actual.getString("deviceName")).put("platform", "android").put("capturedAt", actual.getString("capturedAt"))
                .put("source", "note").put("appId", "dev.mote.notes").put("appName", "随手记").put("durationMs", 0)
                .put("ocrText", item.getString("text")).put("privacy", JSONObject().put("excluded", false).put("redacted", false).put("mode", "none"))
            if (item.getString("mood").isNotBlank()) duplicate.put("mood", item.getString("mood"))
            val (code, ack) = HttpJson.post(settings.read().server + "/api/captures", duplicate, settings.read().token)
            assertEquals(200, code); assertEquals(item.getString("id"), ack!!.getString("id")); assertTrue(ack.getBoolean("duplicate"))
            results.put(JSONObject().put("id", item.getString("id")).put("name", item.getString("name")).put("utf16Length", item.getString("text").length).put("sha256", sha(item.getString("text"))))
        }
        val list = get("/api/notes?deviceId=${settings.deviceId}&limit=200").getJSONArray("items")
        assertEquals("Idempotent retries must not duplicate any note", expected.length(), list.length())
        before.put("phase", "verified").put("verification", results); writeState(before)
        File(context.filesDir, "complex-notes-result-${before.getInt("round")}.json").writeText(JSONObject().put("round", before.getInt("round"))
            .put("deviceId", settings.deviceId).put("stagePid", before.getInt("stagePid")).put("recoveryPid", before.getInt("recoveryPid"))
            .put("editorRecreationMs", before.getLong("editorRecreationMs")).put("records", results).toString())
        println("MOTE_COMPLEX round=${before.getInt("round")} phase=verified records=${results.length()} exactText=true noImage=true duplicateAck=true")
    }
}
