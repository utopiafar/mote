package dev.mote.collector

import android.os.SystemClock
import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import org.junit.Assert.assertTrue

fun <T : Activity> ActivityScenario<T>.awaitUiText(prefix: String): ActivityScenario<T> {
    fun contains(view: View): Boolean = (view is TextView && view.text.startsWith(prefix)) ||
        (view is ViewGroup && (0 until view.childCount).any { contains(view.getChildAt(it)) })
    val deadline = SystemClock.elapsedRealtime() + 10_000
    var ready = false
    while (!ready && SystemClock.elapsedRealtime() < deadline) {
        onActivity { ready = contains(it.window.decorView) }
        if (!ready) Thread.sleep(25)
    }
    assertTrue("Background UI snapshot must arrive", ready)
    return this
}

/** Wait for actual background restore completion, rather than relying on main-loop idleness. */
fun ActivityScenario<MainActivity>.awaitMainUi(): ActivityScenario<MainActivity> {
    fun views(root: View): Sequence<View> = sequence {
        yield(root)
        if (root is ViewGroup) for (i in 0 until root.childCount) yieldAll(views(root.getChildAt(i)))
    }
    val deadline = SystemClock.elapsedRealtime() + 10_000
    var ready = false
    while (!ready && SystemClock.elapsedRealtime() < deadline) {
        onActivity { activity ->
            val rows = views(activity.window.decorView).toList()
            ready = rows.filterIsInstance<TextView>().any { it.isShown && it.isClickable && it.text.toString() == MoteI18n.text("记录") }
        }
        if (!ready) Thread.sleep(25)
    }
    assertTrue("Committed settings and initial page must finish loading", ready)
    return this
}
