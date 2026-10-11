package dev.mote.collector

import android.os.SystemClock
import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Assert.assertSame
import org.junit.Assert.assertEquals

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
            ready = rows.any { it is MotePrimaryNavigation && it.isShown }
        }
        if (!ready) Thread.sleep(25)
    }
    assertTrue("Committed settings and initial page must finish loading", ready)
    return this
}

/** Android 15's test invoker only finishes its cover Activity; explicitly return the same task. */
fun <T : Activity> ActivityScenario<T>.resumeGeneratedTask(): ActivityScenario<T> {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    require(context.packageName == "dev.mote.collector.dev" && android.os.Build.FINGERPRINT.contains("emu64a"))
    lateinit var original: T
    var taskId = -1
    onActivity { original = it; taskId = it.taskId }
    assertEquals(androidx.lifecycle.Lifecycle.State.CREATED, state)
    val task = original.getSystemService(android.app.ActivityManager::class.java).appTasks.single { it.taskInfo.taskId == taskId }
    task.moveToFront()
    val deadline = SystemClock.elapsedRealtime() + 10_000
    // getState itself throws while the invoker observes the intermediate STARTED transition.
    while (runCatching { state }.getOrNull() != androidx.lifecycle.Lifecycle.State.RESUMED && SystemClock.elapsedRealtime() < deadline) Thread.sleep(25)
    assertEquals("The OS must actually resume the existing task", androidx.lifecycle.Lifecycle.State.RESUMED, state)
    onActivity { assertSame("Returning must preserve the existing Activity", original, it); assertEquals(taskId, it.taskId) }
    return this
}

/** Follow the product's shared Add menu; direct private-page construction is not an entry-point check. */
fun Activity.openGeneratedAdd(action: MoteAddAction) {
    fun views(root: View): List<View> = buildList { add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) } }
    if (views(window.decorView).filterIsInstance<TextView>().none { it.isShown && it.isClickable && it.text.toString() == MoteI18n.text("添加") }) {
        views(window.decorView).single { it.isShown && it.tag == "primary:TODAY" }.performClick()
    }
    views(window.decorView).filterIsInstance<TextView>().single { it.isShown && it.isClickable && it.text.toString() == MoteI18n.text("添加") }.performClick()
    val list = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views)
        .filterIsInstance<android.widget.ListView>().single { it.isShown && it.adapter != null }
    val index = (0 until list.adapter.count).single { list.adapter.getItem(it).toString() == MoteI18n.text(action.titleKey) }
    val row = list.getChildAt(index - list.firstVisiblePosition) ?: list.adapter.getView(index, null, list)
    assertTrue("Native Add list must activate the chosen action", list.performItemClick(row, index, list.adapter.getItemId(index)))
}
