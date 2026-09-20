package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

class ProtectedCaptureTest {
    private val config = CollectorConfig(deviceName = "Generated phone", nsfw = NsfwConfig(), appCollectionRules = AppCollectionRules.LEGACY_DEFAULT)
    @Test fun skipsMoteForegroundAndSplitScreenWithoutChangingOtherApplications() {
        val own = BuildConfig.APPLICATION_ID
        assertEquals(AppCollectionMode.OFF, CapturePipeline.policy(config, WindowSnapshot(setOf(own), own, true)))
        assertEquals(AppCollectionMode.OFF, CapturePipeline.policy(config, WindowSnapshot(setOf(own, "fixture.editor"), "fixture.editor", true)))
        assertEquals(AppCollectionMode.CONTENT, CapturePipeline.policy(config, WindowSnapshot(setOf("fixture.editor"), "fixture.editor", true)))
    }
    @Test fun explicitActivityOnlyMoteRuleStillWorksWithoutPixels() {
        val own = BuildConfig.APPLICATION_ID
        val activity = config.copy(appCollectionRules = AppCollectionRules.fromLines(AppCollectionMode.CONTENT, "$own=activity").json())
        assertEquals(AppCollectionMode.ACTIVITY, CapturePipeline.policy(activity, WindowSnapshot(setOf(own), own, true)))
    }
}
