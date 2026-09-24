package dev.mote.collector

import android.webkit.WebView
import android.widget.FrameLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Generated HTML only. Does not read settings, connect to a real node or enable capture. */
@RunWith(AndroidJUnit4::class)
class NativeAskInstrumentedTest {
    private fun script(web: WebView, code: String): String {
        val done = CountDownLatch(1); var result = ""
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            web.evaluateJavascript(code) { result = it; done.countDown() }
        }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        return result
    }
    private fun load(web: WebView, origin: String) {
        val done = CountDownLatch(1)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            web.webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) { done.countDown() }
            }
            web.loadDataWithBaseURL("$origin/", "<html><body>Generated central session fixture</body></html>", "text/html", "UTF-8", null)
        }
        assertTrue(done.await(10, TimeUnit.SECONDS))
    }
    @Test fun centralWindowLoginSurvivesNativeNavigationAndIsIsolatedByNode() {
        val origin = "https://central-session.fixture.invalid"
        lateinit var original: WebView
        ActivityScenario.launch(FixtureActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                original = CentralWebSession.acquire(activity, origin)
                activity.setContentView(FrameLayout(activity).apply { addView(original) })
            }
            load(original, origin)
            assertEquals("\"generated-session\"", script(original, "sessionStorage.setItem('fixture-login','generated-session'); sessionStorage.getItem('fixture-login')"))
            scenario.onActivity { CentralWebSession.release(original) }
        }
        ActivityScenario.launch(FixtureActivity::class.java).use { scenario ->
            lateinit var resumed: WebView
            scenario.onActivity { activity ->
                resumed = CentralWebSession.acquire(activity, origin)
                activity.setContentView(FrameLayout(activity).apply { addView(resumed) })
                assertSame(original, resumed)
            }
            assertEquals("\"generated-session\"", script(resumed, "location.hash='archive'; sessionStorage.getItem('fixture-login')"))
            // The central site's logout clears this same shared session.
            assertEquals("null", script(resumed, "sessionStorage.removeItem('fixture-login'); sessionStorage.getItem('fixture-login')"))
            script(resumed, "sessionStorage.setItem('fixture-login','old-node-session')")
            lateinit var other: WebView
            scenario.onActivity { activity ->
                CentralWebSession.release(resumed)
                other = CentralWebSession.acquire(activity, "https://other-central.fixture.invalid")
                activity.setContentView(FrameLayout(activity).apply { addView(other) })
                assertNotSame(original, other)
            }
            load(other, "https://other-central.fixture.invalid")
            assertEquals("null", script(other, "sessionStorage.getItem('fixture-login')"))
            scenario.onActivity { CentralWebSession.release(other) }
        }
    }
}
