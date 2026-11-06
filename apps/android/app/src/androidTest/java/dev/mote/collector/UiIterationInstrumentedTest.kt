package dev.mote.collector

import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Explicit generated-only visual evidence plus real navigation through the native app. */
@RunWith(AndroidJUnit4::class)
class UiIterationInstrumentedTest {
    private fun views(root: View): List<View> = buildList {
        add(root)
        if (root is ViewGroup) for (index in 0 until root.childCount) addAll(views(root.getChildAt(index)))
    }

    @Test fun generatedFixtureRejectsRetainedMoodBeforeDrawing() {
        org.junit.Assume.assumeTrue("Explicit generated-only iteration fixture required", InstrumentationRegistry.getArguments().getString("uiIterationFixture") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("/emu64a:"))
        require(!Settings(context).enabled && Settings(context).read().token.isBlank() && context.queue().depth() == 0)
        require(QuickNotes.draft(context).read() == NoteDraft() && context.localSources().sources().isEmpty())
        val draft = QuickNotes.draft(context)
        val generated = NoteDraft(mood = "Generated retained mood")
        draft.update(generated.text, generated.mood)
        try {
            for (fixture in listOf(::generatedHomeContentAskJourney, ::generatedPlainNoteDetailKeepsItsOriginalAndUsesActionClose)) {
                assertThrows(IllegalArgumentException::class.java) { fixture() }
                assertEquals("A rejected fixture preserves the existing draft", generated, draft.read())
                assertEquals("Rejection happens before a note is saved", 0, context.queue().depth())
            }
        } finally { draft.clear() } // Only the known generated draft created above is removed.
    }

    @Test fun generatedPlainNoteDetailKeepsItsOriginalAndUsesActionClose() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        org.junit.Assume.assumeTrue("Explicit generated-only iteration fixture required", InstrumentationRegistry.getArguments().getString("uiIterationFixture") == "true")
        val context = instrumentation.targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("/emu64a:"))
        require(!Settings(context).enabled && Settings(context).read().token.isBlank() && context.queue().depth() == 0)
        require(QuickNotes.draft(context).read() == NoteDraft() && context.localSources().sources().isEmpty())
        val previous = MoteI18n.preference()
        MoteI18n.select(context, "en")
        val text = "Generated note reader regression · 原文 🐾"
        val id = QuickNotes.save(context, text, "")
        try {
            ActivityScenario.launch<CaptureRecordsActivity>(android.content.Intent(context, CaptureRecordsActivity::class.java)
                .putExtra("recordId", id).putExtra("recordSource", "note").putExtra("recordDate", java.time.LocalDate.now().toString())).use { scenario ->
                val deadline = SystemClock.elapsedRealtime() + 10000
                var ready = false
                fun dialogRoot() = android.view.inspector.WindowInspector.getGlobalWindowViews().lastOrNull { it.findViewById<View>(android.R.id.button1)?.isShown == true }
                while (!ready && SystemClock.elapsedRealtime() < deadline) {
                    scenario.onActivity { activity -> ready = GeneratedWindowRendering.hasNoPendingLabels(activity.window.decorView) && dialogRoot()?.let { root -> views(root).filterIsInstance<TextView>().any { it.text.toString() == text } } == true }
                    if (!ready) Thread.sleep(25)
                }
                assertTrue("The native reader loads the original saved note", ready)
                scenario.onActivity { activity ->
                    val root = requireNotNull(dialogRoot())
                    val labels = views(root).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
                    val parentLabels = views(activity.window.decorView).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
                    assertTrue(parentLabels.contains("Quick notes"))
                    assertTrue(parentLabels.contains(MoteI18n.text("查看记录说明")))
                    assertFalse(parentLabels.contains(MoteI18n.text("截图支持按连续 Session 或 App 分组，点开查看图片。")))
                    assertFalse("A note list has no unsupported thumbnail control", parentLabels.contains("Thumbnail view"))
                    assertTrue(labels.contains("Close details")); assertFalse(labels.contains("Off"))
                    assertFalse(labels.contains("Media collection not enabled"))
                    val round = InstrumentationRegistry.getArguments().getString("uiIterationRound", "5").also { require(it.matches(Regex("baseline|rollout|[1-9][0-9]*"))) }
                    val variant = InstrumentationRegistry.getArguments().getString("uiIterationVariant", "default").also { require(it.matches(Regex("default|compact|english|compact-english"))) }
                    val directory = File(context.filesDir, "ui-iterations/round-$round" + if (variant == "default") "" else "/$variant").apply { mkdirs() }
                    GeneratedWindowRendering.save(activity, directory, "note-detail-english", listOf(root))
                    File(directory, "note-detail-english.txt").writeText(labels.joinToString("\n"))
                    assertTrue(root.findViewById<View>(android.R.id.button1).performClick())
                }
                scenario.onActivity { activity ->
                    val help = views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text.toString() == MoteI18n.text("查看记录说明") }
                    help.requestRectangleOnScreen(android.graphics.Rect(0, 0, help.width, help.height), true)
                    val bounds = android.graphics.Rect()
                    assertTrue(help.getGlobalVisibleRect(bounds)); assertEquals(help.height, bounds.height())
                    assertTrue("The complete source-specific record explanation remains reachable", help.performClick())
                }
                instrumentation.waitForIdleSync()
                instrumentation.runOnMainSync {
                    val help = requireNotNull(dialogRoot())
                    val labels = views(help).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
                    assertTrue(labels.contains("Browse records by date; open one to read its original."))
                    assertFalse(labels.contains(MoteI18n.text("截图支持按连续 Session 或 App 分组，点开查看图片。")))
                    assertTrue(help.findViewById<View>(android.R.id.button1).performClick())
                }
                scenario.onActivity { assertTrue(it.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0) }
            }
        } finally {
            context.queue().acknowledge(id)
            MoteI18n.select(context, previous)
        }
    }

    @Test fun generatedHomeContentAskJourney() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        org.junit.Assume.assumeTrue("Explicit generated-only iteration fixture required", args.getString("uiIterationFixture") == "true")
        val context = instrumentation.targetContext
        require(context.packageName == "dev.mote.collector.dev" && Build.FINGERPRINT.contains("/emu64a:"))
        require(!Settings(context).enabled && Settings(context).read().token.isBlank() && context.queue().depth() == 0)
        require(QuickNotes.draft(context).read() == NoteDraft())
        require(context.localSources().sources().isEmpty())
        val round = args.getString("uiIterationRound", "baseline").also { require(it.matches(Regex("baseline|rollout|[1-9][0-9]*"))) }
        val variant = args.getString("uiIterationVariant", "default").also { require(it.matches(Regex("default|compact|english|compact-english"))) }
        val directory = File(context.filesDir, "ui-iterations/round-$round" + if (variant == "default") "" else "/$variant").apply { mkdirs() }
        val previous = MoteI18n.preference()
        MoteI18n.select(context, if (variant.contains("english")) "en" else "zh-CN")
        try {
            ActivityScenario.launch<MainActivity>(android.content.Intent(context, MainActivity::class.java).putExtra("page", "OVERVIEW")).awaitMainUi().use { scenario ->
                fun settle() {
                    val ready = java.util.concurrent.CountDownLatch(1)
                    scenario.onActivity { activity -> activity.window.decorView.postOnAnimation {
                        activity.window.decorView.postOnAnimation { ready.countDown() }
                    } }
                    assertTrue("The real layout traversal must complete", ready.await(5, java.util.concurrent.TimeUnit.SECONDS))
                    instrumentation.waitForIdleSync()
                }
                fun render(name: String) {
                    settle()
                    val deadline = SystemClock.elapsedRealtime() + 10000
                    var ready = false
                    while (!ready && SystemClock.elapsedRealtime() < deadline) {
                        scenario.onActivity { ready = GeneratedWindowRendering.hasNoPendingLabels(it.window.decorView) }
                        if (!ready) Thread.sleep(25)
                    }
                    assertTrue("The full active page must finish its reads before capture: $name", ready)
                    scenario.onActivity { activity ->
                        assertTrue("Secure window remains enabled", activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                        val root = activity.window.decorView
                        if (name in setOf("settings", "connection", "note", "content", "content-populated", "screen-scope")) {
                            val title = views(root).filterIsInstance<TextView>().single { it.isShown && it.tag == "local-page-title" }
                            val bounds = android.graphics.Rect()
                            assertTrue("The actual page title is fully visible in its app bar", title.getGlobalVisibleRect(bounds))
                            assertEquals(title.width, bounds.width()); assertEquals(title.height, bounds.height())
                            if ((activity.resources.configuration.screenWidthDp < 360 || activity.resources.configuration.fontScale > 1.2f) && name in setOf("connection", "note", "screen-scope"))
                                assertEquals("Compact titles use their complete heading row, without Add/Settings squeezing their words", 1, title.lineCount)
                            assertFalse("A local page no longer repeats the brand and return label above its title",
                                views(root).filterIsInstance<TextView>().any { it.isShown && it.text.toString() in setOf("Mote", "‹  " + MoteI18n.text("返回上级")) })
                        }
                        GeneratedWindowRendering.save(activity, directory, name)
                        if (args.getString("uiScrollEvidence") == "true") {
                            val evidenceDirectory = File(context.filesDir, "ui-scroll-evidence/$variant/$name")
                            val coverage = org.json.JSONObject(File(evidenceDirectory, "coverage.json").readText()).getJSONArray("scrollViews")
                            for (index in 0 until coverage.length()) {
                                val scroll = coverage.getJSONObject(index)
                                if (scroll.getInt("originalScrollY") > 0 && scroll.getInt("maximumScrollY") > 0) {
                                    val frames = scroll.getJSONArray("frames")
                                    val upper = (0 until frames.length()).map { frames.getJSONObject(it) }.singleOrNull { it.getInt("scrollY") == 0 }
                                    assertNotNull("A focused lower control must retain this same page's complete upper prefix: $name", upper)
                                    val frameDirectory = File(evidenceDirectory, requireNotNull(upper).getString("directory"))
                                    assertTrue("The same-instance upper prefix has actual image evidence", File(frameDirectory, "$name.png").isFile)
                                    val proof = org.json.JSONObject(File(frameDirectory, "$name.json").readText())
                                    assertTrue(proof.getBoolean("generatedOnly")); assertTrue(proof.getBoolean("secureWindow"))
                                    assertEquals(0, proof.getJSONObject("scrollEvidence").getInt("scrollY"))
                                }
                            }
                        }
                        File(directory, "$name.txt").writeText(views(root).filterIsInstance<TextView>().filter { it.isShown }.joinToString("\n") { it.text.toString() })
                    }
                }
                fun tab(identity: String) {
                    scenario.onActivity { activity -> views(activity.window.decorView).single { it.isShown && it.tag == "primary:$identity" }.performClick() }
                }
                fun scrollTo(label: String) {
                    scenario.onActivity { activity ->
                        val target = views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text.toString() == MoteI18n.text(label) }
                        target.requestRectangleOnScreen(android.graphics.Rect(0, 0, target.width, target.height), true)
                    }
                    settle()
                }
                fun awaitVisible(label: String) {
                    val deadline = SystemClock.elapsedRealtime() + 10000
                    var ready = false
                    while (!ready && SystemClock.elapsedRealtime() < deadline) {
                        scenario.onActivity { activity -> ready = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == MoteI18n.text(label) } }
                        if (!ready) Thread.sleep(25)
                    }
                    assertTrue("A scene is captured only after its actual content has loaded: $label", ready)
                }
                awaitVisible("还没有内容。选一个动作，留下第一份资料。")
                render("home")
                scenario.onActivity { activity ->
                    assertEquals(4, views(activity.window.decorView).count { it.tag?.toString()?.startsWith("add:") == true })
                    for (item in views(activity.window.decorView).filter { it.tag?.toString()?.startsWith("add:") == true }) {
                        val visible = android.graphics.Rect()
                        assertTrue("Every peer save action is available in the first Home view", item.getGlobalVisibleRect(visible))
                        assertEquals("The four peer action labels and explanations fit the first view", item.height, visible.height())
                    }
                    assertEquals(3, views(activity.window.decorView).count { it.tag?.toString()?.startsWith("primary:") == true })
                    assertFalse(Settings(activity).enabled)
                }
                scrollTo("开始采集")
                render("home-collection")
                scenario.onActivity { activity ->
                    val control = views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text.toString() == MoteI18n.text("开始采集") }
                    val visible = android.graphics.Rect()
                    assertTrue(control.getGlobalVisibleRect(visible)); assertEquals(control.height, visible.height())
                    assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == MoteI18n.text("屏幕与应用活动") })
                }
                scenario.onActivity { activity ->
                    views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text.toString() == MoteI18n.text("查看同步详情") }.performClick()
                }
                scrollTo("立即同步")
                render("home-sync-details")
                scenario.onActivity { activity ->
                    val shown = views(activity.window.decorView).filterIsInstance<TextView>().filter { it.isShown }
                    val labels = shown.map { it.text.toString() }
                    assertEquals("Home's immediate synchronization task uses the execution action role", android.graphics.Color.WHITE,
                        shown.single { it.text.toString() == MoteI18n.text("立即同步") }.currentTextColor)
                    assertEquals("Home's connection settings remains a navigation action", MoteUi.accent,
                        shown.single { it.text.toString() == MoteI18n.text("连接设置") }.currentTextColor)
                    assertTrue("Receipt and processing has its own explicit role", labels.contains(MoteI18n.text("接收与整理状态")))
                    assertTrue("The exact receipt versus processing distinction remains visible", labels.contains(MoteI18n.text("本机保存、中央接收与整理完成分别显示；接收确认不代表已经可以搜索。")))
                    assertTrue("Processing remains explicitly unknown in this generated offline fixture", labels.any { it.contains(MoteI18n.text("中央处理状态待查询，请在中央任务中心查看")) })
                    assertTrue("Upload speed metadata is still available", labels.any { it.startsWith(MoteI18n.text("上传速率") + " · ") })
                    views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text.toString() == MoteI18n.text("查看同步详情") }.performClick()
                    activity.showMoteAddActions()
                }
                settle()
                scenario.onActivity { activity ->
                    val dialog = android.view.inspector.WindowInspector.getGlobalWindowViews().single { it.findViewById<View>(android.R.id.button2)?.isShown == true }
                    val labels = views(dialog).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
                    for (action in MoteAddAction.entries) assertTrue(labels.contains(MoteI18n.text(action.titleKey)))
                    GeneratedWindowRendering.save(activity, directory, "add", listOf(dialog))
                    File(directory, "add.txt").writeText(labels.joinToString("\n"))
                    assertTrue(dialog.findViewById<View>(android.R.id.button2).performClick())
                    views(activity.window.decorView).single { it.isShown && it.isClickable && it.contentDescription == MoteI18n.text("设置") }.performClick()
                }
                render("settings")
                scenario.onActivity { activity ->
                    assertFalse("Settings keeps record addition out of its task", views(activity.window.decorView).any { it.isShown && it.contentDescription == MoteI18n.text("添加内容") })
                    val labels = views(activity.window.decorView).filterIsInstance<TextView>().filter { it.isShown }.map { it.text.toString() }
                    assertFalse("Operational capture belongs to Home", labels.contains(MoteI18n.text("开始采集")))
                    assertFalse("Operational sync belongs to Home", labels.contains(MoteI18n.text("立即同步")))
                    assertFalse("Record statistics belong to Home", labels.contains(MoteI18n.text("此刻的 Mote")))
                }
                val settingsIconEvidence = org.json.JSONArray()
                val settingsIconHashes = mutableListOf<String>()
                for (label in listOf(if (MoteI18n.language() == "en") "Language" else "界面语言", MoteI18n.text("插件"), MoteI18n.text("权限与后台运行"))) {
                    scenario.onActivity { activity ->
                        val row = views(activity.window.decorView).single { it.isShown && it.tag == "menu:$label" }
                        row.requestRectangleOnScreen(android.graphics.Rect(0, 0, row.width, row.height), true)
                    }
                    settle()
                    scenario.onActivity { activity ->
                        val row = views(activity.window.decorView).single { it.isShown && it.tag == "menu:$label" }
                        val icon = views(row).filterIsInstance<android.widget.ImageView>().single { it.isShown }
                        val visible = android.graphics.Rect()
                        assertTrue("The actual settings icon must be fully visible: $label", icon.getGlobalVisibleRect(visible))
                        assertEquals(icon.width, visible.width()); assertEquals(icon.height, visible.height())
                        val bitmap = android.graphics.Bitmap.createBitmap(icon.width, icon.height, android.graphics.Bitmap.Config.ARGB_8888)
                        try {
                            icon.draw(android.graphics.Canvas(bitmap))
                            val pixels = IntArray(icon.width * icon.height)
                            bitmap.getPixels(pixels, 0, icon.width, 0, 0, icon.width, icon.height)
                            assertTrue("The actual icon draw contains visible ink: $label", pixels.any { android.graphics.Color.alpha(it) > 0 })
                            val rgba = ByteArray(pixels.size * 4)
                            pixels.forEachIndexed { index, pixel ->
                                rgba[index * 4] = android.graphics.Color.red(pixel).toByte(); rgba[index * 4 + 1] = android.graphics.Color.green(pixel).toByte()
                                rgba[index * 4 + 2] = android.graphics.Color.blue(pixel).toByte(); rgba[index * 4 + 3] = android.graphics.Color.alpha(pixel).toByte()
                            }
                            val hash = java.security.MessageDigest.getInstance("SHA-256").digest(rgba).joinToString("") { "%02x".format(it.toInt() and 255) }
                            settingsIconHashes += hash
                            settingsIconEvidence.put(org.json.JSONObject().put("menuTag", row.tag).put("label", label).put("rgbaSha256", hash)
                                .put("width", icon.width).put("height", icon.height).put("visibleRect", visible.toShortString()).put("drawSource", "actual ImageView.draw raw RGBA"))
                        } finally { bitmap.recycle() }
                    }
                }
                File(directory, "settings-icon-geometry.json").writeText(org.json.JSONObject().put("language", MoteI18n.language())
                    .put("icons", settingsIconEvidence).put("distinctDrawings", settingsIconHashes.distinct().size).toString(2))
                assertEquals("Language, plugins and permissions must have distinct actual rendered icons", 3, settingsIconHashes.distinct().size)
                scenario.onActivity { activity -> views(activity.window.decorView).single { it.isShown && it.tag == "menu:${MoteI18n.text("连接与同步")}" }.performClick() }
                render("connection")
                scenario.onActivity { activity ->
                    val shown = views(activity.window.decorView).filterIsInstance<TextView>().filter { it.isShown }
                    assertFalse("Connection settings keeps record addition out of its task", shown.any { it.contentDescription == MoteI18n.text("添加内容") })
                    val retry = shown.single { it.text.toString() == MoteI18n.text("立即重试同步") }
                    assertEquals("The immediate synchronization task uses the execution action role", android.graphics.Color.WHITE, retry.currentTextColor)
                    for (label in listOf("验证已保存的采集连接", "保存并打开中央界面")) {
                        val secondary = shown.single { it.text.toString() == MoteI18n.text(label) }
                        assertEquals("Diagnostics and central navigation retain their secondary role", MoteUi.accent, secondary.currentTextColor)
                    }
                }
                tab("LIBRARY"); awaitVisible("这里还没有内容。点击添加，选择文件、屏幕或记录。"); render("content")
                scenario.onActivity { activity -> assertTrue("Content still offers the shared record action", views(activity.window.decorView).any { it.isShown && it.contentDescription == MoteI18n.text("添加内容") }) }
                tab("ASK")
                val deadline = SystemClock.elapsedRealtime() + 10000
                var loaded = false
                while (!loaded && SystemClock.elapsedRealtime() < deadline) {
                    scenario.onActivity { activity -> loaded = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == MoteI18n.text("中央问答暂不可用。连接中央后，可以根据已整理的内容提问；文件和记录仍可在本机保存。") } }
                    if (!loaded) Thread.sleep(25)
                }
                assertTrue("Ask uses the real embedded native central page", loaded)
                render("ask")
                scenario.onActivity { activity ->
                    val header = views(activity.window.decorView).single { it.isShown && it.tag == "central-header" }
                    val settings = views(header).filterIsInstance<TextView>().single { it.text.toString() == MoteI18n.text("设置") }
                    assertEquals("The header action stays readable at narrow widths and large fonts", 1, settings.lineCount)
                    assertEquals("Settings keeps the quiet action role", MoteUi.muted, settings.currentTextColor)
                    val add = views(header).filterIsInstance<TextView>().single { it.contentDescription == MoteI18n.text("添加内容") }
                    assertEquals("Add uses the secondary action text color", MoteUi.accent, add.currentTextColor)
                    val status = views(activity.window.decorView).single { it.tag == "central-status" } as TextView
                    assertTrue("The actual disconnected Ask has finished its status work", status.text.isBlank())
                    assertEquals("An empty live status container does not reserve a blank strip", View.GONE, status.visibility)
                    val scope = views(activity.window.decorView).single { it.tag == "central-collection-scope" }
                    assertEquals("No empty scope container reserves space in actual Ask", View.GONE, scope.visibility)
                }
                tab("TODAY")
                scenario.onActivity { activity -> activity.openGeneratedAdd(MoteAddAction.NOTE) }
                awaitVisible("草稿已载入")
                render("note")
                val keyboardJourney = args.getString("uiIterationKeyboard") == "true"
                if (variant in setOf("compact", "compact-english")) assertTrue("Both compact conditions must exercise the real keyboard save journey", keyboardJourney)
                val fixtureText = if (variant.contains("english")) "Generated context fixture\nThe review kept the original notes with the decision, so the reason can be recovered later." else "生成资料验证\n这次评审把原始记录和决定放在一起，方便以后回看当时的依据。"
                val keyEventPrefix = "GeneratedIME_${if (round == "rollout") "Rollout" else "R5"}_${variant.replace('-', '_')}_"
                val generatedText = if (keyboardJourney) "$keyEventPrefix\n$fixtureText" else fixtureText
                if (keyboardJourney) {
                    val deadline = SystemClock.elapsedRealtime() + 10000
                    var ready = false
                    while (!ready && SystemClock.elapsedRealtime() < deadline) {
                        scenario.onActivity { activity -> ready = views(activity.window.decorView).filterIsInstance<android.widget.EditText>().any { it.isShown && it.isEnabled } }
                        if (!ready) Thread.sleep(25)
                    }
                    assertTrue("The real note draft must load before keyboard input", ready)
                    scenario.onActivity { activity ->
                        val field = views(activity.window.decorView).filterIsInstance<android.widget.EditText>().single { it.isShown }
                        assertTrue(field.requestFocus())
                        activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).showSoftInput(field, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
                    }
                    var shown = false
                    while (!shown && SystemClock.elapsedRealtime() < deadline) {
                        scenario.onActivity { shown = it.window.decorView.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime()) == true }
                        if (!shown) Thread.sleep(25)
                    }
                    assertTrue("Generated note keyboard must actually open", shown)
                    if (args.getString("uiImeLayoutEvidence") == "true") {
                        val samples = org.json.JSONArray()
                        val sampled = java.util.concurrent.CountDownLatch(1)
                        scenario.onActivity { activity ->
                            val root = activity.window.decorView
                            val field = views(root).filterIsInstance<android.widget.EditText>().single { it.isShown }
                            val originalValue = field.text.toString()
                            val originalStart = field.selectionStart; val originalEnd = field.selectionEnd
                            val originalFocus = activity.currentFocus
                            root.postOnAnimation(object : Runnable {
                                override fun run() {
                                    val insets = requireNotNull(root.rootWindowInsets)
                                    samples.put(org.json.JSONObject().put("callbackTimeNs", System.nanoTime())
                                        .put("imeVisible", insets.isVisible(android.view.WindowInsets.Type.ime()))
                                        .put("imeBottom", insets.getInsets(android.view.WindowInsets.Type.ime()).bottom)
                                        .put("rootWidth", root.width).put("rootHeight", root.height).put("rootLayoutRequested", root.isLayoutRequested)
                                        .put("focusPreserved", activity.currentFocus === originalFocus).put("fieldFocused", field.hasFocus())
                                        .put("originalValue", originalValue).put("actualValue", field.text.toString())
                                        .put("originalSelectionStart", originalStart).put("originalSelectionEnd", originalEnd)
                                        .put("selectionStart", field.selectionStart).put("selectionEnd", field.selectionEnd)
                                        .put("scrollViews", org.json.JSONArray(views(root).filterIsInstance<android.widget.ScrollView>().filter { it.isShown }.map { scroll ->
                                            org.json.JSONObject().put("width", scroll.width).put("height", scroll.height)
                                                .put("scrollX", scroll.scrollX).put("scrollY", scroll.scrollY).put("layoutRequested", scroll.isLayoutRequested)
                                                .put("childWidth", scroll.getChildAt(0)?.width).put("childHeight", scroll.getChildAt(0)?.height)
                                                .put("childLayoutRequested", scroll.getChildAt(0)?.isLayoutRequested)
                                        })))
                                    if (samples.length() < 20) root.postOnAnimation(this) else sampled.countDown()
                                }
                            })
                        }
                        assertTrue("Owned View IME diagnostics observe asynchronous real UI frames", sampled.await(5, java.util.concurrent.TimeUnit.SECONDS))
                        File(directory, "note-ime-initial-layout-frames.json").writeText(org.json.JSONObject()
                            .put("generatedOnly", true).put("diagnosticOnly", true).put("automaticVisualAcceptance", false)
                            .put("sampling", "Twenty actual postOnAnimation callbacks; no screenshot, text, focus or selection mutation")
                            .put("frames", samples).toString(2))
                    }
                    render("note-keyboard")
                    scenario.onActivity { activity ->
                        val root = activity.window.decorView
                        val availableBottom = root.height - root.rootWindowInsets.getInsets(android.view.WindowInsets.Type.ime()).bottom
                        for (item in views(root).filter { it.tag?.toString()?.startsWith("primary:") == true }) {
                            val bounds = android.graphics.Rect(); assertTrue(item.getGlobalVisibleRect(bounds))
                            assertTrue("Navigation stays above the keyboard", bounds.height() == item.height && bounds.bottom <= availableBottom + 2)
                        }
                        // Fixture setup precedes the input session used for the real key sequence.
                        // setText while the IME is active restarts its connection asynchronously.
                        activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(root.windowToken, 0)
                        activity.currentFocus?.clearFocus()
                    }
                    var hidden = false
                    val sessionDeadline = SystemClock.elapsedRealtime() + 10000
                    while (!hidden && SystemClock.elapsedRealtime() < sessionDeadline) {
                        scenario.onActivity { hidden = !it.window.decorView.rootWindowInsets.isVisible(android.view.WindowInsets.Type.ime()) }
                        if (!hidden) Thread.sleep(25)
                    }
                    assertTrue("The fixture closes the previous input session before replacing editor content", hidden)
                    scenario.onActivity { activity ->
                        val field = views(activity.window.decorView).filterIsInstance<android.widget.EditText>().single { it.isShown }
                        assertFalse("The Unicode fixture is prepared before restoring editor focus", field.hasFocus())
                        field.setText("\n$fixtureText"); field.setSelection(0)
                    }
                    settle()
                    scenario.onActivity { activity ->
                        val field = views(activity.window.decorView).filterIsInstance<android.widget.EditText>().single { it.isShown }
                        assertTrue(field.requestFocus())
                        activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).showSoftInput(field, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
                    }
                    var sessionReady = false
                    while (!sessionReady && SystemClock.elapsedRealtime() < sessionDeadline) {
                        scenario.onActivity { activity ->
                            val field = views(activity.window.decorView).filterIsInstance<android.widget.EditText>().single { it.isShown }
                            sessionReady = activity.hasWindowFocus() && field.hasFocus() &&
                                activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).isActive(field) &&
                                activity.window.decorView.rootWindowInsets.isVisible(android.view.WindowInsets.Type.ime())
                        }
                        if (!sessionReady) Thread.sleep(25)
                    }
                    assertTrue("Actual window focus, active editor input connection and visible IME must be ready before key events", sessionReady)
                    settle()
                    instrumentation.sendStringSync(keyEventPrefix)
                    instrumentation.waitForIdleSync()
                    scenario.onActivity { activity ->
                        val field = views(activity.window.decorView).filterIsInstance<android.widget.EditText>().single { it.isShown }
                        assertEquals("Real generated key events must reach the focused note editor without replacing its Unicode fixture", generatedText, field.text.toString())
                        assertTrue("The editor remains focused while the actual IME is shown", field.hasFocus())
                        assertTrue(activity.window.decorView.rootWindowInsets.isVisible(android.view.WindowInsets.Type.ime()))
                    }
                    scrollTo("保存记录")
                    var touchX = 0f; var touchY = 0f
                    scenario.onActivity { activity ->
                        fun screenRect(view: View): android.graphics.Rect {
                            val position = IntArray(2); view.getLocationOnScreen(position)
                            return android.graphics.Rect(position[0], position[1], position[0] + view.width, position[1] + view.height)
                        }
                        fun rectJson(rect: android.graphics.Rect) = org.json.JSONObject().put("left", rect.left).put("top", rect.top)
                            .put("right", rect.right).put("bottom", rect.bottom).put("width", rect.width()).put("height", rect.height())
                        val root = activity.window.decorView
                        val insets = requireNotNull(root.rootWindowInsets)
                        val rootBounds = screenRect(root)
                        val imeBottom = insets.getInsets(android.view.WindowInsets.Type.ime()).bottom
                        val imeTop = rootBounds.bottom - imeBottom
                        val save = views(root).filterIsInstance<TextView>().single { it.isShown && it.text.toString() == MoteI18n.text("保存记录") }
                        val saveVisible = android.graphics.Rect(); val saveHasRect = save.getGlobalVisibleRect(saveVisible)
                        val saveBounds = screenRect(save)
                        val navigation = views(root).filterIsInstance<MotePrimaryNavigation>().single { it.isShown }
                        val navVisible = android.graphics.Rect(); val navHasRect = navigation.getGlobalVisibleRect(navVisible)
                        val navBounds = screenRect(navigation)
                        val geometry = org.json.JSONObject().put("generatedOnly", true).put("variant", variant).put("language", MoteI18n.language())
                            .put("asciiInputMode", "Instrumentation.sendStringSync key events with actual IME visible").put("asciiInput", keyEventPrefix)
                            .put("fixtureInputMode", "EditText.setText for the original Unicode fixture body, with selection at zero before ASCII events")
                            .put("inputSessionOrdering", "Fixture text set while IME hidden and editor unfocused; new focused active input session and real IME awaited before key events")
                            .put("fixtureBody", fixtureText).put("expectedSavedOriginal", generatedText).put("clickMode", "Instrumentation.sendPointerSync ACTION_DOWN/ACTION_UP")
                            .put("systemKeyboardPixelsCaptured", false).put("imeVisibleBeforeTouch", insets.isVisible(android.view.WindowInsets.Type.ime()))
                            .put("imeBottom", imeBottom).put("imeTopScreen", imeTop).put("rootBoundsScreen", rectJson(rootBounds))
                            .put("saveBoundsScreen", rectJson(saveBounds)).put("saveGlobalVisibleRect", rectJson(saveVisible)).put("saveHasVisibleRect", saveHasRect)
                            .put("navigationBoundsScreen", rectJson(navBounds)).put("navigationGlobalVisibleRect", rectJson(navVisible)).put("navigationHasVisibleRect", navHasRect)
                        File(directory, "note-ime-save-geometry.json").writeText(geometry.toString(2))
                        assertTrue("The actual IME stays visible until the real Save touch", insets.isVisible(android.view.WindowInsets.Type.ime()))
                        assertTrue("Save must be fully visible before its actual touch", saveHasRect)
                        assertEquals(save.width, saveVisible.width()); assertEquals(save.height, saveVisible.height())
                        assertTrue("Navigation must also remain fully visible", navHasRect)
                        assertEquals(navigation.width, navVisible.width()); assertEquals(navigation.height, navVisible.height())
                        assertTrue("Navigation remains above the actual IME", navBounds.bottom <= imeTop + 2)
                        assertTrue("Save remains above the actual IME", saveBounds.bottom <= imeTop + 2)
                        assertTrue("Save remains above the primary navigation", saveBounds.bottom <= navBounds.top + 2)
                        assertTrue(save.isEnabled && save.isClickable)
                        if (args.getString("uiScrollEvidence") == "true") {
                            GeneratedWindowRendering.save(activity, directory, "note-keyboard-save-visible", includeScrollEvidence = false)
                            File(directory, "note-keyboard-save-visible.txt").writeText(views(root).filterIsInstance<TextView>().filter { it.isShown }.joinToString("\n") { it.text.toString() })
                            assertEquals("Pre-touch evidence preserves the exact original typed note", generatedText,
                                views(root).filterIsInstance<android.widget.EditText>().single { it.isShown }.text.toString())
                            assertTrue("Evidence preserves the actual IME input session", root.rootWindowInsets.isVisible(android.view.WindowInsets.Type.ime()))
                        }
                        touchX = saveBounds.exactCenterX(); touchY = saveBounds.exactCenterY()
                    }
                    val down = SystemClock.uptimeMillis()
                    android.view.MotionEvent.obtain(down, down, android.view.MotionEvent.ACTION_DOWN, touchX, touchY, 0).let {
                        try { instrumentation.sendPointerSync(it) } finally { it.recycle() }
                    }
                    android.view.MotionEvent.obtain(down, down + 30, android.view.MotionEvent.ACTION_UP, touchX, touchY, 0).let {
                        try { instrumentation.sendPointerSync(it) } finally { it.recycle() }
                    }
                    instrumentation.waitForIdleSync()
                } else {
                    scenario.onActivity { activity ->
                        views(activity.window.decorView).filterIsInstance<android.widget.EditText>().single { it.isShown }.setText(generatedText)
                        views(activity.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text.toString() == MoteI18n.text("保存记录") }.performClick()
                    }
                }
                val savedDeadline = SystemClock.elapsedRealtime() + 10000
                var saved = false
                while (!saved && SystemClock.elapsedRealtime() < savedDeadline) {
                    scenario.onActivity { activity -> saved = views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.toString() == MoteI18n.text("记录已保存；同步按你的设置运行") } }
                    if (!saved) Thread.sleep(25)
                }
                assertTrue("Save uses the real note action and clears only the committed draft", saved)
                if (keyboardJourney) {
                    scenario.onActivity { activity ->
                        val root = activity.window.decorView
                        val geometryFile = File(directory, "note-ime-save-geometry.json")
                        val geometry = org.json.JSONObject(geometryFile.readText()).put("savedThroughActualTouch", true)
                            .put("imeVisibleAfterSuccessfulSave", root.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime()) == true)
                        geometryFile.writeText(geometry.toString(2))
                        activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(root.windowToken, 0)
                        activity.currentFocus?.clearFocus()
                    }
                    settle()
                }
                scenario.onActivity { activity -> views(activity.window.decorView).single { it.isShown && it.contentDescription == MoteI18n.text("返回{0}", MoteI18n.text("内容")) }.performClick() }
                var populated = false
                while (!populated && SystemClock.elapsedRealtime() < savedDeadline) {
                    scenario.onActivity { activity -> populated = views(activity.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == generatedText } }
                    if (!populated) Thread.sleep(25)
                }
                assertTrue("Content displays the actual generated saved original preview", populated)
                render("content-populated")
                val savedRecords = context.queue().capturePage("1970-01-01T00:00:00Z", java.time.Instant.now().plusSeconds(1).toString(), source = "note").getJSONArray("items")
                assertEquals(1, savedRecords.length())
                val savedId = savedRecords.getJSONObject(0).getString("id")
                tab("TODAY")
                populated = false
                val homeDeadline = SystemClock.elapsedRealtime() + 10000
                while (!populated && SystemClock.elapsedRealtime() < homeDeadline) {
                    scenario.onActivity { activity ->
                        val recent = views(activity.window.decorView).single { it.isShown && it.tag == "home-recent-content" }
                        val record = views(recent).singleOrNull { it.isShown && it.tag == "library-record:$savedId" }
                        populated = record != null && views(record).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == generatedText }
                    }
                    if (!populated) Thread.sleep(25)
                }
                assertTrue("The Home archive uses the same actual saved record", populated)
                settle() // The row was just appended by the real asynchronous Home query.
                scenario.onActivity { activity ->
                    val recent = views(activity.window.decorView).single { it.isShown && it.tag == "home-recent-content" }
                    val record = views(recent).single { it.isShown && it.tag == "library-record:$savedId" }
                    var ancestor = recent.parent
                    while (ancestor !is android.widget.ScrollView) ancestor = ancestor.parent
                    val scroll = ancestor
                    val bounds = android.graphics.Rect(); record.getDrawingRect(bounds)
                    scroll.offsetDescendantRectToMyCoords(record, bounds)
                    scroll.scrollTo(0, (bounds.top - activity.moteDp(48)).coerceAtLeast(0))
                }
                settle()
                val monitor = instrumentation.addMonitor(CaptureRecordsActivity::class.java.name, null, false)
                try {
                    val visibleDeadline = SystemClock.elapsedRealtime() + 10000
                    var opened = false
                    while (!opened && SystemClock.elapsedRealtime() < visibleDeadline) {
                        scenario.onActivity { activity ->
                            val recent = views(activity.window.decorView).single { it.isShown && it.tag == "home-recent-content" }
                            val record = views(recent).single { it.isShown && it.tag == "library-record:$savedId" }
                            val visible = android.graphics.Rect()
                            val diagnostic = mutableListOf<String>()
                            var ancestor: View? = record
                            while (ancestor != null) {
                                val rect = android.graphics.Rect(); val shown = ancestor.getGlobalVisibleRect(rect)
                                diagnostic += "${ancestor.javaClass.simpleName} ${ancestor.tag} bounds=${ancestor.left},${ancestor.top},${ancestor.width},${ancestor.height} scroll=${ancestor.scrollX},${ancestor.scrollY} visible=$shown/$rect"
                                ancestor = ancestor.parent as? View
                            }
                            File(directory, "home-scroll-geometry.txt").writeText(diagnostic.joinToString("\n"))
                            if (record.height > 0) record.requestRectangleOnScreen(android.graphics.Rect(0, 0, record.width, record.height), true)
                            if (record.height > 0 && record.getGlobalVisibleRect(visible) && record.height == visible.height()) {
                                assertTrue(views(record).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == generatedText })
                                File(directory, "home-visible-record.txt").writeText("id=$savedId\nrect=$visible\nheight=${record.height}\n$generatedText")
                                val root = activity.window.decorView
                                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                                GeneratedWindowRendering.save(activity, directory, "home-populated")
                                File(directory, "home-populated.txt").writeText(views(root).filterIsInstance<TextView>().filter { it.isShown }.joinToString("\n") { it.text.toString() })
                                opened = record.performClick()
                            }
                        }
                        if (!opened) Thread.sleep(25)
                    }
                    assertTrue("Only the actual fully visible Home saved note opens the reader", opened)
                    val reader = requireNotNull(instrumentation.waitForMonitorWithTimeout(monitor, 10000))
                    fun detailRoot() = android.view.inspector.WindowInspector.getGlobalWindowViews().lastOrNull { it.findViewById<View>(android.R.id.button1)?.isShown == true }
                    val deadline = SystemClock.elapsedRealtime() + 10000
                    var original = false
                    while (!original && SystemClock.elapsedRealtime() < deadline) {
                        instrumentation.runOnMainSync { original = GeneratedWindowRendering.hasNoPendingLabels(reader.window.decorView) && detailRoot()?.let { root -> views(root).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == generatedText } } == true }
                        if (!original) Thread.sleep(25)
                    }
                    assertTrue("Opening the actual Home note preserves the exact saved original", original)
                    instrumentation.runOnMainSync {
                        assertEquals(savedId, reader.intent.getStringExtra("recordId"))
                        assertTrue(reader.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                        val root = requireNotNull(detailRoot())
                        GeneratedWindowRendering.save(reader, directory, "home-note-original", listOf(root))
                        File(directory, "home-note-original.txt").writeText(views(root).filterIsInstance<TextView>().filter { it.isShown }.joinToString("\n") { it.text.toString() })
                        assertTrue(root.findViewById<View>(android.R.id.button1).performClick())
                    }
                    val closedDeadline = SystemClock.elapsedRealtime() + 10000
                    var closedToList = false
                    while (!closedToList && SystemClock.elapsedRealtime() < closedDeadline) {
                        instrumentation.runOnMainSync {
                            closedToList = detailRoot() == null && GeneratedWindowRendering.hasNoPendingLabels(reader.window.decorView) &&
                                views(reader.window.decorView).any { it.isShown && it.tag == "capture:$savedId" }
                        }
                        if (!closedToList) Thread.sleep(25)
                    }
                    assertTrue("Close dismisses the reader into the actual matching records page", closedToList)
                    instrumentation.runOnMainSync {
                        val rows = views(reader.window.decorView)
                        val date = rows.filterIsInstance<TextView>().single { it.isShown && it.text.toString() == java.time.LocalDate.now().toString() }
                        assertEquals("The selected ISO date stays on one line at the real font scale", 1, requireNotNull(date.layout).lineCount)
                        for (key in listOf("前一天", "后一天")) {
                            val action = rows.filterIsInstance<TextView>().single { it.isShown && it.text.toString() == MoteI18n.text(key) }
                            val label = action.text.toString(); val layout = requireNotNull(action.layout)
                            for (line in 1 until layout.lineCount) {
                                val split = layout.getLineStart(line)
                                assertFalse("Date navigation must never split a translated word: $label", split > 0 && split < label.length && label[split - 1].isLetter() && label[split].isLetter())
                            }
                        }
                        val kind = rows.filterIsInstance<android.widget.Spinner>().single { it.adapter.count == 7 }
                        kind.setSelection(0) // The real source selector moves to screenshots.
                    }
                    instrumentation.waitForIdleSync()
                    instrumentation.runOnMainSync {
                        val rows = views(reader.window.decorView)
                        val grouping = rows.filterIsInstance<android.widget.Spinner>().single { it.adapter.count == 2 && it.getItemAtPosition(0).toString() == MoteI18n.text("按 Session · 连续记录") }
                        val thumbnails = rows.filterIsInstance<android.widget.Switch>().single { it.text.toString() == MoteI18n.text("缩略图视图") }
                        assertTrue(grouping.isShown); assertTrue(thumbnails.isShown)
                        grouping.setSelection(1); thumbnails.isChecked = false
                        rows.filterIsInstance<android.widget.Spinner>().single { it.adapter.count == 7 }.setSelection(4)
                    }
                    instrumentation.waitForIdleSync()
                    instrumentation.runOnMainSync {
                        val rows = views(reader.window.decorView)
                        assertFalse(rows.filterIsInstance<android.widget.Switch>().single { it.text.toString() == MoteI18n.text("缩略图视图") }.isShown)
                        val grouping = rows.filterIsInstance<android.widget.Spinner>().single { it.adapter.count == 2 && it.getItemAtPosition(0).toString() == MoteI18n.text("按 Session · 连续记录") }
                        assertFalse(grouping.isShown); assertEquals(1, grouping.selectedItemPosition)
                        rows.filterIsInstance<android.widget.Spinner>().single { it.adapter.count == 7 }.setSelection(0)
                    }
                    instrumentation.waitForIdleSync()
                    instrumentation.runOnMainSync {
                        val rows = views(reader.window.decorView)
                        val grouping = rows.filterIsInstance<android.widget.Spinner>().single { it.adapter.count == 2 && it.getItemAtPosition(0).toString() == MoteI18n.text("按 Session · 连续记录") }
                        assertTrue(grouping.isShown); assertEquals(1, grouping.selectedItemPosition)
                        val thumbnails = rows.filterIsInstance<android.widget.Switch>().single { it.text.toString() == MoteI18n.text("缩略图视图") }
                        assertTrue(thumbnails.isShown); assertFalse(thumbnails.isChecked)
                        rows.filterIsInstance<android.widget.Spinner>().single { it.adapter.count == 7 }.setSelection(4)
                    }
                    instrumentation.waitForIdleSync()
                    val restoredDeadline = SystemClock.elapsedRealtime() + 10000
                    var restoredNote = false
                    while (!restoredNote && SystemClock.elapsedRealtime() < restoredDeadline) {
                        instrumentation.runOnMainSync { restoredNote = GeneratedWindowRendering.hasNoPendingLabels(reader.window.decorView) && views(reader.window.decorView).any { it.isShown && it.tag == "capture:$savedId" } }
                        if (!restoredNote) Thread.sleep(25)
                    }
                    assertTrue("The actual source switches preserve the saved note and its original", restoredNote)
                    instrumentation.runOnMainSync {
                        views(reader.window.decorView).filterIsInstance<TextView>().single { it.isShown && it.text.toString() == MoteI18n.text("前一天") }.performClick()
                    }
                    val emptyDeadline = SystemClock.elapsedRealtime() + 10000
                    var emptyNoteDay = false
                    while (!emptyNoteDay && SystemClock.elapsedRealtime() < emptyDeadline) {
                        instrumentation.runOnMainSync {
                            emptyNoteDay = views(reader.window.decorView).filterIsInstance<TextView>().any { it.isShown && it.text.toString() == MoteI18n.text("当天没有记录。选择其他日期，或添加一条记录。") }
                        }
                        if (!emptyNoteDay) Thread.sleep(25)
                    }
                    assertTrue("The actual previous date has a permission-free note empty state", emptyNoteDay)
                    instrumentation.runOnMainSync {
                        val rows = views(reader.window.decorView)
                        assertFalse(rows.any { it.isShown && it.tag == "capture:$savedId" })
                        assertFalse(rows.filterIsInstance<TextView>().any { it.isShown && it.text.toString() == MoteI18n.text("当天没有此类记录。请开启相应采集来源并授权，记录按同步策略上传。") })
                        GeneratedWindowRendering.save(reader, directory, "note-empty-list")
                        File(directory, "note-empty-list.txt").writeText(rows.filterIsInstance<TextView>().filter { it.isShown }.joinToString("\n") { it.text.toString() })
                        val next = rows.filterIsInstance<TextView>().single { it.isShown && it.text.toString() == MoteI18n.text("后一天") }
                        assertTrue(next.isEnabled); assertTrue(next.performClick())
                    }
                    val todayDeadline = SystemClock.elapsedRealtime() + 10000
                    var backToToday = false
                    while (!backToToday && SystemClock.elapsedRealtime() < todayDeadline) {
                        instrumentation.runOnMainSync { backToToday = GeneratedWindowRendering.hasNoPendingLabels(reader.window.decorView) && views(reader.window.decorView).any { it.isShown && it.tag == "capture:$savedId" } }
                        if (!backToToday) Thread.sleep(25)
                    }
                    assertTrue("Returning to the actual saved date recovers the same note ID", backToToday)
                    instrumentation.runOnMainSync {
                        GeneratedWindowRendering.save(reader, directory, "note-return-list")
                        File(directory, "note-return-list.txt").writeText(views(reader.window.decorView).filterIsInstance<TextView>().filter { it.isShown }.joinToString("\n") { it.text.toString() })
                        val back = views(reader.window.decorView).single { it.isShown && it.contentDescription == MoteI18n.text("返回上一页") }
                        assertTrue(back.getGlobalVisibleRect(android.graphics.Rect()))
                        assertTrue("Use the product's real header Back action", back.performClick())
                    }
                    val returnDeadline = SystemClock.elapsedRealtime() + 10000
                    var homeRecord = false
                    while (!homeRecord && SystemClock.elapsedRealtime() < returnDeadline) {
                        scenario.onActivity { activity ->
                            val shown = views(activity.window.decorView).filter { it.isShown }
                            val recent = shown.singleOrNull { it.tag == "home-recent-content" }
                            homeRecord = shown.singleOrNull { it.tag == "primary:LIBRARY" }?.isSelected == true &&
                                recent?.let { views(it).any { row -> row.isShown && row.tag == "library-record:$savedId" } } == true
                        }
                        if (!homeRecord) Thread.sleep(25)
                    }
                    assertTrue("Header Back resumes the originating Home with its selected navigation and the exact same generated note", homeRecord)
                } finally { instrumentation.removeMonitor(monitor) }
                context.queue().acknowledge(savedId)
                scenario.onActivity { assertTrue(QuickNotes.draft(it).read().text.isEmpty()) }
                tab("TODAY")
                scenario.onActivity { activity -> activity.openGeneratedAdd(MoteAddAction.SCREEN) }
                render("screen-scope")
                assertFalse(Settings(context).enabled)
            }
            ActivityScenario.launch(SourcesActivity::class.java).awaitUiText(MoteI18n.text("添加来源")).use { scenario ->
                scenario.onActivity { activity ->
                    GeneratedWindowRendering.save(activity, directory, "sources")
                    File(directory, "sources.txt").writeText(views(activity.window.decorView).filterIsInstance<TextView>().filter { it.isShown }.joinToString("\n") { it.text.toString() })
                    assertFalse(Settings(activity).enabled)
                }
            }
            ActivityScenario.launch<CentralActivity>(android.content.Intent(context, CentralActivity::class.java).putExtra("page", "archive")).use { scenario ->
                val deadline = SystemClock.elapsedRealtime() + 10000
                var ready = false
                while (!ready && SystemClock.elapsedRealtime() < deadline) {
                    scenario.onActivity { activity -> ready = views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.toString() == MoteI18n.text("资料库暂不可用。连接中央后，可浏览已归档的资料；文件和记录仍可在本机保存和查看。") } }
                    if (!ready) Thread.sleep(25)
                }
                assertTrue("Offline archive must explain browsing instead of questioning", ready)
                scenario.onActivity { activity ->
                    val title = views(activity.window.decorView).single { it.tag == "central-title" } as TextView
                    assertEquals(MoteI18n.text("资料库"), title.text.toString())
                    activity.navigate("ask")
                    assertEquals(MoteI18n.text("问一问"), title.text.toString())
                    assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.toString() == MoteI18n.text("中央问答暂不可用。连接中央后，可以根据已整理的内容提问；文件和记录仍可在本机保存。") })
                    activity.navigate("archive")
                    assertEquals(MoteI18n.text("资料库"), title.text.toString())
                    assertTrue(views(activity.window.decorView).filterIsInstance<TextView>().none { it.text.toString() == MoteI18n.text("中央问答暂不可用。连接中央后，可以根据已整理的内容提问；文件和记录仍可在本机保存。") })
                }
            }
            ActivityScenario.launch<FileTaskActivity>(android.content.Intent(context, FileTaskActivity::class.java).putExtra("addAction", "FILE")).awaitUiText(MoteI18n.text("未连接中央：先保存本机任务，连接时确认发送范围。")).use { scenario ->
                scenario.onActivity { activity ->
                    assertFalse(Settings(activity).read().hasSyncConnection())
                    val labels = views(activity.window.decorView).filterIsInstance<TextView>().map { it.text.toString() }
                    if (Settings(activity).read().server.isNotBlank()) assertTrue(labels.contains(MoteI18n.text("已填写的中央地址：{0}；连接并确认后才会发送。", Settings(activity).read().server)))
                    assertTrue(labels.none { it.startsWith(MoteI18n.text("完整文件的发送目的地：{0}", Settings(activity).read().server)) })
                    val root = activity.window.decorView
                    val title = views(root).filterIsInstance<TextView>().single { it.isShown && it.tag == "detail-title" }
                    assertEquals(MoteI18n.text("导入文件"), title.text.toString())
                    assertEquals("Import has a single page identity in the shared app bar", 1, labels.count { it == MoteI18n.text("导入文件") })
                    assertEquals(MoteUi.ink, title.currentTextColor)
                    GeneratedWindowRendering.save(activity, directory, "import-local-task")
                    File(directory, "import-local-task.txt").writeText(labels.joinToString("\n"))
                }
            }
            fun dialogRoot(): View? = android.view.inspector.WindowInspector.getGlobalWindowViews().lastOrNull { root ->
                root.findViewById<View>(android.R.id.button2)?.isShown == true
            }
            fun dialogViews(): List<View> = dialogRoot()?.let(::views).orEmpty()
            fun tapDialog(label: String) {
                instrumentation.waitForIdleSync()
                instrumentation.runOnMainSync {
                    val target = dialogViews().filterIsInstance<TextView>().single { it.isShown && it.text.toString() == MoteI18n.text(label) }
                    assertTrue("Dialog action must actually be visible", target.getGlobalVisibleRect(android.graphics.Rect()))
                    var row: View = target
                    while (row.parent is View && row.parent !is android.widget.ListView) row = row.parent as View
                    val list = row.parent as? android.widget.ListView
                    if (list != null) {
                        val position = list.getPositionForView(row)
                        assertTrue(list.performItemClick(row, position, list.getItemIdAtPosition(position)))
                    } else assertTrue(target.performClick())
                }
                instrumentation.waitForIdleSync()
            }
            lateinit var guideActivity: CentralActivity
            fun drawDialog(name: String) {
                instrumentation.waitForIdleSync()
                val drawn = java.util.concurrent.CountDownLatch(1)
                instrumentation.runOnMainSync {
                    val base = guideActivity.window.decorView
                    val listener = object : android.view.ViewTreeObserver.OnDrawListener {
                        override fun onDraw() {
                            drawn.countDown()
                            base.post { if (base.viewTreeObserver.isAlive) base.viewTreeObserver.removeOnDrawListener(this) }
                        }
                    }
                    base.viewTreeObserver.addOnDrawListener(listener)
                    base.invalidate()
                }
                assertTrue("The actual underlying application window must draw before guide evidence: $name", drawn.await(5, java.util.concurrent.TimeUnit.SECONDS))
                instrumentation.waitForIdleSync()
                saveGeneratedOwnedWindowBuffer(guideActivity, File(context.filesDir, "ui-guide-window-evidence/$variant"), name)
                instrumentation.runOnMainSync {
                    File(directory, "$name-roots.txt").writeText(android.view.inspector.WindowInspector.getGlobalWindowViews().joinToString("\n\n") { root -> views(root).filterIsInstance<TextView>().joinToString("\n") { "${it.id} shown=${it.isShown} text=${it.text}" } })
                    val root = requireNotNull(dialogRoot())
                    GeneratedWindowRendering.save(guideActivity, directory, name, listOf(root),
                        ownedGuideBuffer = File(context.filesDir, "ui-guide-window-evidence/$variant/$name.png"))
                    File(directory, "$name.txt").writeText(views(root).filterIsInstance<TextView>().filter { it.isShown }.joinToString("\n") { it.text.toString() })
                }
            }
            val guide = android.content.Intent(context, CentralActivity::class.java).putExtra("page", "overview").putExtra("featureGuide", true)
            ActivityScenario.launch<CentralActivity>(guide).use { scenario ->
                scenario.onActivity { guideActivity = it }
                drawDialog("feature-guide")
                tapDialog("内容"); drawDialog("feature-guide-content")
                instrumentation.runOnMainSync {
                    assertTrue(dialogViews().filterIsInstance<TextView>().any { it.text.toString() == MoteI18n.text("记忆") })
                    assertTrue(dialogViews().filterIsInstance<TextView>().none { it.text.toString() in listOf(MoteI18n.text("Coding Agent 上传"), MoteI18n.text("Coding 会话同步状态")) })
                }
                tapDialog("记忆")
                scenario.onActivity { activity -> assertEquals(MoteI18n.text("记忆"), (views(activity.window.decorView).single { it.tag == "central-title" } as TextView).text.toString()) }
                scenario.recreate()
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    assertEquals(MoteI18n.text("记忆"), (views(activity.window.decorView).single { it.tag == "central-title" } as TextView).text.toString())
                    assertTrue(dialogViews().filterIsInstance<TextView>().none { it.text.toString() == MoteI18n.text("此客户端支持的中央功能") })
                    activity.navigate("coding")
                    assertEquals(MoteI18n.text("Coding 会话同步状态"), (views(activity.window.decorView).single { it.tag == "central-title" } as TextView).text.toString())
                    activity.navigate("settings")
                    assertFalse("Central maintenance also keeps only related actions", views(activity.window.decorView).any { it.isShown && it.contentDescription == MoteI18n.text("添加内容") })
                    activity.navigate("ask")
                    assertTrue("Ask retains its unobtrusive global context action", views(activity.window.decorView).any { it.isShown && it.contentDescription == MoteI18n.text("添加内容") })
                }
            }
            MoteI18n.select(context, "en")
            ActivityScenario.launch<CentralActivity>(guide).use { scenario ->
                scenario.onActivity { guideActivity = it }
                drawDialog("feature-guide-english")
                instrumentation.runOnMainSync {
                    assertTrue("Dialog close uses an action translation", dialogViews().filterIsInstance<TextView>().any { it.text.toString() == "Cancel" })
                    assertTrue(dialogViews().filterIsInstance<TextView>().none { it.text.toString() == "Off" })
                }
                tapDialog("Cancel")
            }
        } finally { MoteI18n.select(context, previous) }
    }
}
