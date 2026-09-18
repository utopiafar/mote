package dev.mote.collector

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeAskInstrumentedTest {
    @Test fun askIsNativeAndOfflineFailureKeepsQuestionEditable() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = Settings(context); val before = settings.read()
        settings.save(before.copy(server = "", token = ""))
        try {
            ActivityScenario.launch(AskActivity::class.java).awaitUiText("问一问").use { scenario ->
                scenario.onActivity { activity ->
                    val views = mutableListOf<android.view.View>()
                    fun walk(view: android.view.View) { views += view; if (view is android.view.ViewGroup) repeat(view.childCount) { walk(view.getChildAt(it)) } }
                    walk(activity.window.decorView)
                    assertFalse(views.any { it is android.webkit.WebView })
                    assertTrue(views.filterIsInstance<android.widget.Button>().any { it.text.toString() == "发送" })
                    val input = views.filterIsInstance<android.widget.EditText>().first { it.hint.toString() == "你的问题" }
                    input.setText("生成的问题，不读取真实资料")
                    assertTrue(input.isEnabled)
                }
            }
        } finally { settings.save(before) }
    }
}
