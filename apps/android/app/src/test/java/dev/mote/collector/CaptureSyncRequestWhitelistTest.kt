package dev.mote.collector

import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

/** Y08: the 采集与同步 page never lists other devices or reads device credentials. */
class CaptureSyncRequestWhitelistTest {
    private val module = File(checkNotNull(System.getProperty("user.dir")))

    @Test fun captureSyncPageNeverRequestsTheDeviceList() {
        for (name in listOf("SourcesActivity.kt", "CaptureSyncPresentation.kt")) {
            val source = File(module, "src/main/java/dev/mote/collector/$name").readText()
            assertFalse("$name must not read /api/devices", source.contains("/api/devices"))
        }
    }
}
