package dev.mote.collector

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Reads only the fixture app's own package label; never starts collection. */
@RunWith(AndroidJUnit4::class)
class AppNameInstrumentedTest {
    @Test fun platformLabelIsUsedInsteadOfPackageId() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val expected = context.packageManager.getApplicationLabel(context.applicationInfo).toString().trim().take(200)
        assertEquals(expected, CollectorMetadata.appName(context, context.packageName))
        assertNotEquals(context.packageName, CollectorMetadata.appName(context, context.packageName))
    }
    @Test fun missingApplicationIsExplicitlyUnknown() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("未知应用", CollectorMetadata.appName(context, "dev.mote.generated.nonexistent"))
    }
}
