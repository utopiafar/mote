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
            val titled = rows.any { it.isShown && (it.tag == "local-page-title" || it.tag == "central-title" || it.tag == "home-m-action") }
            val library = activity.intent.getStringExtra("page") == "LIBRARY" && rows.any { it.isShown && it.tag == "library-primary-views" }
            ready = rows.any { it is MotePrimaryNavigation } && (titled || library)
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

/** Reach the visible secondary menu; never recreate the window to navigate a draft. */
fun Activity.openGeneratedMenu() {
    fun views(root: View): List<View> = buildList { add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) } }
    repeat(8) {
        val rows = views(window.decorView)
        if (rows.any { it.isShown && it.tag == "menu:" + MoteI18n.text("资料与记忆") }) return
        rows.firstOrNull { it.isShown && it.tag == "home-m-action" }?.let { it.performClick(); return }
        rows.firstOrNull { it.isShown && (it.tag?.toString()?.startsWith("local-back:") == true || (it is TextView && it.text.toString() == "‹")) }?.performClick()
    }
    error("Secondary menu unavailable")
}

/** The home record action and the source menu retain their real native task entrypoints. */
fun Activity.openGeneratedAdd(action: MoteAddAction) {
    fun views(root: View): List<View> = buildList { add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) } }
    if (action == MoteAddAction.NOTE) {
        openGeneratedHome()
        views(window.decorView).single { it.isShown && it.tag == "home-record-action" }.performClick()
        return
    }
    if (action == MoteAddAction.SCREEN) {
        openGeneratedMenu()
        views(window.decorView).single { it.isShown && it.tag == "menu:" + MoteI18n.text("设置") }.performClick()
        views(window.decorView).single { it.isShown && it.tag == "menu:" + MoteI18n.text("采集范围") }.performClick()
        return
    }
    openGeneratedMenu()
    views(window.decorView).single { it.isShown && it.tag == "menu:" + MoteI18n.text("采集与同步") }.performClick()
    val deadline = SystemClock.elapsedRealtime() + 10_000
    val handler = android.os.Handler(android.os.Looper.getMainLooper())
    val choose = object : Runnable {
        override fun run() {
            val source = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).filterIsInstance<SourcesActivity>().singleOrNull()
            if (source == null) { check(SystemClock.elapsedRealtime() < deadline) { "Actual source list did not open" }; handler.postDelayed(this,40); return }
            val row = views(source.window.decorView).firstOrNull { it.tag == "sources-add" }
            if (row == null) { check(SystemClock.elapsedRealtime() < deadline) { "Actual source list did not render" }; handler.postDelayed(this,40); return }
            row.performClick()
            val key = when (action) { MoteAddAction.FILE -> "FILE"; MoteAddAction.FOLDER -> "FOLDER"; MoteAddAction.FEISHU -> "CLOUD"; else -> error("Unexpected action") }
            val sheetDeadline = SystemClock.elapsedRealtime() + 5_000
            val pick = object : Runnable {
                override fun run() {
                    val row = android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::views).singleOrNull { it.isShown && it.tag == "add-source:$key" }
                    if (row == null) { check(SystemClock.elapsedRealtime() < sheetDeadline) { "Actual add-source sheet did not open" }; handler.postDelayed(this, 40); return }
                    row.performClick()
                }
            }
            handler.post(pick)
        }
    }
    handler.post(choose)
}

/** Home is the default light entry; each secondary page has an ordinary back path. */
fun Activity.openGeneratedHome() {
    fun views(root: View): List<View> = buildList { add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(views(root.getChildAt(it))) } }
    repeat(8) {
        val rows = views(window.decorView)
        if (rows.any { it.isShown && it.tag == "home-record-action" }) return
        rows.firstOrNull { it.isShown && (it.tag?.toString()?.startsWith("local-back:") == true || (it is TextView && it.text.toString() == "‹")) }?.performClick()
    }
    error("Home return unavailable")
}

private fun generatedViews(root: View): List<View> = buildList {
    add(root); if (root is ViewGroup) repeat(root.childCount) { addAll(generatedViews(root.getChildAt(it))) }
}

private fun ActivityScenario<*>.awaitGeneratedTag(tag: String) {
    val end = SystemClock.elapsedRealtime() + 10_000
    var found = false
    while (!found && SystemClock.elapsedRealtime() < end) {
        onActivity {
            found = android.view.inspector.WindowInspector.getGlobalWindowViews()
                .flatMap(::generatedViews).any { it.isShown && it.tag == tag }
        }
        if (!found) Thread.sleep(25)
    }
    assertTrue("Generated window control $tag must appear", found)
}

/** The location choice is folded into the library filter sheet, not a second row above search. */
fun ActivityScenario<MainActivity>.chooseLibraryLocation(value: String) {
    onActivity { activity -> generatedViews(activity.window.decorView).single { it.tag == "library-filter" }.performClick() }
    awaitGeneratedTag("library-location:$value")
    onActivity {
        android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::generatedViews)
            .single { it.isShown && it.tag == "library-location:$value" }.performClick()
    }
    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
}

fun ActivityScenario<MainActivity>.refreshLibrary() {
    onActivity { activity -> generatedViews(activity.window.decorView).single { it.tag == "library-filter" }.performClick() }
    awaitGeneratedTag("library-refresh")
    onActivity {
        android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::generatedViews)
            .single { it.isShown && it.tag == "library-refresh" }.performClick()
    }
    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
}

/** Memory management remains reachable from the filter sheet; no extra "More" pill sits in the list. */
fun ActivityScenario<CentralActivity>.manageMemories() {
    onActivity { activity -> generatedViews(activity.window.decorView).single { it.tag == "memory-filter" }.performClick() }
    awaitGeneratedTag("memory-manage")
    onActivity {
        android.view.inspector.WindowInspector.getGlobalWindowViews().flatMap(::generatedViews)
            .single { it.isShown && it.tag == "memory-manage" }.performClick()
    }
    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
}
