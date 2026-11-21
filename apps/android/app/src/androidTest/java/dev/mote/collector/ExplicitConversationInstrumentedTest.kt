package dev.mote.collector

import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Controlled HTTP boundary only. Keeps the real final profile/device and never calls a model. */
@RunWith(AndroidJUnit4::class)
class ExplicitConversationInstrumentedTest {
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private val context get()=instrumentation.targetContext
    private fun <T> main(block:()->T):T { val result=AtomicReference<Result<T>>();instrumentation.runOnMainSync{result.set(runCatching(block))};return result.get().getOrThrow() }
    private fun views(view:View):List<View> = listOf(view)+if(view is ViewGroup)(0 until view.childCount).flatMap{views(view.getChildAt(it))}else emptyList()
    private fun shown()=WindowInspector.getGlobalWindowViews().filter{it.isShown&&it.hasWindowFocus()}.flatMap(::views).filter{it.isShown}
    private fun until(label:String,check:()->Boolean){val end=SystemClock.elapsedRealtime()+20_000;while(SystemClock.elapsedRealtime()<end){if(check())return;Thread.sleep(40)};fail(label)}
    private fun picture(scenario:ActivityScenario<CentralActivity>,name:String){scenario.onActivity{activity->val root=activity.window.decorView;val bitmap=android.graphics.Bitmap.createBitmap(root.width,root.height,android.graphics.Bitmap.Config.ARGB_8888);try{root.draw(android.graphics.Canvas(bitmap));File(context.filesDir,"explicit-conversation-risk").apply{mkdirs()}.resolve("$name.png").outputStream().use{bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}}finally{bitmap.recycle()}}}
    private fun fixture(block:(Fixture)->Unit){
        assumeTrue(InstrumentationRegistry.getArguments().getString("nativeConversationTargetFixture")=="true")
        require(context.packageName=="dev.mote.collector.dev"&&Build.FINGERPRINT.contains("emu64a")&&!Settings(context).enabled&&!ProjectionService.running&&!CaptureAccessibilityService.connected)
        val settings=Settings(context);val before=settings.read();val device=settings.deviceId;val language=MoteI18n.preference()
        Fixture().use{fixture->try{
            MoteI18n.select(context,"zh-CN")
            until("Generated fixture reaches the existing idle connection boundary"){try{ConnectionGuard.change(context,fixture.origin,bindLocal=true){settings.saveConnection(fixture.origin,fixture.tokenA,"Generated exact conversation test",true);settings.save(settings.read().copy(syncMode="manual",syncPaused=true),confirmCentralEndpoint=true)};true}catch(error:ConnectionFailure){if(error.category!="busy")throw error;false}}
            block(fixture)
        }finally{
            fixture.release.countDown();CentralDraftWrites.barrier{};settings.save(before,confirmCentralEndpoint=true);CentralSession.get(context).select(before.server);MoteI18n.select(context,language)
            assertEquals(device,settings.deviceId);assertFalse(settings.enabled)
            File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(fixture.origin)).deleteRecursively()
        }}
    }
    private fun open(fixture:Fixture)=ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","ask").putExtra("conversationId",fixture.a))

    @Test fun explicitTargetWinsOverUnrelatedRunningAndActualPostKeepsTarget()=fixture{fixture->
        open(fixture).use{scenario->
            until("Exact A response rendered before input"){var ready=false;scenario.onActivity{ready=it.selectedAskConversationId==fixture.a&&!it.isWorking};ready}
            main{assertFalse(shown().filterIsInstance<TextView>().any{it.text.toString()=="Generated unrelated B history"});shown().filterIsInstance<EditText>().single{it.contentDescription=="你的问题"}.setText("Generated explicit A follow-up")}
            picture(scenario,"explicit-A-while-unrelated-B-running")
            main{shown().single{it.contentDescription=="发送"}.also{assertTrue(it.isEnabled)}.performClick()}
            until("One real native POST reaches controlled HTTP"){fixture.posted.get()!=null}
            val body=fixture.posted.get()!!;assertEquals(fixture.a,body.getJSONObject("input").getString("conversationId"));assertEquals("Generated explicit A follow-up",body.getJSONObject("input").getString("question"))
            until("Controlled A completion renders"){main{shown().filterIsInstance<TextView>().any{it.text.toString()=="Generated A completed response"}}}
            assertEquals(1,fixture.posts.get());assertEquals("Unrelated B must not be adopted or polled",0,fixture.bPolls.get());picture(scenario,"explicit-A-completed-without-B-adoption")
        }
    }
    @Test fun ownedUnknownBodyAndLaterDraftRemainLockedUntilExplicitTargetCanBeSelected()=fixture{fixture->
        val body=JSONObject().put("id",fixture.runB).put("input",JSONObject().put("question","Generated original owned body").put("conversationId",fixture.b))
        val store=CentralStateFile(File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(fixture.origin)),"ask",context.secretBox())
        store.write(JSONObject().put("pending",body).put("runId",fixture.runB).put("runStatus","running").put("conversationId",fixture.b).put("question","Generated later unsent draft"));fixture.bMissing=true
        open(fixture).use{scenario->
            until("Owned unknown check is exposed"){main{shown().any{it is TextView&&it.text.toString()=="检查结果"}}}
            main{assertFalse(shown().single{it.contentDescription=="发送"}.isEnabled);assertEquals("Generated later unsent draft",shown().filterIsInstance<EditText>().single{it.contentDescription=="你的问题"}.text.toString());shown().filterIsInstance<TextView>().single{it.text.toString()=="检查结果"}.performClick()}
            until("Actual404 on original owned ID"){fixture.bPolls.get()>0}
            CentralDraftWrites.barrier{val state=store.read();assertEquals(body.toString(),state.getJSONObject("pending").toString());assertEquals("Generated later unsent draft",state.getString("question"))}
            scenario.onActivity{assertEquals(fixture.a,it.intent.getStringExtra("conversationId"))};assertEquals(0,fixture.posts.get());picture(scenario,"owned-unknown-keeps-body-draft-and-queued-A")
            main{shown().filterIsInstance<TextView>().single{it.text.toString()=="重试同一请求"}.performClick()}
            until("Explicit retry still uses original body under B"){fixture.posted.get()!=null};assertEquals(body.toString(),fixture.posted.get()!!.toString())
            until("Later draft requires explicit discard before queued A"){main{shown().filterIsInstance<TextView>().any{it.text.toString()=="继续编辑"}}}
            main{shown().filterIsInstance<TextView>().single{it.text.toString()=="继续编辑"}.performClick()}
            until("Continue editing explicitly clears queued target without clearing draft"){var done=false;scenario.onActivity{done=!it.intent.hasExtra("conversationId")};done&&main{shown().filterIsInstance<EditText>().any{it.text.toString()=="Generated later unsent draft"}}};assertEquals(1,fixture.posts.get())
        }
    }
    @Test fun ownerChangeRejectsOldExplicitIntentAndItsLateConversationRead()=fixture{fixture->
        fixture.holdConversation.set(true)
        open(fixture).use{scenario->
            assertTrue(fixture.conversationStarted.await(10,TimeUnit.SECONDS));Settings(context).signIn(fixture.origin,fixture.tokenB,86400000)
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);fixture.release.countDown();scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
            until("New owner access opens B's main conversation"){var ready=false;scenario.onActivity{ready=!it.isWorking&&!it.intent.hasExtra("conversationId")&&it.selectedAskConversationId==fixture.b};ready}
            main { assertFalse(shown().filterIsInstance<TextView>().any { it.text.toString() == "Generated intended A history" }) }
            assertEquals("B credential must never read old target A",0,fixture.aReadsByB.get());assertEquals(0,fixture.posts.get());picture(scenario,"owner-change-rejects-old-explicit-intent")
        }
    }
    private class Fixture:AutoCloseable {
        val a=UUID.randomUUID().toString();val b=UUID.randomUUID().toString();val runB=UUID.randomUUID().toString()
        val tokenA="generated-explicit-conversation-owner-A";val tokenB="generated-explicit-conversation-owner-B"
        private val listener=ServerSocket(0,10,InetAddress.getByName("127.0.0.1"));val origin="http://127.0.0.1:${listener.localPort}"
        val posts=AtomicInteger();val bPolls=AtomicInteger();val aReadsByB=AtomicInteger();val posted=AtomicReference<JSONObject?>();val holdConversation=AtomicBoolean();val conversationStarted=CountDownLatch(1);val release=CountDownLatch(1);@Volatile var bMissing=false
        private val workers=Executors.newCachedThreadPool()
        private fun conversation(id:String)=JSONObject().put("id",id).put("scope",JSONObject()).put("turns",JSONArray().put(JSONObject().put("id",UUID.randomUUID().toString()).put("status","completed").put("question",if(id==a)"Generated intended A history"else"Generated unrelated B history").put("result",JSONObject().put("answer",if(id==a&&posted.get()!=null)"Generated A completed response"else"Generated prior answer").put("citations",JSONArray()))))
        init{workers.submit{while(!listener.isClosed)runCatching{listener.accept()}.getOrNull()?.let{socket->workers.submit{socket.use{
            val input=it.getInputStream().bufferedReader();val first=input.readLine().orEmpty();val path=first.split(' ').getOrElse(1){""};val headers=mutableListOf<String>();while(true){val h=input.readLine();if(h.isNullOrEmpty())break;headers.add(h)}
            val isB=headers.any{h->h.equals("Authorization: Bearer $tokenB",true)};val size=headers.firstOrNull{h->h.startsWith("Content-Length:",true)}?.substringAfter(':')?.trim()?.toInt()?:0;val chars=CharArray(size);var read=0;while(read<size){val n=input.read(chars,read,size-read);if(n<0)break;read+=n}
            val isPost=first.startsWith("POST ");var status="200 OK"
            val body=when{
                path=="/api/query-runs"&&isPost->{posts.incrementAndGet();val value=JSONObject(String(chars));posted.set(value);JSONObject().put("id",value.getString("id")).put("status","completed").put("conversationId",value.getJSONObject("input").optString("conversationId"))}
                path=="/api/query-runs"->JSONObject().put("items",JSONArray().apply{if(!isB)put(JSONObject().put("id",runB).put("status","running").put("conversationId",b))})
                path.startsWith("/api/query-runs/")->{bPolls.incrementAndGet();if(bMissing){status="404 Not Found";JSONObject().put("error","not_found")}else JSONObject().put("id",runB).put("status","running").put("conversationId",b)}
                path == "/api/conversations/main" -> JSONObject().put("id", b)
                path.substringBefore('?') == "/api/conversations/$a" -> {
                    if (isB) aReadsByB.incrementAndGet()
                    else if (holdConversation.compareAndSet(true, false)) {
                        conversationStarted.countDown()
                        check(release.await(20, TimeUnit.SECONDS))
                    }
                    conversation(a)
                }
                path.startsWith("/api/conversations/$b")->conversation(b)
                path.startsWith("/api/model-settings")->JSONObject().put("profiles",JSONArray())
                else->JSONObject().put("items",JSONArray())
            }.toString().toByteArray()
            it.getOutputStream().apply{write("HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray());write(body);flush()}
        }}}}}
        override fun close(){release.countDown();listener.close();workers.shutdownNow()}
    }
}
