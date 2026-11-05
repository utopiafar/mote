package dev.mote.collector

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** G09: capture status stays inside the notification and status screens; the
 * app never asks for an overlay above other apps. */
class CaptureManifestTest {
    private fun manifestFile(): File = listOf(
        File("src/main/AndroidManifest.xml"),
        File("app/src/main/AndroidManifest.xml"),
        File(System.getProperty("user.dir"), "src/main/AndroidManifest.xml"),
        File(System.getProperty("user.dir"), "app/src/main/AndroidManifest.xml"),
    ).firstOrNull(File::isFile) ?: error("AndroidManifest.xml not found from ${System.getProperty("user.dir")}")

    @Test fun theManifestDoesNotRequestSystemAlertWindow() {
        val manifest = manifestFile().readText()
        assertTrue("The app manifest is present", manifest.contains("<manifest"))
        assertFalse("No floating status layer above other apps", manifest.contains("SYSTEM_ALERT_WINDOW"))
    }
}
