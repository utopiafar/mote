package dev.mote.collector

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Entirely synthetic nodes: never queries a real app, screenshot, or personal content. */
@RunWith(AndroidJUnit4::class)
class UiPageReaderInstrumentedTest {
    @Suppress("DEPRECATION")
    private fun node()=AccessibilityNodeInfo.obtain().apply { packageName="fixture";className="android.widget.TextView";text="Generated fixture text";isVisibleToUser=true;setBoundsInScreen(Rect(10,10,80,30)) }
    private fun read(n: AccessibilityNodeInfo, masks: List<Rect> = emptyList(), occluded: List<Rect> = emptyList())=UiPageReader.read(n,"fixture","1","fixture.Page",Rect(0,0,100,100),masks,occluded)
    @Test fun sensitiveAndHiddenContentNeverLeavesReader() {
        assertEquals("Generated fixture text",read(node()).getJSONArray("nodes").getJSONObject(0).getString("text"))
        for(n in listOf(node().apply{isPassword=true},node().apply{isEditable=true},node().apply{isVisibleToUser=false},node().apply{packageName="foreign"}))assertEquals(0,read(n).getJSONArray("nodes").length())
        assertEquals("",read(node(),listOf(Rect(0,0,20,20))).getJSONArray("nodes").getJSONObject(0).getString("text"))
        assertEquals("",read(node(),occluded=listOf(Rect(0,0,20,20))).getJSONArray("nodes").getJSONObject(0).getString("text"))
        val large=read(node().apply{text="x".repeat(2001)})
        assertFalse(large.getBoolean("truncated"));assertEquals("x".repeat(2001),large.getJSONArray("nodes").getJSONObject(0).getString("text"))
        val bounded=read(node().apply{text="x".repeat(32001)})
        assertTrue(bounded.getBoolean("truncated"));assertEquals(32000,bounded.getJSONArray("nodes").getJSONObject(0).getString("text").length)
        assertEquals(0,bounded.getJSONArray("nodes").getJSONObject(0).getInt("childIndex"))
    }
    @Test fun extractedLongArticleContainsOnlyFields() {
        val raw = read(node().apply { text="Generated article. "+"正文".repeat(4000);viewIdResourceName="fixture:id/body" }).put("observedAt","2026-10-10T00:00:00Z")
        raw.getJSONArray("nodes").put(org.json.JSONObject().put("id","title").put("resourceId","fixture:id/title").put("role","android.widget.TextView").put("text","Generated title"))
        val rule = """[{"formatVersion":2,"id":"generated.article","version":"1","platform":"android","appId":"fixture","appVersion":"1","kind":"article","fields":{"title":{"select":{"resourceId":"fixture:id/title"},"required":true},"body":{"select":{"resourceId":"fixture:id/body"},"required":true}}}]"""
        val pages = UiPageRules.extractAll(raw, UiPageRules.parse(rule))
        assertEquals(1,pages.size)
        val page = pages.single()
        assertFalse(page.has("nodes"));assertFalse(page.toString().contains("resourceId"))
        val body=page.getJSONArray("objects").getJSONObject(0).getJSONArray("body")
        assertEquals(1,body.length())
        assertEquals(raw.getJSONArray("nodes").getJSONObject(0).getString("text"),(0 until body.length()).joinToString(""){body.getJSONObject(it).getString("text")})
    }
    @Suppress("DEPRECATION")
    @Test fun deepGeneratedAndroidHierarchyPreservesOriginalBodyAndRemainsBounded() {
        val instrumentation=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val context=instrumentation.targetContext
        val automation=instrumentation.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        val avd=automation.executeShellCommand("getprop ro.boot.qemu.avd_name").use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() } }
        require(context.packageName=="dev.mote.collector.dev" && avd=="mote_fixture_api35")
        require(!Settings(context).enabled && !CaptureAccessibilityService.connected && !ProjectionService.running && context.queue().depth()==0)
        val fixture=context.packageName+".test"
        val version=context.packageManager.getPackageInfo(fixture,0).versionName.orEmpty()
        val activity=ExternalFixtureActivity::class.java.name
        fun launch(wrappers: Int) {
            instrumentation.runOnMainSync { context.startActivity(android.content.Intent().setComponent(android.content.ComponentName(fixture,activity))
                .putExtra("pageScene","deepArticle").putExtra("pageWrappers",wrappers).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK)) }
            instrumentation.waitForIdleSync()
        }
        fun bodyDepth(node: AccessibilityNodeInfo, depth: Int=0): Int? {
            if(node.viewIdResourceName=="$fixture:id/mote_fixture_body")return depth
            if(depth>40)return null
            for(index in 0 until node.childCount) {
                val child=node.getChild(index)?:continue
                val found=try { bodyDepth(child,depth+1) } finally { child.recycle() }
                if(found!=null)return found
            }
            return null
        }
        fun rootWithBody(expectedDepth: Int): AccessibilityNodeInfo {
            val deadline=android.os.SystemClock.elapsedRealtime()+10000
            while(android.os.SystemClock.elapsedRealtime()<deadline) {
                automation.clearCache()
                val root=automation.rootInActiveWindow
                if(root!=null) { if(root.packageName?.toString()==fixture && bodyDepth(root)==expectedDepth)return root;root.recycle() }
                Thread.sleep(100)
            }
            throw AssertionError("Generated deep Android hierarchy did not render")
        }
        try {
            val rule="""[{"formatVersion":2,"id":"generated.deep","version":"1","platform":"android","appId":"$fixture","appVersion":"$version","activity":"$activity","kind":"article","fields":{"title":{"select":{"resourceId":"$fixture:id/mote_fixture_title"},"required":true},"body":{"select":{"resourceId":"$fixture:id/mote_fixture_body"},"required":true}}}]"""
            for((wrappers,expectedDepth) in listOf(25 to 29,29 to 33)) {
                launch(wrappers)
                val root=rootWithBody(expectedDepth)
                val snapshot=try {
                    assertEquals("Actual Android body depth",expectedDepth,bodyDepth(root))
                    val viewport=Rect();root.getBoundsInScreen(viewport)
                    UiPageReader.read(root,fixture,version,activity,viewport,emptyList(),emptyList()).put("observedAt","2026-10-10T00:00:00Z")
                } finally { root.recycle() }
                assertTrue(snapshot.getJSONArray("nodes").length()<=256)
                val pages=UiPageRules.extractAll(snapshot,UiPageRules.parse(rule))
                if(expectedDepth==29) {
                    assertFalse(snapshot.getBoolean("truncated"));assertEquals(1,pages.size)
                    assertEquals("Generated deeply nested original article body.",pages.single().getJSONArray("objects").getJSONObject(0).getJSONArray("body").getJSONObject(0).getString("text"))
                } else { assertTrue(snapshot.getBoolean("truncated"));assertTrue(pages.isEmpty()) }
            }
        } finally {
            instrumentation.runOnMainSync { context.startActivity(android.content.Intent().setComponent(android.content.ComponentName(fixture,activity)).putExtra("finishPageFixture",true).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            instrumentation.waitForIdleSync()
            val deadline=android.os.SystemClock.elapsedRealtime()+10000
            while(true) {
                automation.clearCache()
                val root=automation.rootInActiveWindow
                val closed=try { root?.packageName?.toString()!=fixture } finally { root?.recycle() }
                if(closed)break
                if(android.os.SystemClock.elapsedRealtime()>=deadline)throw AssertionError("Generated deep fixture did not close")
                Thread.sleep(100)
            }
        }
    }
}
