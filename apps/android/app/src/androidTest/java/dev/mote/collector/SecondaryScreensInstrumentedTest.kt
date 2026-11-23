package dev.mote.collector

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inspector.WindowInspector
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/** Only the explicitly selected task emulator; generated data never leaves the device. */
@RunWith(AndroidJUnit4::class)
class SecondaryScreensInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun <T> main(block: () -> T): T {
        val result = AtomicReference<Result<T>>(); instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }
    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun visible(): List<View> = WindowInspector.getGlobalWindowViews().filter { it.isShown && it.hasWindowFocus() }.flatMap(::views).filter { it.isShown }
    private fun until(label: String, check: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (SystemClock.elapsedRealtime() < deadline) { if (check()) return; Thread.sleep(50) }
        fail(label)
    }
    private fun clickTag(tag: String) {
        until(tag) { main { visible().any { it.tag == tag && it.isEnabled } } }
        main { visible().single { it.tag == tag }.apply { requestRectangleOnScreen(android.graphics.Rect(0, 0, width, height), true); assertTrue(performClick()) } }
    }
    private fun clickText(text: String) {
        until(text) { main { visible().any { it is Button && it.text.toString() == text && it.isEnabled } } }
        main { (visible().single { it is Button && it.text.toString() == text && it.isEnabled }).performClick() }
    }
    private fun clickDialogPositive() {
        until("dialog positive") { main { visible().any { it.id == android.R.id.button1 && it.isEnabled } } }
        main { visible().single { it.id == android.R.id.button1 && it.isEnabled }.performClick() }
    }
    private fun fixture(block: () -> Unit) {
        assumeTrue(InstrumentationRegistry.getArguments().getString("secondaryUiFixture") == "true")
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("emu64a"))
        val settings = Settings(context); val previous = settings.read(); val language = MoteI18n.preference()
        require(!settings.enabled && !ProjectionService.running && !CaptureAccessibilityService.connected)
        require(context.queue().inventory().pending == 0)
        // Optional recovery of the exact generated fixture left by an interrupted source test.
        InstrumentationRegistry.getArguments().getString("secondaryCleanupSourceId")?.let { id ->
            context.localSources().sources().firstOrNull { it.id == id }?.let { source ->
                require(source.name == "Generated original settings" && source.uri == "content://generated/task-file.txt" && !source.enabled)
                context.localSources().remove(id); context.fileArchives().remove(id)
            }
        }
        val originalSources = context.localSources().sources().map { it.id }.toSet()
        try {
            MoteI18n.select(context, "zh-CN")
            settings.save(previous.copy(server = "", token = "", syncPaused = true), confirmCentralEndpoint = true)
            block()
        } finally {
            context.localSources().sources().filterNot { it.id in originalSources }.forEach { context.localSources().remove(it.id); context.fileArchives().remove(it.id) }
            settings.save(previous, confirmCentralEndpoint = true)
            MoteI18n.select(context, language)
        }
    }
    private fun screenshotOne(activity: Activity, name: String) {
        assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
        val root = activity.window.decorView
        val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        val canvas=Canvas(bitmap);root.draw(canvas)
        WindowInspector.getGlobalWindowViews().filter { it!==root && it.isShown && it.hasWindowFocus() }.forEach { window ->
            val position=IntArray(2);window.getLocationOnScreen(position);canvas.save();canvas.translate(position[0].toFloat(),position[1].toFloat());window.draw(canvas);canvas.restore()
        }
        val directory = File(context.filesDir, "generated-secondary-ui").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun screenshots(scenario:ActivityScenario<out Activity>,name:String) {
        val before=MoteAppearance.preference()
        try { for(theme in listOf(AppearancePreference.LIGHT,AppearancePreference.DARK)) {
            main { MoteAppearance.select(context,theme) };instrumentation.waitForIdleSync()
            val frame=java.util.concurrent.CountDownLatch(1);scenario.onActivity { a -> a.window.decorView.postOnAnimation { a.window.decorView.postOnAnimation { frame.countDown() } } };assertTrue(frame.await(5,java.util.concurrent.TimeUnit.SECONDS))
            scenario.onActivity { screenshotOne(it,name+if(theme==AppearancePreference.DARK)"-dark" else "") }
        } } finally { main { MoteAppearance.select(context,before) } }
    }
    @Test fun generatedSecondaryPagesKeepSecureWindowAndExposeCurrentState() = fixture {
        val pages = listOf(
            SourcesActivity::class.java to "sources", FileTaskActivity::class.java to "file-import",
            SyncQueueActivity::class.java to "sync", SyncRecoveryActivity::class.java to "recovery",
            BackupActivity::class.java to "backup", StorageActivity::class.java to "storage",
            StorageStatisticsActivity::class.java to "statistics", UploadHistorySettingsActivity::class.java to "history-retention"
        )
        for ((type, name) in pages) {
            ActivityScenario.launch<Activity>(Intent(context, type)).use { scenario ->
                until("$name ready") { main { visible().filterIsInstance<TextView>().none { it.text.toString().startsWith("正在读取") } } }
                instrumentation.waitForIdleSync()
                screenshots(scenario,name)
                assertFalse(Settings(context).enabled)
            }
        }
    }

    @Test fun calendarDescriptionCancellationSaveAndSourceRemovalUseRealStore() = fixture {
        val source = LocalSource(name = "Generated calendar", kind = "local-calendar", calendarId = 991991, enabled = false)
        context.localSources().save(source)
        val permission = context.checkSelfPermission(android.Manifest.permission.READ_CALENDAR)
        ActivityScenario.launch<SourcesActivity>(Intent(context, SourcesActivity::class.java).putExtra("sourceId", source.id)).use {
            until("description field") { main { visible().any { it.tag == "calendar-description" } } }
            main { (visible().single { it.tag == "calendar-description" } as EditText).setText("Generated cancelled description") }
            clickText(MoteI18n.text("取消"))
            assertEquals("", context.localSources().sources().single { it.id == source.id }.description)
        }
        ActivityScenario.launch<SourcesActivity>(Intent(context, SourcesActivity::class.java).putExtra("sourceId", source.id)).use {
            until("description field") { main { visible().any { it.tag == "calendar-description" } } }
            main { (visible().single { it.tag == "calendar-description" } as EditText).setText("Generated calendar context, separate from events") }
            clickText(MoteI18n.text("保存来源设置"))
            until("description persisted") { context.localSources().sources().single { it.id == source.id }.description == "Generated calendar context, separate from events" }
            val saved = context.localSources().sources().single { it.id == source.id }
            assertTrue(saved.contextDirty); assertEquals(source.calendarId, saved.calendarId)
            assertFalse(saved.enabled); assertEquals(source.daysBefore, saved.daysBefore); assertEquals(source.daysAfter, saved.daysAfter)
        }
        ActivityScenario.launch<SourcesActivity>(Intent(context, SourcesActivity::class.java).putExtra("detailSourceId", source.id)).use { scenario ->
            assertFalse(main { visible().any { it.tag == "source-remove" } })
            clickTag("source-connection")
            clickTag("source-remove")
            clickText(MoteI18n.text("取消"))
            assertTrue(context.localSources().sources().any { it.id == source.id })
            screenshots(scenario, "calendar-source-detail")
            clickTag("source-remove"); clickDialogPositive()
            until("source removed") { context.localSources().sources().none { it.id == source.id } }
        }
        assertEquals(permission, context.checkSelfPermission(android.Manifest.permission.READ_CALENDAR))
        assertEquals(0, context.queue().inventory().pending)
    }

    @Test fun backupOptionsAndHistoryDraftSurviveRecreationWithoutChangingRecords() = fixture {
        val before = context.queue().inventory()
        ActivityScenario.launch(BackupActivity::class.java).use { scenario ->
            clickTag("backup-config-tab")
            assertFalse(main { visible().filterIsInstance<CheckBox>().any() })
            clickTag("backup-export-options")
            main { visible().filterIsInstance<CheckBox>().single().isChecked = true }
            scenario.recreate()
            until("config tab restored") { main { visible().any { it.tag == "backup-config-tab" && it.isSelected } } }
            assertTrue(main { visible().filterIsInstance<CheckBox>().single().isChecked })
            screenshots(scenario, "backup-config")
            clickTag("backup-records-tab")
            assertFalse(main { visible().filterIsInstance<CheckBox>().any() })
            clickTag("backup-scope")
            assertTrue(main { visible().filterIsInstance<TextView>().any { it.text.toString().contains("ZIP 为明文") } })
        }
        val retention = UploadHistoryRetention.read(context)
        try {
            ActivityScenario.launch(UploadHistorySettingsActivity::class.java).use { scenario ->
                until("retention ready") { main { visible().any { it.tag == "history-retention-save" && it.isEnabled } } }
                main { (visible().single { it.tag == "history-retention-choice" } as Spinner).setSelection(2) }
                scenario.recreate()
                until("retention draft restored") { main { (visible().singleOrNull { it.tag == "history-retention-choice" } as? Spinner)?.selectedItemPosition == 2 } }
                clickTag("history-retention-save")
                until("retention saved") { UploadHistoryRetention.read(context) == 90 }
            }
        } finally { UploadHistoryRetention.save(context, retention) }
        assertEquals(before, context.queue().inventory())
    }

    @Test fun stalePauseButtonKeepsSourcePausedAfterBackgroundChange() = fixture {
        val source = LocalSource(name = "Generated stale pause", kind = "local-calendar", calendarId = 991992, enabled = true)
        context.localSources().save(source)
        ActivityScenario.launch<SourcesActivity>(Intent(context, SourcesActivity::class.java).putExtra("detailSourceId", source.id)).use {
            until("pause button") { main { visible().any { it.tag == "source-toggle" } } }
            main {
                val pause = visible().single { it.tag == "source-toggle" } as Button
                assertEquals(MoteI18n.text("暂停这个来源"), pause.text.toString())
                context.localSources().setEnabled(source.id, false)
                pause.performClick()
            }
            until("pause completed") { main { visible().filterIsInstance<TextView>().any { it.text.toString().contains(MoteI18n.text("操作已完成；同步进度会自动刷新")) } } }
            assertFalse(context.localSources().sources().single { it.id == source.id }.enabled)
        }
    }

    @Test fun sourceFailuresRemainVisibleOutsideCollapsedDetails() = fixture {
        val source = LocalSource(name = "Generated permission source", kind = "local-calendar", calendarId = 991993, enabled = true)
        context.localSources().save(source)
        for ((code, message) in listOf("permission" to "权限丢失，重新授权", "paused" to "中央已暂停，在中央恢复后重试", "provider" to "提供者不可用或缓存已满；保留旧快照，稍后重试", "context-conflict" to "资料说明与中央版本冲突，打开设置处理，文件保留待发。")) {
            context.localSources().status(source.id, code)
            ActivityScenario.launch<SourcesActivity>(Intent(context, SourcesActivity::class.java).putExtra("detailSourceId", source.id)).use { scenario ->
                until("visible $code") { main { visible().filterIsInstance<TextView>().any { it.tag == "source-primary-status" && it.text.toString() == MoteI18n.text(message) } } }
                assertFalse(main { visible().any { it.tag == "source-sync-details:content" } })
                screenshots(scenario, "source-$code")
            }
            assertTrue(context.localSources().sources().single { it.id == source.id }.enabled)
        }
    }

    @Test fun backupDoesNotOpenAnotherPickerWhileAWriteIsRunning() = fixture {
        val release = java.util.concurrent.CountDownLatch(1)
        val completed = java.util.concurrent.CountDownLatch(1)
        ActivityScenario.launch(BackupActivity::class.java).use { scenario ->
            try {
                scenario.onActivity { activity ->
                    val getTask = BackupActivity::class.java.getDeclaredMethod("getTask").apply { isAccessible = true }
                    val task = getTask.invoke(activity) as UiTask
                    assertTrue(task.start("Generated blocked write", {}, { check(release.await(15, java.util.concurrent.TimeUnit.SECONDS)) }, { completed.countDown() }))
                    views(activity.window.decorView).single { it.tag == "backup-restore-records" }.performClick()
                    views(activity.window.decorView).single { it.tag == "backup-export-records" }.performClick()
                    val pending = BackupActivity::class.java.getDeclaredField("pendingPicker").apply { isAccessible = true }
                    assertEquals(0, pending.getInt(activity))
                    assertTrue(task.busy)
                }
            } finally { release.countDown() }
            assertTrue(completed.await(15, java.util.concurrent.TimeUnit.SECONDS))
        }
    }

    @Test fun staleResumeSendingButtonKeepsTheExplicitResumeIntent() = fixture {
        val settings = Settings(context)
        ActivityScenario.launch(SyncQueueActivity::class.java).use { scenario ->
            until("resume sending") { main { visible().filterIsInstance<Button>().any { it.tag == "sync-send-pause" && it.text.toString() == MoteI18n.text("恢复全部发送") } } }
            scenario.onActivity { activity ->
                val button = views(activity.window.decorView).single { it.tag == "sync-send-pause" }
                settings.save(settings.read().copy(syncPaused = false))
                button.performClick()
            }
            until("resume completed") { main { visible().single { it.tag == "sync-send-pause" }.isEnabled } }
            assertFalse(settings.read().syncPaused); assertFalse(settings.enabled)
        }
    }

    @Test fun sendPauseChangesOnlySendingAndDisconnectedSendStaysUnavailable() = fixture {
        val settings = Settings(context); val before = context.queue().inventory()
        ActivityScenario.launch(SyncQueueActivity::class.java).use { scenario ->
            until("send controls") { main { visible().any { it.tag == "sync-send-pause" } } }
            assertFalse(main { visible().single { it.tag == "sync-send-now" }.isEnabled })
            clickTag("sync-send-pause")
            until("send resumed") { !settings.read().syncPaused }
            assertFalse(settings.enabled)
            assertFalse(main { visible().single { it.tag == "sync-send-now" }.isEnabled })
            clickTag("sync-send-pause")
            until("send paused") { settings.read().syncPaused }
            screenshots(scenario, "sync-send-paused")
            clickTag("sync-history-tab")
            scenario.recreate()
            until("history tab restored") { main { visible().any { it.tag == "sync-history-tab" && it.isSelected } } }
        }
        assertEquals(before, context.queue().inventory()); assertFalse(settings.enabled)
    }
    @Test fun generatedCentralCheckReplayAndHistoryKeepMissingDeletedAndConflictStatesDistinct() = fixture {
        assumeTrue(InstrumentationRegistry.getArguments().getString("nativeCentralFixture")=="true")
        val origin="http://127.0.0.1:47883";val token="generated-native-central-owner-token-123456"
        val settings=Settings(context);settings.save(settings.read().copy(server=origin,token=token,debugHttp=true,syncPaused=false,syncMode="manual",wifiOnly=false,syncChargingOnly=false,syncBatteryNotLow=false),confirmCentralEndpoint=true)
        val api=CentralClient(origin,token)
        fun note(label:String)=org.json.JSONObject().put("id",java.util.UUID.randomUUID().toString()).put("deviceId",settings.deviceId).put("deviceName","Generated recovery phone").put("platform","android").put("source","note").put("capturedAt",java.time.Instant.now().toString()).put("durationMs",0).put("ocrText",label).put("privacy",org.json.JSONObject().put("excluded",false))
        val present=note("Generated recovery already present");val missing=note("Generated recovery missing");val deleted=note("Generated recovery owner deleted");val conflict=note("Generated recovery local conflict")
        api.post("/api/captures",present);api.post("/api/captures",deleted);api.delete("/api/captures/"+deleted.getString("id"));api.post("/api/captures",org.json.JSONObject(conflict.toString()).put("ocrText","Generated retained Central conflict original"))
        listOf(present,missing,deleted,conflict).forEach { context.queue().enqueue(it,null) }
        val manager=androidx.work.WorkManager.getInstance(context)
        try {
            ActivityScenario.launch(SyncQueueActivity::class.java).use { scenario ->
                until("actual pending queue") { main { visible().filterIsInstance<TextView>().any { it.text.toString().contains("Generated recovery missing") } } }
                screenshots(scenario,"sync-real-pending")
                assertEquals(4,context.queue().pendingSync().count)
            }
            ActivityScenario.launch(SyncRecoveryActivity::class.java).use { scenario ->
                clickTag("recovery-check")
                until("real Central reconciliation completes") { context.getSharedPreferences("sync-recovery",0).getString("message","")!!.startsWith("检查完成：中央可见 2 条，不可见 2 条") }
                until("actual check result renders") { main { visible().filterIsInstance<TextView>().any { it.text.toString().startsWith("检查完成：中央可见 2 条，不可见 2 条") } } }
                assertEquals("Read-only reconciliation never acknowledges local records",4,context.queue().pendingSync().count)
                screenshots(scenario,"recovery-real-check-completed")
                main { visible().single { it.tag=="recovery-scope" }.performClick() }
                clickTag("recovery-replay");screenshots(scenario,"recovery-real-replay-confirm")
                clickText("取消");assertEquals(4,context.queue().pendingSync().count)
                clickTag("recovery-replay")
                clickDialogPositive()
                until("real replay scheduled") { context.getSharedPreferences("sync-recovery",0).getString("message","")!!.startsWith("已安排补传") }
                until("actual conflict and deletion remain held") { context.queue().syncIssues().size==2 }
                until("replay result reaches the actual screen") { main { visible().filterIsInstance<TextView>().any { it.text.toString().startsWith("已安排补传") } } }
                screenshots(scenario,"recovery-real-replay-result")
                val beforeStop=context.queue().inventory()
                settings.save(settings.read().copy(syncPaused=true))
                clickTag("recovery-check")
                until("actual check waits under the sending restriction") { manager.getWorkInfosForUniqueWork("mote-sync-recovery").get().any { !it.state.isFinished } }
                clickTag("recovery-stop")
                until("actual recovery job cancelled") { manager.getWorkInfosForUniqueWork("mote-sync-recovery").get().all { it.state.isFinished } }
                assertEquals(beforeStop,context.queue().inventory());assertTrue(settings.read().syncPaused);assertFalse(settings.enabled)
                screenshots(scenario,"recovery-real-stop-keeps-local-records")
            }
            assertEquals("Generated recovery missing",api.get("/api/captures/"+missing.getString("id")).getString("ocrText"))
            assertEquals("Generated retained Central conflict original",api.get("/api/captures/"+conflict.getString("id")).getString("ocrText"))
            assertEquals(setOf(deleted.getString("id"),conflict.getString("id")),context.queue().syncIssues().map { it.getString("id") }.toSet())
            assertTrue(context.queue().capture(deleted.getString("id"))!=null)
            assertTrue(runCatching { api.get("/api/captures/"+deleted.getString("id")) }.exceptionOrNull() is CentralFailure)
            ActivityScenario.launch(SyncQueueActivity::class.java).use { scenario ->
                clickTag("sync-history-tab");until("actual upload history renders") { main { visible().any { it.tag?.toString()?.startsWith("history-date-")==true } } }
                main { visible().single { it.tag?.toString()?.startsWith("history-date-")==true }.performClick() }
                until("real uploaded batches expand") { main { visible().any { it.tag?.toString()?.startsWith("history-batch-")==true } } }
                screenshots(scenario,"sync-real-upload-history")
                MoteAppearance.select(context,AppearancePreference.DARK);instrumentation.waitForIdleSync();screenshots(scenario,"sync-real-upload-history-dark");MoteAppearance.select(context,AppearancePreference.LIGHT)
            }
        } finally {
            manager.cancelAllWork().result.get()
            // Remove only this test's exact generated local originals after the
            // recovery assertions; leave real Central outcomes available as evidence.
            listOf(present,missing,deleted,conflict).forEach { generated ->
                val id=generated.getString("id")
                context.queue().capture(id)?.let { retained ->
                    check(retained.getString("deviceId")==settings.deviceId && retained.getString("ocrText")==generated.getString("ocrText"))
                    check(context.queue().resolveDedupe(id,"",null,null,null))
                }
            }
        }
        assertFalse(settings.enabled)
    }
    @Test fun realDiskDaysAndImageSettingsKeepCountsAndUnsavedChoicesSeparate() = fixture {
        val before=context.queue().inventory()
        val directory=File(context.filesDir,"generated-statistics-days").apply { mkdirs() }
        val first=File(directory,"generated-day-one.txt").apply { writeText("Generated disk bytes, not a daily saved count.");check(setLastModified(java.time.Instant.parse("2026-10-25T12:00:00Z").toEpochMilli())) }
        val second=File(directory,"generated-day-two.txt").apply { writeText("Generated second disk day.");check(setLastModified(java.time.Instant.parse("2026-10-26T12:00:00Z").toEpochMilli())) }
        try { ActivityScenario.launch(StorageStatisticsActivity::class.java).use { scenario ->
            until("Actual disk statistics ready"){main{visible().any{it.tag=="statistics-refresh" && it.isEnabled}}}
            clickTag("statistics-scope");clickTag("statistics-disk")
            until("Two actual modification days"){main{visible().filterIsInstance<TextView>().any{it.text.toString().startsWith("2026-10-25 ·")} && visible().filterIsInstance<TextView>().any{it.text.toString().startsWith("2026-10-26 ·")}}}
            main{assertTrue(visible().filterIsInstance<TextView>().any{it.text.toString().contains("日期分布不是每日新增量")});assertTrue(visible().filterIsInstance<TextView>().any{it.text.toString()=="未单独统计"});visible().filterIsInstance<TextView>().single{it.text.toString().startsWith("2026-10-25 ·")}.requestRectangleOnScreen(android.graphics.Rect(0,0,400,400),true)}
            screenshots(scenario,"statistics-two-actual-utc-days");assertEquals(before,context.queue().inventory())
        }
        ActivityScenario.launch<MainActivity>(Intent(context,MainActivity::class.java).putExtra("page","PROCESSING")).awaitMainUi().use { scenario -> screenshots(scenario,"image-quality-and-diagnostics-settings");assertFalse(Settings(context).enabled) }
        } finally { first.delete();second.delete();directory.delete() }
    }

}
