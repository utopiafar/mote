package dev.mote.collector

import android.app.UiAutomation
import android.content.ComponentName
import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/** Real AccessibilityService and screenshot API, restricted to this test APK's generated pages. */
@RunWith(AndroidJUnit4::class)
class UiPageServiceInstrumentedTest {
    @Test fun generatedArticlesProductsAndFallbacksUseTheActualCollectionLifecycle() {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val context=instrumentation.targetContext
        val automation=instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        automation.serviceInfo=automation.serviceInfo.apply { flags=flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS }
        fun shell(command: String)=automation.executeShellCommand(command).use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText().trim() } }
        require(context.packageName=="dev.mote.collector.dev" && shell("getprop ro.boot.qemu.avd_name")=="mote_fixture_api35")
        val settings=Settings(context)
        require(!settings.enabled && context.queue().depth()==0 && !CaptureAccessibilityService.connected && !ProjectionService.running)
        val prefs=context.getSharedPreferences("mote",0);val original=prefs.all.toMap()
        val previousServices=shell("settings get secure enabled_accessibility_services")
        val previousEnabled=shell("settings get secure accessibility_enabled")
        val fixture=context.packageName+".test"
        val version=context.packageManager.getPackageInfo(fixture,0).versionName.orEmpty()
        require(version.isNotBlank()) { "Generated test APK must declare its exact version" }
        require(context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)==android.content.pm.PackageManager.PERMISSION_GRANTED) { "The generated-only host runner must grant and restore notification permission outside Instrumentation" }
        fun waitFor(label: String, check: () -> Boolean) {
            val deadline=android.os.SystemClock.elapsedRealtime()+30000
            while(!check()) { if(android.os.SystemClock.elapsedRealtime()>=deadline) {
                val service=CaptureAccessibilityService.instance
                val identity=service?.let { target -> listOf("pagePackage","pageActivity","activityClasses").joinToString { key -> val field=target.javaClass.getDeclaredField(key);field.isAccessible=true;"$key=${field.get(target)}" } }
                val root=service?.rootInActiveWindow
                val structure=try { if(root?.packageName?.toString()==context.packageName+".test") {
                    val bounds=android.graphics.Rect();root.getBoundsInScreen(bounds)
                    val all=service.windows
                    val target=all.firstOrNull { it.id==root.windowId }
                    val occlusions=all.filter { target!=null && it.layer>target.layer }.map { android.graphics.Rect().also(it::getBoundsInScreen) }
                    val sample=UiPageReader.read(root,root.packageName.toString(),"generated","generated",bounds,emptyList(),occlusions)
                    val nodes=sample.getJSONArray("nodes")
                    "occlusions=$occlusions; truncated=${sample.getBoolean("truncated")}; nodes="+(0 until nodes.length()).joinToString { index -> val node=nodes.getJSONObject(index);"${node.optString("resourceId")}:${node.optString("text").length}:${node.optJSONObject("bounds")}" }
                } else "generated root unavailable" } finally { @Suppress("DEPRECATION") root?.recycle() }
                fail(label+": "+settings.message()+"; "+identity+"; "+structure+"; fixtureVersion="+context.packageManager.getPackageInfo(context.packageName+".test",0).versionName)
            };Thread.sleep(100) }
        }
        fun stop() {
            settings.enabled=false;instrumentation.runOnMainSync { CaptureAccessibilityService.instance?.stopCapture() }
            waitFor("capture drained"){ConnectionGuard.processing.get()==0}
        }
        fun rows(): List<JSONObject> = context.queue().peekBatch(100)
        fun clear() { while(context.queue().depth()>0) { val batch=rows();check(batch.isNotEmpty());batch.forEach { context.queue().acknowledge(it.getString("id")) } } }
        fun field(name: String, required: Boolean = false)=JSONObject().put("select",JSONObject().put("resourceId","$fixture:id/mote_fixture_$name")).put("required",required)
        val article=JSONObject().put("formatVersion",2).put("id","generated.article").put("version","1").put("platform","android").put("appId",fixture).put("appVersion",version)
            .put("activity",ExternalFixtureActivity::class.java.name).put("kind","article").put("region",JSONObject().put("resourceId","$fixture:id/mote_fixture_article"))
            .put("fields",JSONObject().put("title",field("title",true)).put("author",field("author")).put("url",field("url")).put("body",field("body",true)))
        val product=JSONObject().put("formatVersion",2).put("id","generated.product").put("version","1").put("platform","android").put("appId",fixture).put("appVersion",version)
            .put("activity",ExternalFixtureActivity::class.java.name).put("kind","product").put("region",JSONObject().put("resourceId","$fixture:id/mote_fixture_products"))
            .put("repeat",JSONObject().put("resourceId","$fixture:id/mote_fixture_card")).put("repeatParent",JSONObject().put("resourceId","$fixture:id/mote_fixture_products"))
            .put("fields",JSONObject().put("title",field("product_title",true)).put("url",field("product_url")).put("itemId",field("product_id")))
        val base=settings.read().copy(server="",token="",syncMode="manual",mode="accessibility",intervalSeconds=5,screenCollectionEnabled=true,mediaCollectionEnabled=false,notificationCollectionEnabled=false,deviceEventCollectionEnabled=false,
            excludedPackages="",masks="",appCollectionRules=AppCollectionRules.fromLines(AppCollectionMode.OFF,"$fixture=content").json(),chargingOnly=false,batteryPauseBelowPct=0,uiPageMode="ui_preferred",imageDedupeMode="off",uploadGate=UploadGateConfig(false))
        fun renderedScene(scene: String): Boolean {
            automation.clearCache()
            val root=automation.rootInActiveWindow ?: return false
            try {
                if(root.packageName?.toString()!=fixture)return false
                val viewport=android.graphics.Rect();root.getBoundsInScreen(viewport)
                val all=automation.windows
                val target=all.firstOrNull { it.id==root.windowId } ?: return false
                val occlusions=all.filter { it.layer>target.layer }.map { android.graphics.Rect().also(it::getBoundsInScreen) }
                val fields=linkedMapOf<String,MutableList<String>>()
                val visibleText=mutableListOf<String>();var count=0
                fun visit(node: android.view.accessibility.AccessibilityNodeInfo, depth: Int) {
                    if(depth>40 || count++>=128 || !node.isVisibleToUser)return
                    val text=node.text?.toString().orEmpty()
                    val bounds=android.graphics.Rect();node.getBoundsInScreen(bounds)
                    if(!bounds.isEmpty && viewport.contains(bounds) && occlusions.none { android.graphics.Rect.intersects(it,bounds) }) {
                        visibleText.add(text);fields.getOrPut(node.viewIdResourceName.orEmpty()){mutableListOf()}.add(text)
                    }
                    for(index in 0 until node.childCount) {
                        val child=node.getChild(index)?:continue
                        try { visit(child,depth+1) } finally { @Suppress("DEPRECATION") child.recycle() }
                    }
                }
                visit(root,0)
                fun has(name: String, text: String)=fields["$fixture:id/mote_fixture_$name"]?.contains(text)==true
                val title=has("title","Generated article title")
                return when(scene) {
                    "article" -> title && has("body","Generated original paragraph one.\nGenerated original paragraph two.")
                    "private" -> title && has("body","GENERATED_BLOCKED_LITERAL")
                    "missingBody" -> title && has("url","https://example.invalid/articles/generated") && !fields.containsKey("$fixture:id/mote_fixture_body")
                    "product" -> (0..1).all { index -> has("product_title","Generated product $index") && has("product_id","generated-item-$index") && has("product_url","https://example.invalid/items/$index") }
                    "empty" -> visibleText.contains("Generated page without structured article or product fields")
                    else -> false
                }
            } finally { @Suppress("DEPRECATION") root.recycle() }
        }
        fun begin(scene: String, config: CollectorConfig = base.copy(uiPageRules=JSONArray().put(article).put(product).toString())) {
            stop();clear();settings.save(config)
            instrumentation.runOnMainSync { context.startActivity(Intent().setComponent(ComponentName(fixture,ExternalFixtureActivity::class.java.name)).putExtra("pageScene",scene).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) }
            waitFor("generated fixture foreground and actual Activity event"){
                val service=CaptureAccessibilityService.instance
                val activity=service?.let { target -> val field=target.javaClass.getDeclaredField("pageActivity");field.isAccessible=true;field.get(target) }
                service?.windowSnapshot()?.foreground==fixture && MoteApplication.visibleActivities==0 && activity==ExternalFixtureActivity::class.java.name && renderedScene(scene)
            }
            settings.enabled=true
        }
        var testFailure: Throwable? = null
        try {
            WorkManager.getInstance(context).cancelAllWork().result.get(20,TimeUnit.SECONDS)
            shell("settings put secure enabled_accessibility_services ${context.packageName}/dev.mote.collector.CaptureAccessibilityService")
            shell("settings put secure accessibility_enabled 1")
            shell("input keyevent KEYCODE_WAKEUP");shell("wm dismiss-keyguard")
            waitFor("real accessibility service connected"){CaptureAccessibilityService.connected}
            begin("article")
            waitFor("article field record and measured activity"){rows().any { it.optString("source")=="ui_page" } && rows().any { it.optString("source")=="activity" }}
            stop()
            val articleRows=rows();assertTrue(articleRows.all { it.getString("source") in setOf("ui_page","activity") });assertEquals(0,context.queue().inventory().images)
            val observed=articleRows.first { it.getString("source")=="ui_page" }.getJSONObject("metadata").getJSONObject("uiPage")
            assertFalse(observed.has("nodes"));assertEquals("Generated article title",observed.getJSONArray("objects").getJSONObject(0).getString("title"))
            assertTrue(UiPageRules.text(observed).contains("Generated original paragraph two."))
            begin("product")
            waitFor("two independent product field records"){rows().count { it.optString("source")=="ui_page" }>=2}
            stop()
            val products=rows().filter { it.getString("source")=="ui_page" }.map { it.getJSONObject("metadata").getJSONObject("uiPage").getJSONArray("objects").getJSONObject(0) }
            assertEquals(setOf("generated-item-0","generated-item-1"),products.map { it.getString("itemId") }.toSet());assertEquals(0,context.queue().inventory().images)
            for(scene in listOf("missingBody","empty")) {
                begin(scene);waitFor("missing fields fallback screenshot"){context.queue().inventory().images>0};stop()
                assertTrue(rows().any { it.getString("source")=="screen" });assertFalse(rows().any { it.getString("source")=="ui_page" })
            }
            val wrong=JSONObject(article.toString()).put("appVersion",version+"-wrong")
            begin("article",base.copy(uiPageRules=JSONArray().put(wrong).toString()))
            waitFor("wrong version fallback screenshot"){context.queue().inventory().images>0};stop();assertFalse(rows().any { it.getString("source")=="ui_page" })
            val privateConfig=base.copy(uiPageRules=JSONArray().put(article).toString(),uploadGate=UploadGateConfig(true,"GENERATED_BLOCKED_LITERAL","drop"))
            val beforeRequests=Operations.ledger(context).read().getJSONObject("counts").getLong("CAPTURE_REQUESTED")
            begin("private",privateConfig)
            waitFor("structured privacy gate rejection"){settings.message().contains(MoteI18n.text("页面隐私审查未通过，已跳过"))}
            Thread.sleep(5500);stop()
            assertEquals(0,context.queue().depth());assertEquals(beforeRequests,Operations.ledger(context).read().getJSONObject("counts").getLong("CAPTURE_REQUESTED"))
        } catch(error: Throwable) { testFailure=error;throw error }
        finally {
            var cleanupFailure: Throwable? = null
            fun cleanup(action: () -> Unit) { try { action() } catch(error: Throwable) { if(cleanupFailure==null)cleanupFailure=error else cleanupFailure!!.addSuppressed(error) } }
            cleanup { stop() };cleanup { clear() }
            cleanup { WorkManager.getInstance(context).cancelAllWork().result.get(20,TimeUnit.SECONDS) }
            cleanup { instrumentation.runOnMainSync { context.startActivity(Intent().setComponent(ComponentName(fixture,ExternalFixtureActivity::class.java.name)).putExtra("finishPageFixture",true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) } }
            cleanup { if(previousServices=="null")shell("settings delete secure enabled_accessibility_services") else shell("settings put secure enabled_accessibility_services $previousServices") }
            cleanup { if(previousEnabled=="null")shell("settings delete secure accessibility_enabled") else shell("settings put secure accessibility_enabled $previousEnabled") }
            cleanup { waitFor("fixture accessibility service detached"){!CaptureAccessibilityService.connected} }
            cleanup { val editor=prefs.edit().clear();original.forEach { (key,value) -> when(value) { is String->editor.putString(key,value);is Boolean->editor.putBoolean(key,value);is Int->editor.putInt(key,value);is Long->editor.putLong(key,value);is Float->editor.putFloat(key,value) } };check(editor.commit()) }
            cleanupFailure?.let { if(testFailure!=null)testFailure!!.addSuppressed(it) else throw it }
        }
    }
}
