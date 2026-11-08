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
    @Test fun portableGuardMatchesNodeOnAndroidWithActualResourceIdSlashes() {
        assertEquals("f7663005ee16f9914f4245624a683e396a5973f9735bfde989cf614aaf265fab", UiStructureHash.hash("dev.generated:id/root", "android.view.ViewGroup", emptyList()))
        val at="2026-10-24T00:00:00.000Z"
        val rule=org.json.JSONObject("""{"formatVersion":3,"id":"generated.guard","version":"1","platform":"android","appId":"fixture","appVersion":"1","kind":"visible_text","repeat":{"resourceId":"dev.generated:id/root"},"repeatSubtreeHash":"f7663005ee16f9914f4245624a683e396a5973f9735bfde989cf614aaf265fab","fields":{"visible_text":{"select":{"resourceId":"dev.generated:id/root"},"required":true}}}""")
        val snapshot=org.json.JSONObject("""{"appId":"fixture","appVersion":"1","activity":"","observedAt":"$at","truncated":false,"nodes":[{"id":"0","resourceId":"dev.generated:id/root","role":"android.view.ViewGroup","text":"Generated guarded content"}]}""")
        val page=NamedPageRules.extract(snapshot,rule,at).single()
        assertEquals("Generated guarded content",NamedPageRules.text(page))
    }
    private fun body(page:org.json.JSONObject):org.json.JSONArray {
        val fields=page.getJSONArray("objects").getJSONObject(0).getJSONArray("fields")
        return (0 until fields.length()).map(fields::getJSONObject).single {it.getString("name")=="body"}.getJSONArray("values")
    }
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
    @Test fun leafDescriptionBudgetPreservesUnicodeAndCannotBypassVisibilityOrMasks() {
        val described=node().apply {text="";contentDescription="Generated visible label"}
        assertEquals("Generated visible label",read(described).getJSONArray("nodes").getJSONObject(0).getString("description"))
        assertEquals("",read(described,listOf(Rect(0,0,20,20))).getJSONArray("nodes").getJSONObject(0).getString("description"))
        assertEquals("",read(described,occluded=listOf(Rect(0,0,20,20))).getJSONArray("nodes").getJSONObject(0).getString("description"))
        assertEquals(0,read(node().apply {isVisibleToUser=false;contentDescription="Generated hidden label"}).getJSONArray("nodes").length())
        val bounded=read(node().apply {text="";contentDescription="d".repeat(32001)})
        assertTrue(bounded.getBoolean("truncated"));assertFalse(bounded.getBoolean("ocrSafe"))
        assertEquals(32000,bounded.getJSONArray("nodes").getJSONObject(0).getString("description").length)
        val unicode=read(node().apply {text="x".repeat(31999);contentDescription="\uD83D\uDE00"})
        assertTrue(unicode.getBoolean("truncated"));assertFalse(unicode.getBoolean("ocrSafe"))
        assertEquals("",unicode.getJSONArray("nodes").getJSONObject(0).getString("description"))
    }
    @Test fun ephemeralOcrReceivesOnlySafeViewportAndExplicitPrivateRegions() {
        val viewport=Rect(5,6,95,94);val overlay=Rect(40,30,60,50)
        val snapshot=UiPageReader.read(node(),"fixture","1","fixture.Page",viewport,emptyList(),listOf(overlay))
        val visible=snapshot.getJSONObject("ocrViewport")
        assertEquals(5,visible.getInt("x"));assertEquals(6,visible.getInt("y"));assertEquals(90,visible.getInt("width"));assertEquals(88,visible.getInt("height"))
        val masks=snapshot.getJSONArray("ocrMasks")
        assertTrue((0 until masks.length()).map(masks::getJSONObject).any {it.getInt("x")==40&&it.getInt("y")==30&&it.getInt("width")==20&&it.getInt("height")==20})
        val sensitive=read(node().apply {isPassword=true})
        assertTrue(sensitive.getBoolean("ocrSafe"));assertEquals(1,sensitive.getJSONArray("ocrMasks").length())
        assertEquals(10,sensitive.getJSONArray("ocrMasks").getJSONObject(0).getInt("x"))
        assertFalse(read(node().apply {isPassword=true;setBoundsInScreen(Rect())}).getBoolean("ocrSafe"))
        assertFalse(read(node().apply {packageName="foreign";setBoundsInScreen(Rect())}).getBoolean("ocrSafe"))
        assertFalse(read(node().apply {text="x".repeat(32001)}).getBoolean("ocrSafe"))
    }
    @Test fun generatedPixelsOutsideInspectedViewportOrInsidePrivateRegionsStayBlack() {
        val viewport=Rect(5,6,95,94);val overlay=Rect(40,30,60,50)
        val snapshot=UiPageReader.read(node().apply {isPassword=true},"fixture","1","fixture.Page",viewport,emptyList(),listOf(overlay))
        val bitmap=android.graphics.Bitmap.createBitmap(100,100,android.graphics.Bitmap.Config.ARGB_8888)
        try {
            bitmap.eraseColor(android.graphics.Color.WHITE)
            ImagePrivacy.applyMasks(bitmap,listOf(Mask(.8f,.6f,.9f,.8f)))
            assertTrue(ImagePrivacy.applyOcrRegions(bitmap,snapshot))
            for(y in 0 until 100)for(x in 0 until 100) {
                val masked=!viewport.contains(x,y)||overlay.contains(x,y)||Rect(10,10,80,30).contains(x,y)||Rect(80,60,90,80).contains(x,y)
                assertEquals("Generated pixel $x,$y",if(masked)android.graphics.Color.BLACK else android.graphics.Color.WHITE,bitmap.getPixel(x,y))
            }
            val unknown=read(node().apply {isPassword=true;setBoundsInScreen(Rect())})
            assertFalse(ImagePrivacy.applyOcrRegions(bitmap,unknown))
            assertFalse(ImagePrivacy.applyOcrRegions(bitmap,org.json.JSONObject().put("ocrSafe",true)))
        } finally {bitmap.recycle()}
    }
    @Test fun extractedLongArticleContainsOnlyFields() {
        val raw = read(node().apply { text="Generated article. "+"正文".repeat(4000);viewIdResourceName="fixture:id/body" }).put("observedAt","2026-10-10T00:00:00Z")
        raw.getJSONArray("nodes").put(org.json.JSONObject().put("id","title").put("resourceId","fixture:id/title").put("role","android.widget.TextView").put("text","Generated title"))
        val rule = """[{"formatVersion":3,"id":"generated.article","version":"1","platform":"android","appId":"fixture","appVersion":"1","kind":"article","fields":{"title":{"select":{"resourceId":"fixture:id/title"},"required":true},"body":{"select":{"resourceId":"fixture:id/body"},"required":true,"cardinality":"many"}}}]"""
        val pages = UiPageRules.extractAll(raw, UiPageRules.parse(rule))
        assertEquals(1,pages.size)
        val page = pages.single()
        assertFalse(page.has("nodes"));assertFalse(page.toString().contains("resourceId"))
        val body=body(page)
        assertEquals(1,body.length())
        assertEquals(raw.getJSONArray("nodes").getJSONObject(0).getString("text"),(0 until body.length()).joinToString(""){body.getJSONObject(it).getString("text")})
    }
    @Suppress("DEPRECATION")
    @Test fun deepGeneratedAndroidHierarchyPreservesOriginalBodyAndRemainsBounded() {
        val instrumentation=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val context=instrumentation.targetContext
        val automation=instrumentation.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        val avd=automation.executeShellCommand("getprop ro.boot.qemu.avd_name").use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() } }
        require(context.packageName=="dev.mote.collector.dev" && avd in setOf("mote_fixture_api35","mote_fixture_api37"))
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
            val rule="""[{"formatVersion":3,"id":"generated.deep","version":"1","platform":"android","appId":"$fixture","appVersion":"$version","activity":"$activity","kind":"article","fields":{"title":{"select":{"resourceId":"$fixture:id/mote_fixture_title"},"required":true},"body":{"select":{"resourceId":"$fixture:id/mote_fixture_body"},"required":true,"cardinality":"many"}}}]"""
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
                    assertEquals("Generated deeply nested original article body.",body(pages.single()).getJSONObject(0).getString("text"))
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
