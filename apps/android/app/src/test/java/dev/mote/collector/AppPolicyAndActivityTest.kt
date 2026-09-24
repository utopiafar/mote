package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

class AppPolicyAndActivityTest {
    @Test fun miuiNavigationOutsidePlatformInsetDoesNotApplyLauncherPrivacyToOtherApps() {
        val display = CaptureBounds(0, 0, 1200, 2608)
        val strip = CaptureBounds(0, 2534, 1200, 2608)
        fun match(bounds: CaptureBounds = strip, owner: String = SystemBarRegion.MIUI_HOME, system: Boolean = true,
            type: Int = 3, active: Boolean = false, focused: Boolean = false, inset: Int = 48) =
            SystemBarRegion.miuiNavigation(bounds, display, inset, 3f, owner, system, type, active, focused)
        assertFalse(SystemBarRegion.contains(strip, display, CaptureBounds(0, 144, 0, 48)))
        assertTrue(match())
        assertFalse(match(type = 1)); assertFalse(match(active = true)); assertFalse(match(focused = true))
        assertFalse(match(system = false)); assertFalse(match(owner = "fixture.overlay")); assertFalse(match(inset = 0))
        assertFalse(match(bounds = display))
        assertFalse(match(bounds = CaptureBounds(0, 2511, 1200, 2608)))
        assertFalse(match(bounds = CaptureBounds(1, 2534, 1200, 2608)))
        assertFalse(match(bounds = CaptureBounds(0, 0, 1200, 74)))
        val app = CollectionWindow(1, "fixture.video")
        val bar = CollectionWindow(3, SystemBarRegion.MIUI_HOME, match())
        val rules = AppCollectionRules.fromLines(AppCollectionMode.CONTENT, "com.miui.home=activity")
        val snapshot = CollectionWindows.snapshot(listOf(app, bar, CollectionWindow(3, "com.android.systemui", true)), app.packageName)
        assertEquals(AppCollectionMode.CONTENT, rules.decide(snapshot, emptySet()))
        assertEquals(AppCollectionMode.ACTIVITY, rules.decide(CollectionWindows.snapshot(
            listOf(CollectionWindow(1, SystemBarRegion.MIUI_HOME), bar), SystemBarRegion.MIUI_HOME), emptySet()))
        assertEquals(AppCollectionMode.OFF, rules.decide(CollectionWindows.snapshot(
            listOf(app, CollectionWindow(3, SystemBarRegion.MIUI_HOME)), app.packageName), emptySet()))
        assertEquals(AppCollectionMode.OFF, rules.decide(CollectionWindows.snapshot(
            listOf(app, CollectionWindow(1, SystemBarRegion.MIUI_HOME)), app.packageName), emptySet()))
    }

    @Test fun systemBarsUsePlatformInsetsAndNeverHideOverlaysOutsideThem() {
        val display = CaptureBounds(0, 0, 1200, 2608)
        val insets = CaptureBounds(0, 144, 0, 74)
        assertTrue(SystemBarRegion.contains(CaptureBounds(0, 0, 1200, 144), display, insets))
        assertTrue(SystemBarRegion.contains(CaptureBounds(0, 2534, 1200, 2608), display, insets))
        assertFalse(SystemBarRegion.contains(CaptureBounds(0, 0, 1200, 600), display, insets))
        assertFalse(SystemBarRegion.contains(CaptureBounds(0, 2533, 1200, 2608), display, insets))
        assertFalse(SystemBarRegion.contains(CaptureBounds(0, 0, 1200, 144), display, CaptureBounds(0, 0, 0, 0)))
        assertFalse(SystemBarRegion.contains(CaptureBounds(-1, 0, 1200, 144), display, insets))
        val landscape = CaptureBounds(0, 0, 2608, 1200)
        assertTrue(SystemBarRegion.contains(CaptureBounds(2534, 0, 2608, 1200), landscape, CaptureBounds(0, 0, 74, 0)))
    }

    @Test fun freshAndLegacyDefaultsDifferButAnExplicitContentRuleIsPreserved() {
        assertEquals(AppCollectionMode.ACTIVITY, AppCollectionRules.parse(AppCollectionRules.DEFAULT).defaultMode)
        assertEquals(AppCollectionMode.CONTENT, AppCollectionRules.parse(AppCollectionRules.LEGACY_DEFAULT).defaultMode)
        val configured = AppCollectionRules.fromLines(AppCollectionMode.CONTENT, "fixture.private=activity")
        assertEquals(AppCollectionMode.CONTENT, configured.decide(WindowSnapshot(setOf("fixture.editor"), "fixture.editor", true), emptySet()))
        assertEquals(AppCollectionMode.OFF, configured.decide(WindowSnapshot(setOf("fixture.editor"), "fixture.editor", false), emptySet()))
    }

    @Test fun normalSystemBarsDoNotBlockContentButRealOverlaysStillDo() {
        val rules = AppCollectionRules.fromLines(AppCollectionMode.ACTIVITY, "com.example.page=content")
        val app = CollectionWindow(1, "com.example.page")
        val chrome = CollectionWindows.snapshot(listOf(app, CollectionWindow(3, "com.android.systemui", systemBar = true)), app.packageName)
        assertEquals(AppCollectionMode.CONTENT, rules.decide(chrome, emptySet()))
        assertEquals(AppCollectionMode.OFF, rules.decide(CollectionWindows.snapshot(listOf(app, CollectionWindow(3, "com.android.systemui")), app.packageName), emptySet()))
        assertEquals(AppCollectionMode.OFF, rules.decide(CollectionWindows.snapshot(listOf(app, CollectionWindow(3, "com.example.overlay", systemBar = true)), app.packageName), emptySet()))
    }
    @Test fun defaultContentIncludesLauncherSystemAndUnidentifiedSurfaces() {
        val defaults = AppCollectionRules.parse(AppCollectionRules.LEGACY_DEFAULT)
        val launcher = CollectionWindows.snapshot(listOf(CollectionWindow(1, "com.example.launcher")), "com.example.launcher")
        val system = CollectionWindows.snapshot(listOf(CollectionWindow(3, "com.android.systemui")), null)
        val absent = WindowSnapshot(emptySet(), null, false)
        for (window in listOf(launcher, system, absent, WindowSnapshot(setOf("com.example.launcher"), null, false))) {
            assertEquals(AppCollectionMode.CONTENT, defaults.decide(window, emptySet()))
        }
        assertEquals(AppCollectionMode.OFF, defaults.decide(launcher, setOf("com.example.launcher")))
        assertEquals(AppCollectionMode.OFF, defaults.decide(absent, setOf("com.example.private")))
        val excluded = AppCollectionRules.fromLines(AppCollectionMode.CONTENT, "com.example.launcher=off\ncom.android.systemui=off")
        for (window in listOf(launcher, system, absent)) assertEquals(AppCollectionMode.OFF, excluded.decide(window, emptySet()))
        val activity = AppCollectionRules.fromLines(AppCollectionMode.ACTIVITY, "")
        assertEquals(AppCollectionMode.OFF, activity.decide(absent, emptySet()))
        assertEquals(AppCollectionMode.OFF, activity.decide(system, emptySet()))
    }

    @Test fun explicitRulesAndLegacyExclusionsFailClosedForAmbiguousWindows() {
        val rules = AppCollectionRules.fromLines(AppCollectionMode.CONTENT, "com.example.chat=activity\ncom.example.private=off")
        fun window(id: String) = WindowSnapshot(setOf(id), id, true)
        assertEquals(AppCollectionMode.CONTENT, rules.decide(window("com.example.editor"), emptySet()))
        assertEquals(AppCollectionMode.ACTIVITY, rules.decide(window("com.example.chat"), emptySet()))
        assertEquals(AppCollectionMode.OFF, rules.decide(window("com.example.private"), emptySet()))
        assertEquals(AppCollectionMode.OFF, rules.decide(window("com.example.chat"), setOf("com.example.chat")))
        assertEquals(AppCollectionMode.OFF, rules.decide(CollectionWindows.snapshot(listOf(CollectionWindow(1, "com.example.chat"), CollectionWindow(1, "com.example.editor")), "com.example.editor"), emptySet()))
        assertEquals(AppCollectionMode.OFF, rules.decide(WindowSnapshot(setOf("com.example.editor"), "com.example.editor", false), emptySet()))
        assertEquals(AppCollectionMode.OFF, rules.decide(WindowSnapshot(emptySet(), null, false), emptySet()))
        assertEquals(rules, AppCollectionRules.parse(rules.json()))
        assertFalse(AppCollectionRules.fromLines(AppCollectionMode.ACTIVITY, "com.example.private=off").mayCollectContent())
        for (value in listOf("com.example.chat=guess", "com.example.chat=activity\ncom.example.chat=content", "not a package=off"))
            assertThrows(Exception::class.java) { AppCollectionRules.fromLines(AppCollectionMode.CONTENT, value) }
        assertThrows(Exception::class.java) { AppCollectionRules.parse("{\"default\":\"content\",\"default\":\"off\",\"apps\":{}}") }
    }
    @Test fun keyboardSystemOverlayAndUnknownWindowsPreventAnySample() {
        val rules = AppCollectionRules.fromLines(AppCollectionMode.CONTENT, "android=off\ncom.example.ime=activity")
        assertEquals(AppCollectionMode.OFF, rules.apps["android"])
        val app = CollectionWindow(1, "com.example.editor")
        assertEquals(AppCollectionMode.CONTENT, rules.decide(CollectionWindows.snapshot(listOf(app), app.packageName), emptySet()))
        for (type in listOf(2, 3, 4, 5, 6, 99)) {
            val windows = CollectionWindows.snapshot(listOf(app, CollectionWindow(type, "com.example.ime")), app.packageName)
            if (type !in 2..3) assertFalse(windows.trustworthy)
            assertEquals(AppCollectionMode.OFF, rules.decide(windows, emptySet()))
        }
        val ordinarySystemWindow = CollectionWindows.snapshot(listOf(app, CollectionWindow(3, "com.example.system")), app.packageName)
        assertTrue(ordinarySystemWindow.trustworthy)
        assertEquals(AppCollectionMode.CONTENT, rules.decide(ordinarySystemWindow, emptySet()))
        assertEquals(AppCollectionMode.OFF, rules.decide(ordinarySystemWindow, setOf("com.example.system")))
        val activityOnly = AppCollectionRules.fromLines(AppCollectionMode.ACTIVITY, "com.example.ime=off")
        val activityWithKeyboard = CollectionWindows.snapshot(listOf(app, CollectionWindow(2, "com.example.ime")), app.packageName)
        assertEquals(AppCollectionMode.ACTIVITY, activityOnly.decide(activityWithKeyboard, emptySet()))
        assertEquals(AppCollectionMode.OFF, activityOnly.decide(activityWithKeyboard, setOf("com.example.ime")))
        assertFalse(activityOnly.mayCollectContent())
        assertFalse(CollectionWindows.snapshot(listOf(CollectionWindow(1, null)), null).trustworthy)
    }
    @Test fun activityQueuePreservesNoContentAcrossRestartRetryAndAcknowledgement() {
        val directory = Files.createTempDirectory("mote-activity").toFile()
        val cipher = object : ByteCipher { override fun seal(bytes: ByteArray) = bytes; override fun open(bytes: ByteArray) = bytes }
        try {
            val changes = mutableListOf<OperationKind>()
            val queue = DurableQueue(directory, cipher) { kind, _, _ -> changes += kind }
            val event = JSONObject().put("id", UUID.randomUUID().toString()).put("capturedAt", "2026-09-14T00:00:00Z")
                .put("source", "activity").put("appId", "com.example.chat").put("appName", "Generated Chat").put("durationMs", 0)
                .put("privacy", JSONObject().put("excluded", false).put("collection", "activity"))
                .put("metadata", JSONObject().put("version", 1).put("capture", JSONObject().put("intervalMs", 30000)))
            queue.enqueue(event, null, 100000); queue.enqueue(event, null, 100000)
            val restored = DurableQueue(directory, cipher)
            assertEquals(StateSeries.extend(null, event).toString(), restored.peek()!!.toString()); assertEquals(1, queue.summary().getInt("activities"))
            assertEquals(0, directory.listFiles()!!.count { it.extension == "blob" })
            for (key in listOf("ocrText", "windowTitle", "title", "mood", "provenance")) {
                val invalid = JSONObject(event.toString()).put("id", UUID.randomUUID().toString()).put(key, "untrusted content")
                assertThrows(IllegalArgumentException::class.java) { queue.enqueue(invalid, null, 100000) }
            }
            assertThrows(IllegalArgumentException::class.java) { queue.enqueue(event, byteArrayOf(1), 100000) }
            val badMetadata = JSONObject(event.toString()).put("id", UUID.randomUUID().toString())
            badMetadata.getJSONObject("metadata").getJSONObject("capture").put("ocrEnabled", false)
            assertThrows(IllegalArgumentException::class.java) { queue.enqueue(badMetadata, null, 100000) }
            queue.acknowledge(event.getString("id"), 123); queue.acknowledge(event.getString("id"), 123)
            assertEquals(listOf(OperationKind.ACTIVITY_QUEUED, OperationKind.ACTIVITY_ACK), changes)
            assertEquals(0, queue.depth())
        } finally { directory.deleteRecursively() }
    }
    @Test fun observationIntervalsDoNotUseDifferentAsyncCompletionTimes() {
        data class Sample(val observed: Long, val completed: Long)
        val first = Sample(0, 10000); val second = Sample(15000, 17000)
        assertEquals(7000, second.completed - first.completed) // The old processing-clock result was wrong.
        assertEquals(15000, SamplingTime.interval(first.observed, second.observed, 15000))
        assertEquals(15000, SamplingTime.interval(0, 60000, 15000))
        assertEquals(0, SamplingTime.interval(15000, 14000, 15000))
    }
    @Test fun oldStatisticsGainActivityCountersWithoutLosingEpochOrTotals() {
        val directory = Files.createTempDirectory("mote-activity-ledger").toFile()
        try {
            val file = File(directory, "ledger.json"); val ledger = OperationLedger(file)
            ledger.record(OperationKind.SCREEN_QUEUED); ledger.record(OperationKind.NOTE_ACK, bytes = 345)
            val old = ledger.read(); val epoch = old.getString("epochId")
            listOf("ACTIVITY_QUEUED", "ACTIVITY_ACK", "ACTIVITY_FAILED").forEach { old.getJSONObject("counts").remove(it) }
            file.writeText(old.toString())
            val loaded = OperationLedger(file).read()
            assertEquals(epoch, loaded.getString("epochId")); assertEquals(345, loaded.getLong("confirmedUploadBytes"))
            assertEquals(1, loaded.getJSONObject("counts").getInt("SCREEN_QUEUED")); assertEquals(0, loaded.getJSONObject("counts").getInt("ACTIVITY_QUEUED"))
            ledger.record(OperationKind.ACTIVITY_ACK, bytes = 100)
            assertEquals(445, ledger.read().getLong("confirmedUploadBytes")); assertEquals(epoch, ledger.read().getString("epochId"))
        } finally { directory.deleteRecursively() }
    }
}
