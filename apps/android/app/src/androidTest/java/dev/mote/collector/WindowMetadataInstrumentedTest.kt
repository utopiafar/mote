package dev.mote.collector

import android.app.UiAutomation
import android.accessibilityservice.AccessibilityServiceInfo
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test

/** Opt-in metadata inspection only. Never reads node text or takes a screenshot. */
class WindowMetadataInstrumentedTest {
    @Test fun inspectSystemWindows() {
        require(InstrumentationRegistry.getArguments().getString("inspectWindows") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        val info = automation.serviceInfo
        info.flags = info.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        automation.serviceInfo = info
        val rows = automation.windows.filter { it.type == 3 }.map { window ->
            val root = window.root
            val bounds = android.graphics.Rect(); window.getBoundsInScreen(bounds)
            val row = "type=${window.type} owner=${root?.packageName} class=${root?.className} bounds=$bounds active=${window.isActive} focused=${window.isFocused}"
            @Suppress("DEPRECATION") root?.recycle()
            row
        }
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", rows.joinToString("\n")) })
    }
}
