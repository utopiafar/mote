package dev.mote.collector

import android.Manifest
import android.net.Uri
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

@RunWith(AndroidJUnit4::class)
class LocalSourcesInstrumentedTest {
    @Test fun generatedProviderCalendarFilesReferenceAndPartialDeletion() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val authority = context.packageName + ".source-fixtures"; val prefs = context.getSharedPreferences("source-fixture", 0)
        prefs.edit().clear().putString("mode", "full").commit()
        val scanner = SourceProviders(context.contentResolver, calendarsUri = Uri.parse("content://$authority/calendar/calendars"), instancesUri = Uri.parse("content://$authority/calendar/instances"))
        val now = Instant.parse("2026-09-14T00:00:00Z")
        val calendar = LocalSource(name = "合成日历", kind = "local-calendar", calendarId = 77)
        val directory = File(context.noBackupFilesDir, "source-test-${System.nanoTime()}")
        try {
            val result = scanner.scan(calendar, now); assertTrue(result.complete); assertEquals(1, result.items.size)
            assertEquals(now.toString(), result.items.single().getString("observedAt")); assertEquals("2026-09-15T03:00:00Z", result.items.single().getJSONObject("calendar").getString("start"))
            val store = LocalSourceStore(directory, SecretBox()); store.save(calendar); store.scan(calendar, result)
            prefs.edit().putString("mode", "hidden").commit(); assertThrows(IllegalStateException::class.java) { scanner.scan(calendar, now) }
            assertEquals(1, store.state(calendar.id).getJSONArray("pending").length())
            prefs.edit().putString("mode", "full").commit()
            val files = LocalSource(name = "合成文件目录", kind = "local-files", uri = "content://$authority/tree/root", tree = true)
            store.save(files); val snapshots = scanner.scan(files, now); assertTrue(snapshots.complete); assertEquals(1, snapshots.items.size)
            assertTrue(snapshots.items.single().getString("text").contains("👨‍👩‍👧‍👦")); store.scan(files, snapshots)
            val readCount = prefs.getInt("reads", 0); val reference = scanner.scan(files.copy(retention = "reference"), now)
            assertEquals("", reference.items.single().getString("text")); assertEquals(readCount, prefs.getInt("reads", 0))
            prefs.edit().putString("mode", "partial").commit(); val partial = scanner.scan(files, now); assertFalse(partial.complete); assertEquals(1, partial.skipped)
            store.scan(files, partial); assertEquals(1, store.state(files.id).getJSONArray("pending").length())
            prefs.edit().putString("mode", "failure").commit(); assertThrows(Exception::class.java) { scanner.scan(files, now) }
            prefs.edit().putString("mode", "missing").commit(); store.scan(files, scanner.scan(files, now))
            assertEquals(2, store.state(files.id).getJSONArray("pending").length()); assertTrue(store.state(files.id).getJSONArray("pending").getJSONObject(1).getBoolean("deleted"))
        } finally { directory.deleteRecursively(); prefs.edit().clear().commit() }
    }
    @Test fun nativeSourcesScreenDoesNotRequestCalendarPermissionUntilUserConnects() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val permission = context.checkSelfPermission(Manifest.permission.READ_CALENDAR)
        ActivityScenario.launch(SourcesActivity::class.java).use { scenario -> scenario.onActivity { activity ->
            val strings = mutableListOf<String>()
            fun walk(view: android.view.View) { if (view is android.widget.TextView) strings += view.text.toString(); if (view is android.view.ViewGroup) repeat(view.childCount) { walk(view.getChildAt(it)) } }
            walk(activity.window.decorView); assertTrue(strings.contains("连接本机日历")); assertTrue(strings.contains("选择文件目录"))
        } }
        assertEquals(permission, context.checkSelfPermission(Manifest.permission.READ_CALENDAR))
    }
    @Test fun optionalActualCentralRoundTripLostAckDeletionAndRestoration() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val connectionFile = File(context.filesDir, "source-fixture.json")
        org.junit.Assume.assumeTrue("Only explicit synthetic central fixture configuration enables network testing", connectionFile.exists())
        val connection = org.json.JSONObject(connectionFile.readText()); val base = connection.optString("url", connection.optString("server")); val token = connection.getString("token")
        require(base == "http://127.0.0.1:57559" && token.length >= 32 && BuildConfig.MOTE_PROFILE == "dev")
        val directory = File(context.noBackupFilesDir, "source-wire-test-${System.nanoTime()}"); val store = LocalSourceStore(directory, SecretBox())
        val authority = context.packageName + ".source-fixtures"; val prefs = context.getSharedPreferences("source-fixture", 0)
        val scanner = SourceProviders(context.contentResolver, calendarsUri = Uri.parse("content://$authority/calendar/calendars"), instancesUri = Uri.parse("content://$authority/calendar/instances"))
        val now = Instant.parse("2026-09-14T00:00:00Z")
        val source = LocalSource(name = "Android 合成文件链路", kind = "local-files", uri = "content://$authority/tree/root", tree = true)
        val calendar = LocalSource(name = "Android 合成计划链路", kind = "local-calendar", calendarId = 77)
        val ids = org.json.JSONArray()
        try {
            prefs.edit().putString("mode", "full").commit()
            for (selected in listOf(source, calendar)) {
                store.save(selected); store.selectTarget(selected.id, "fixture-target"); store.scan(selected, scanner.scan(selected, now))
                val (code, registration) = HttpJson.post("$base/api/sources", selected.registration("android-source-fixture"), token)
                assertTrue(code in 200..299); assertEquals(selected.id, registration!!.getString("id")); ids.put(selected.id)
                val (patch, updated) = HttpJson.request("PATCH", "$base/api/sources/${selected.id}", org.json.JSONObject().put("name", selected.name).put("retention", selected.retention), token)
                assertTrue(patch in 200..299); assertEquals(selected.id, updated!!.getString("id"))
                val pending = store.next(selected.id, "fixture-target")!!
                val first = HttpJson.request("PUT", "$base/api/sources/${selected.id}/items", pending, token)
                assertTrue(first.first in 200..299); assertTrue(SourceRules.validAck(selected.id, pending, first.second))
                // Deliberately lose the first ACK; reconstruct local storage then send the identical revision.
                val restored = LocalSourceStore(directory, SecretBox()); val retry = restored.next(selected.id, "fixture-target")!!
                assertEquals(pending.toString(), retry.toString())
                val repeated = HttpJson.request("PUT", "$base/api/sources/${selected.id}/items", retry, token)
                assertTrue(repeated.first in 200..299); assertTrue(SourceRules.validAck(selected.id, retry, repeated.second)); assertTrue(repeated.second!!.getBoolean("duplicate")); assertEquals(first.second!!.getString("id"), repeated.second!!.getString("id"))
                restored.acknowledge(selected.id, "fixture-target", retry.getString("externalId"), retry.getString("revision")); assertNull(restored.next(selected.id, "fixture-target"))
            }
            prefs.edit().putString("mode", "missing").commit(); store.scan(source, scanner.scan(source, now.plusSeconds(1)))
            val deletion = store.next(source.id, "fixture-target")!!; assertTrue(deletion.getBoolean("deleted")); assertEquals("", deletion.getString("text"))
            val deleted = HttpJson.request("PUT", "$base/api/sources/${source.id}/items", deletion, token); assertTrue(SourceRules.validAck(source.id, deletion, deleted.second)); store.acknowledge(source.id, "fixture-target", deletion.getString("externalId"), deletion.getString("revision"))
            prefs.edit().putString("mode", "full").commit(); store.scan(source, scanner.scan(source, now.plusSeconds(2)))
            val restoration = store.next(source.id, "fixture-target")!!; assertFalse(restoration.optBoolean("deleted"))
            val restoredAck = HttpJson.request("PUT", "$base/api/sources/${source.id}/items", restoration, token); assertTrue(SourceRules.validAck(source.id, restoration, restoredAck.second)); assertFalse(restoredAck.second!!.getBoolean("duplicate"))
            val (historyCode, history) = HttpJson.get("$base/api/sources/${source.id}/history?externalId=" + java.net.URLEncoder.encode(restoration.getString("externalId"), "UTF-8"), token)
            assertEquals(200, historyCode); assertEquals(3, history!!.getJSONArray("items").length())
            val (currentCode, current) = HttpJson.get("$base/api/sources/${source.id}/items", token); assertEquals(200, currentCode)
            val row = current!!.getJSONArray("items").getJSONObject(0); assertEquals(restoration.getString("revision"), row.getString("revision")); assertEquals(restoration.getString("text"), row.getString("text")); assertFalse(row.getBoolean("deleted"))
            File(context.filesDir, "source-fixture-result.json").writeText(org.json.JSONObject().put("sourceIds", ids).put("historyCount", 3).put("providerFixture", true).put("lostAckRetry", true).put("restorationCurrent", true).toString())
        } finally { directory.deleteRecursively(); prefs.edit().clear().commit(); connectionFile.delete() }
    }

}
