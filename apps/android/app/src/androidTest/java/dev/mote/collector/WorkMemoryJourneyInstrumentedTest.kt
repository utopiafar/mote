package dev.mote.collector

import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.EditText
import android.widget.Spinner
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
import java.net.URI
import java.net.URLDecoder
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Activity receipt → exact owner-authorized Memory → original activity. Generated loopback only. */
@RunWith(AndroidJUnit4::class)
class WorkMemoryJourneyInstrumentedTest {
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private val context get()=instrumentation.targetContext
    private fun <T> main(block:()->T):T { val result=AtomicReference<Result<T>>();instrumentation.runOnMainSync{result.set(runCatching(block))};return result.get().getOrThrow() }
    private fun views(view:View):List<View> = listOf(view)+if(view is ViewGroup)(0 until view.childCount).flatMap{views(view.getChildAt(it))}else emptyList()
    private fun shown()=WindowInspector.getGlobalWindowViews().filter{it.isShown&&it.hasWindowFocus()}.flatMap(::views).filter{it.isShown}
    private fun until(label:String,check:()->Boolean){val end=SystemClock.elapsedRealtime()+30_000;while(SystemClock.elapsedRealtime()<end){if(check())return;Thread.sleep(50)};fail(label+"; visible="+main{shown().filterIsInstance<TextView>().joinToString(" | "){it.text.toString().take(100)}})}
    private fun has(value:String)=main{shown().filterIsInstance<TextView>().any{it.text.toString().contains(value)}}
    private fun click(value:String){until("Action $value"){main{shown().any{it.isEnabled&&it.isClickable&&(it.contentDescription==value||(it as? TextView)?.text.toString()==value)}}};main{shown().first{it.isEnabled&&it.isClickable&&(it.contentDescription==value||(it as? TextView)?.text.toString()==value)}.also{it.requestRectangleOnScreen(android.graphics.Rect(0,0,it.width,it.height),true)}.performClick()}}
    private fun tag(value:String){until("Tagged action $value"){main{shown().any{it.tag==value&&it.isEnabled}}};main{shown().single{it.tag==value}.also{it.requestRectangleOnScreen(android.graphics.Rect(0,0,it.width,it.height),true)}.performClick()}}
    private fun physical(view:View) {
        main{view.requestRectangleOnScreen(android.graphics.Rect(0,0,view.width,view.height),true)};Thread.sleep(350)
        val point=main{val p=IntArray(2);view.getLocationOnScreen(p);(p[0]+view.width/2f) to (p[1]+view.height/2f)}
        val t=SystemClock.uptimeMillis();instrumentation.sendPointerSync(android.view.MotionEvent.obtain(t,t,android.view.MotionEvent.ACTION_DOWN,point.first,point.second,0));instrumentation.sendPointerSync(android.view.MotionEvent.obtain(t,t+40,android.view.MotionEvent.ACTION_UP,point.first,point.second,0))
    }
    private fun scrollAndY(view:View):Pair<Int,Int> = main{val p=IntArray(2);view.getLocationOnScreen(p);shown().filterIsInstance<android.widget.ScrollView>().first().scrollY to p[1]}
    private fun bundleStrings(bundle:android.os.Bundle):List<String> = bundle.keySet().flatMap { key->when(val value=bundle.get(key)){is String->listOf(value);is android.os.Bundle->bundleStrings(value);is ArrayList<*>->value.filterIsInstance<String>();else->emptyList()} }
    private fun idle(scenario:ActivityScenario<CentralActivity>) { until("Central is idle"){var ready=false;scenario.onActivity{ready=!it.isWorking};ready} }
    private fun record(name:String){
        instrumentation.waitForIdleSync();until("Focused window $name"){main{WindowInspector.getGlobalWindowViews().any{it.isShown&&it.hasWindowFocus()&&it.width>0&&it.height>0}}}
        main{val root=WindowInspector.getGlobalWindowViews().last{it.isShown&&it.hasWindowFocus()};val bitmap=android.graphics.Bitmap.createBitmap(root.width,root.height,android.graphics.Bitmap.Config.ARGB_8888);try{root.draw(android.graphics.Canvas(bitmap));File(context.filesDir,"work-memory-generated").apply{mkdirs()}.resolve("$name.png").outputStream().use{bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}}finally{bitmap.recycle()}}
    }
    private fun fixture(block:(Fake)->Unit){
        assumeTrue(InstrumentationRegistry.getArguments().getString("generatedWorkMemory") == "true")
        require(context.packageName=="dev.mote.collector.dev"&&Build.FINGERPRINT.contains("emu64a"))
        val settings=Settings(context);val config=settings.read();val before=context.queue().dedupeIds().toSet();require(!settings.enabled&&config.syncMode=="manual"&&config.syncPaused)
        Fake().use{fake->
            try{
                until("Connect generated Activity fixture after background reads finish"){
                    try{ConnectionGuard.change(context,fake.origin,bindLocal=true){settings.saveConnection(fake.origin,fake.token,"Generated activity memory",true);settings.save(settings.read().copy(syncMode="manual",syncPaused=true),confirmCentralEndpoint=true)};true}
                    catch(error:ConnectionFailure){if(error.category=="busy")false else throw error}
                }
                MoteI18n.select(context,"zh-CN");main{MoteAppearance.select(context,AppearancePreference.LIGHT)};block(fake)
                assertEquals("No Activity/Memory browsing writes local records",before,context.queue().dedupeIds().toSet())
            } finally {
                fake.release.countDown();CentralDraftWrites.barrier{};File(context.noBackupFilesDir,"central-native/"+SourceRules.hash(fake.origin)).deleteRecursively()
                settings.save(config,confirmCentralEndpoint=true);CentralSession.get(context).select(config.server)
            }
        }
    }
    private fun openResults(fake:Fake, scenario:ActivityScenario<CentralActivity>){
        until("Activity lists the generated owner work"){has(fake.goal)};idle(scenario)
        main{shown().first{it.isClickable&&it.contentDescription?.toString()?.startsWith(fake.goal)==true}.performClick()}
        until("Activity detail sections load"){main{shown().filterIsInstance<Spinner>().any{it.contentDescription=="工作详情"}}};idle(scenario)
        assertTrue("Overview uses the actual Memory count",has("23 项已保存成果"))
        main{val spinner=shown().filterIsInstance<Spinner>().single{it.contentDescription=="工作详情"};spinner.setSelection((0 until spinner.count).single{spinner.getItemAtPosition(it).toString()=="成果"})}
        until("The work's actual per-Memory results appear"){has(fake.title(fake.ids.first()))};idle(scenario)
        assertTrue("The activity title survives the results refresh",has(fake.goal))
        assertTrue("The section control survives the results refresh",main{shown().filterIsInstance<Spinner>().any{it.contentDescription=="工作详情"}})
        assertTrue("The back control survives the results refresh",has("返回活动"))
    }
    @Test fun exactMemoryPaginationReturnCancellationAndDeletion()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario)
            assertTrue(has(fake.title(fake.ids[19])));assertFalse(has(fake.title(fake.ids[20])))
            val first=fake.ids[19]
            main{shown().single{it.tag=="work-memory:$first"}.also{it.requestRectangleOnScreen(android.graphics.Rect(0,0,it.width,it.height),true)}};Thread.sleep(500);instrumentation.waitForIdleSync()
            fun position():Pair<Int,Int> = main { val row=shown().single{it.tag=="work-memory:$first"};val location=IntArray(2);row.getLocationOnScreen(location);shown().filterIsInstance<android.widget.ScrollView>().first().scrollY to location[1] }
            val before=position();tag("work-memory:$first");until("Exact first-page Memory opens"){has(fake.statement(first))};assertFalse(has(fake.statement(fake.ids[18])));record("memory-first-page")
            click("查看原文依据 1");until("The selected Memory's exact original opens"){has("Generated exact Memory evidence")};scenario.onActivity{it.onBackPressed()};until("Original returns to the same Memory"){has(fake.statement(first))}
            click("删除记忆");until("Delete confirmation") { has("删除后无法恢复。") };click("取消");until("Cancellation returns to the same Memory"){has(fake.statement(first))};assertEquals(0,fake.deletes.get())
            scenario.onActivity{it.onBackPressed()};until("Same work and first result page return"){has(fake.goal)&&has(fake.title(first))};Thread.sleep(500);instrumentation.waitForIdleSync();assertEquals("Same result scroll returns",before.first,position().first);assertTrue("Same result row returns to the same screen position",kotlin.math.abs(before.second-position().second)<=2);assertFalse(has(fake.title(fake.ids[20])))
            click("下一页");until("Only the remaining Memory results appear"){has(fake.title(fake.ids[20]))&&has(fake.title(fake.ids.last()))};assertFalse(has(fake.title(fake.ids.first())))
            val second=fake.ids[20];tag("work-memory:$second");until("Exact second-page Memory opens"){has(fake.statement(second))}
            click("删除记忆");until("Delete confirmation") { has("删除后无法恢复。") };click("确认");until("Deleted result disappears from the same activity page"){fake.deletes.get()==1&&has(fake.goal)&&!has(fake.title(second))&&has(fake.title(fake.ids.last()))};record("memory-second-page-after-delete")
            main{shown().filterIsInstance<Spinner>().single{it.contentDescription=="工作详情"}.setSelection(0)};until("Overview reflects the deletion"){has("22 项已保存成果")}
            assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
        }
    }
    @Test fun removedResultWithdrawsFromTheOpenCompletedResultsList()=fixture{fake->
        // The generated work is completed: its results list keeps a slower withdrawal read so a
        // Memory removed on another device disappears without any owner action.
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];assertTrue(has(fake.title(id)));idle(scenario)
            fake.removed.add(id)
            // The detail rebuilds while its results read is still in flight: assert the removed
            // row is gone only after the surviving row is present in the same refreshed view.
            until("A removed Memory withdraws its results row while the completed work stays open"){!has(fake.title(id))&&has(fake.title(fake.ids[4]))&&has(fake.goal)}
            tag("work-memory:"+fake.ids[4]);until("A surviving result still opens"){has(fake.statement(fake.ids[4]))}
            assertEquals(0,fake.deletes.get());assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
        }
    }
    @Test fun removedResultCannotOpenFromAnAlreadyRenderedRow()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];val old=main{shown().single{it.tag=="work-memory:$id"}};fake.removed.add(id)
            main{old.performClick()};until("The removed result is explicitly unavailable"){has("请求的资源不存在或已删除。")};assertFalse(has(fake.statement(id)));assertEquals(0,fake.deletes.get())
            click("返回活动");until("The refreshed activity contains no removed result"){has(fake.goal)&&!has(fake.title(id))&&has(fake.title(fake.ids.first()))};assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
        }
    }
    @Test fun cancellationAndLateResponseCannotOpenAnOldMemory()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];fake.holdMemory=id;tag("work-memory:$id");assertTrue("The owner read is actually held",fake.entered.await(5,TimeUnit.SECONDS))
            scenario.onActivity{it.onBackPressed()};fake.release.countDown();until("Cancellation returns to the work list"){has(fake.goal)&&!has(fake.statement(id))};Thread.sleep(1000);instrumentation.waitForIdleSync();assertFalse(has(fake.statement(id)));assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
        }
    }
    @Test fun withdrawnOwnerAccessHidesThePreviouslyOpenMemory()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Initially authorized Memory opens"){has(fake.statement(id))};idle(scenario);main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated local correction")};fake.forbidden=true
            until("A revoked owner read withdraws the open Memory"){has("当前连接没有执行此操作的权限")&&!has(fake.statement(id))};assertFalse(has(fake.title(id)));assertEquals(0,fake.deletes.get());assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
            assertTrue(has("Generated local correction"));assertFalse(has("保存校正"))
        }
    }
    @Test fun signOutWhileMemoryReadIsHeldCannotOpenThePreviousOwnerResult()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];fake.holdMemory=id;tag("work-memory:$id");assertTrue("The owner read is actually held",fake.entered.await(5,TimeUnit.SECONDS))
            Settings(context).signOut();fake.release.countDown();until("Signing out withdraws the old Activity and Memory"){has("登录并继续")&&!has(fake.statement(id))&&!has(fake.title(id))}
            assertEquals(0,fake.deletes.get());assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
        }
    }
    @Test fun temporaryFailuresPreserveTheCorrectScreenAndCanRetry()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];fake.failMemory.set(true);tag("work-memory:$id")
            until("A temporary Memory failure is truthful"){has("中央服务暂不可用（503）")};assertFalse(has("请求的资源不存在或已删除。"));assertTrue(has(fake.goal))
            tag("work-memory:$id");until("Retry opens the same exact Memory"){has(fake.statement(id))};idle(scenario)
            fake.failCapture.set(true);click("查看原文依据 1");until("A temporary original failure preserves the Memory"){has("中央服务暂不可用（503）")};assertTrue(has(fake.statement(id)));assertFalse(has("请求的资源不存在或已删除。"))
            click("查看原文依据 1");until("Retry opens the same original"){has("Generated exact Memory evidence")};assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
        }
    }
    @Test fun changedEvidenceCannotOpenAndOnlyUserEditsSurvive()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated local correction")}
            fake.swapEvidence=true;click("查看原文依据 1")
            until("Changed evidence withdraws the old Memory"){has("请求的资源不存在或已删除。")&&has("有未保存的更改")}
            assertTrue(has("Generated local correction"));assertFalse(has(fake.statement(id)));assertFalse(has(fake.title(id)));assertFalse(has("保存校正"));assertFalse(has("Generated exact Memory evidence"));assertEquals(0,fake.captureReads.get())
        }
    }
    @Test fun changedStatementAtTheSameVersionIsNotTreatedAsTheOriginal()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            fake.mutateStatement=true;click("查看原文依据 1")
            until("Changed text withdraws the old Memory"){has("请求的资源不存在或已删除。")&&!has(fake.statement(id))}
            assertFalse(has("Generated exact Memory evidence"));assertEquals(0,fake.captureReads.get())
        }
    }
    @Test fun noteOriginalPhysicalReturnPreservesMemoryAndActivityPositions()=fixture{fake->
        fake.source="note"
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[19];val row=main{shown().single{it.tag=="work-memory:$id"}}
            main{row.requestRectangleOnScreen(android.graphics.Rect(0,0,row.width,row.height),true)};Thread.sleep(400);val workPosition=scrollAndY(row);physical(row)
            until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            val button=main{shown().filterIsInstance<TextView>().single{it.text.toString()=="查看原文依据 1"}}
            main{button.requestRectangleOnScreen(android.graphics.Rect(0,0,button.width,button.height),true)};Thread.sleep(400);val memoryPosition=scrollAndY(button);physical(button)
            until("Independent note original opens"){has("Generated exact Memory evidence")};record("independent-note-original")
            instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            until("Back revalidates and returns the exact Memory"){has(fake.statement(id))};Thread.sleep(400);val afterMemory=scrollAndY(main{shown().filterIsInstance<TextView>().single{it.text.toString()=="查看原文依据 1"}})
            assertEquals("Memory scroll",memoryPosition.first,afterMemory.first);assertTrue("Memory evidence screen position",kotlin.math.abs(memoryPosition.second-afterMemory.second)<=2)
            scenario.onActivity{it.onBackPressed()};until("Back returns the same activity results"){has(fake.goal)&&has(fake.title(id))};Thread.sleep(400);val afterWork=scrollAndY(main{shown().single{it.tag=="work-memory:$id"}})
            assertEquals("Activity scroll",workPosition.first,afterWork.first);assertTrue("Activity result screen position",kotlin.math.abs(workPosition.second-afterWork.second)<=2)
            File(context.filesDir,"work-memory-generated").apply{mkdirs()}.resolve("note-position.json").writeText(JSONObject().put("activityScrollBefore",workPosition.first).put("activityRowYBefore",workPosition.second).put("activityScrollAfter",afterWork.first).put("activityRowYAfter",afterWork.second).put("memoryScrollBefore",memoryPosition.first).put("memoryButtonYBefore",memoryPosition.second).put("memoryScrollAfter",afterMemory.first).put("memoryButtonYAfter",afterMemory.second).toString(2))
            assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get());record("independent-note-return")
        }
    }
    @Test fun removedMembershipDuringIndependentNoteReadNeverShowsOriginal()=fixture{fake->
        fake.source="note";fake.holdCapture=2
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};click("查看原文依据 1")
            assertTrue("The independent reader's actual note GET is held",fake.captureEntered.await(10,TimeUnit.SECONDS));fake.removed.add(id);fake.captureRelease.countDown()
            until("The independent reader rejects the removed result"){has("请求的资源不存在或已删除。")} ;assertFalse(has("Generated exact Memory evidence"))
            instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            until("Returning withdraws the old Memory"){has("请求的资源不存在或已删除。")&&!has(fake.statement(id))};assertFalse(has(fake.title(id)));assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
        }
    }
    @Test fun ownerRevokedDuringIndependentNoteReadNeverShowsOriginal()=fixture{fake->
        fake.source="note";fake.holdCapture=2
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};click("查看原文依据 1")
            assertTrue("The independent reader's actual note GET is held",fake.captureEntered.await(10,TimeUnit.SECONDS));fake.forbidden=true;fake.captureRelease.countDown()
            until("The independent reader reports the authorization failure"){has("当前连接没有执行此操作的权限")};assertFalse(has("Generated exact Memory evidence"))
            instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            until("Returning withdraws the old Memory"){has("当前连接没有执行此操作的权限")&&!has(fake.statement(id))};assertFalse(has(fake.title(id)));assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
        }
    }
    @Test fun ownerRevokedDuringFileOriginalReadWithdrawsMemoryAndKeepsEdits()=fixture{fake->
        fake.holdCapture=1
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated local correction")};click("查看原文依据 1")
            assertTrue("The file original GET is held",fake.captureEntered.await(10,TimeUnit.SECONDS));fake.forbidden=true;fake.captureRelease.countDown()
            until("A revoked owner withdraws the old Memory immediately"){has("当前连接没有执行此操作的权限")&&!has(fake.statement(id))&&has("Generated local correction")}
            assertFalse(has(fake.title(id)));assertFalse(has("Generated exact Memory evidence"));assertFalse(has("保存校正"));assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
        }
    }
    @Test fun fileOriginalReturnsTheSameMemoryAndUnsentEdits()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated unsent correction")};click("查看原文依据 1")
            until("File original opens"){has("Generated exact Memory evidence")};scenario.onActivity{it.onBackPressed()}
            until("Same Memory and unsent edit return"){has(fake.statement(id))&&has("Generated unsent correction")};assertEquals(0,fake.corrections.get());assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
        }
    }
    @Test fun fileReturnAfterRemovalWithdrawsOldTextAndKeepsOnlyEdits()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated unsent correction")};click("查看原文依据 1")
            until("File original opens"){has("Generated exact Memory evidence")};fake.removed.add(id);scenario.onActivity{it.onBackPressed()}
            until("Removed Memory withdraws old text but retains the edit"){has("请求的资源不存在或已删除。")&&has("Generated unsent correction")};assertFalse(has(fake.statement(id)));assertFalse(has(fake.title(id)));assertFalse(has("保存校正"));assertEquals(0,fake.corrections.get())
        }
    }
    @Test fun signOutWhileFileOriginalIsOpenCannotRestoreTheOldOwnerViews()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated prior-owner edit")};click("查看原文依据 1");until("File original opens"){has("Generated exact Memory evidence")}
            Settings(context).signOut();until("Sign out shows the login screen"){has("登录并继续")&&!has("Generated exact Memory evidence")};scenario.onActivity{it.onBackPressed()};Thread.sleep(300)
            assertFalse(has(fake.statement(id)));assertFalse(has("Generated prior-owner edit"))
        }
        Settings(context).saveConnection(fake.origin,fake.token,"Generated activity memory",true)
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{until("New session opens a fresh work list"){has(fake.goal)};assertFalse(has(fake.statement(fake.ids[3])));assertFalse(has("Generated prior-owner edit"))}
    }
    @Test fun clearingNodeWhileFileOriginalIsOpenShowsDisconnectedPage()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};click("查看原文依据 1");until("File original opens"){has("Generated exact Memory evidence")}
            val settings=Settings(context);settings.save(settings.read().copy(server="",token=""),confirmCentralEndpoint=true)
            until("Clearing the node shows the disconnected page"){has("中央功能需要连接中央")&&!has("Generated exact Memory evidence")};scenario.onActivity{it.onBackPressed()};Thread.sleep(300);assertFalse(has(fake.statement(id)))
        }
    }
    @Test fun temporaryFailureReturningFromNotePreservesOnlyEditsAndOffersRetry()=fixture{fake->
        fake.source="note"
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated pending correction")}
            click("查看原文依据 1");until("Independent note opens"){has("Generated exact Memory evidence")};fake.failPage.set(true)
            instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            until("Return failure gives a retry without old remote content"){has("中央服务暂不可用（503）")&&has("Generated pending correction")}
            assertFalse(has(fake.statement(id)));assertFalse(has(fake.title(id)));assertFalse(has("保存校正"));assertFalse(has("请求的资源不存在或已删除。"))
            click("重试");until("Retry restores the same verified Memory and local edit"){has(fake.statement(id))&&has("Generated pending correction")};assertTrue(has("保存校正"))
        }
    }
    @Test fun newSessionDuringIndependentNoteReadCannotReuseTheOldClick()=fixture{fake->
        fake.source="note";fake.holdCapture=2
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};click("查看原文依据 1")
            assertTrue("The independent reader's actual note GET is held",fake.captureEntered.await(10,TimeUnit.SECONDS))
            val settings=Settings(context);settings.signOut();CentralAccess.resolve(context);settings.saveConnection(fake.origin,fake.token,"Generated activity memory",true);CentralAccess.resolve(context);fake.captureRelease.countDown()
            until("A new same-node session rejects the old click"){has("登录会话已变更，请重新打开中央页面。")} ;assertFalse(has("Generated exact Memory evidence"))
            instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            until("The new session does not re-open the old Memory"){has(fake.goal)&&!has(fake.statement(id))};assertFalse(has(fake.title(id)))
        }
    }
    @Test fun backingOutDuringHeldReaderReturnNeverRevealsOldMemory()=fixture{fake->
        fake.source="note"
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};click("查看原文依据 1");until("Independent note opens"){has("Generated exact Memory evidence")}
            fake.holdPage.set(true);instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            assertTrue("The return membership check is held",fake.pageEntered.await(10,TimeUnit.SECONDS));assertFalse(has(fake.statement(id)))
            scenario.onActivity{it.onBackPressed()};assertFalse(has(fake.statement(id)));fake.pageRelease.countDown()
            until("The result page remains visible after the old response"){has(fake.goal)&&has(fake.title(id))&&!has(fake.statement(id))}
        }
    }
    @Test fun pausingDuringReaderReturnResumesVerificationAndPreservesEdits()=fixture{fake->
        fake.source="note"
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated paused edit")};click("查看原文依据 1");until("Independent note opens"){has("Generated exact Memory evidence")}
            fake.holdPage.set(true);instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            assertTrue("The return membership check is held",fake.pageEntered.await(10,TimeUnit.SECONDS));assertFalse(has(fake.statement(id)))
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.STARTED);fake.pageRelease.countDown();Thread.sleep(400);scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
            until("Resume revalidates and restores the Memory and edit"){has(fake.statement(id))&&has("Generated paused edit")};assertEquals(0,fake.corrections.get())
        }
    }
    @Test fun removedResultBeforeDeleteConfirmationCannotWrite()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};click("删除记忆");until("Delete confirmation opens"){has("删除后无法恢复。")}
            fake.removed.add(id);click("确认");until("A removed result cannot be deleted from the old screen"){has("请求的资源不存在或已删除。")&&!has(fake.statement(id))};assertEquals(0,fake.deletes.get())
        }
    }
    @Test fun correctionRevalidatesAndReturnsToTheSameWork()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated correction")};click("保存校正")
            until("Successful correction returns to the same work"){fake.corrections.get()==1&&has(fake.goal)&&has(fake.title(id))};assertEquals(0,fake.queryWrites.get());assertEquals(0,fake.captureWrites.get())
        }
    }
    @Test fun removedResultBeforeCorrectionCannotWrite()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated correction")};fake.removed.add(id);click("保存校正")
            until("A removed result cannot be corrected from the old screen"){has("请求的资源不存在或已删除。")&&has("Generated correction")};assertEquals(0,fake.corrections.get());assertFalse(has(fake.statement(id)))
        }
    }
    @Test fun leavingDuringDeleteVerificationCannotSendTheOldWrite()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};click("删除记忆");until("Delete confirmation opens"){has("删除后无法恢复。")}
            fake.holdPage.set(true);click("确认");assertTrue("The delete membership read is held",fake.pageEntered.await(10,TimeUnit.SECONDS));scenario.onActivity{it.navigate("overview")};fake.pageRelease.countDown()
            until("The new page becomes idle"){var ready=false;scenario.onActivity{ready=!it.isWorking};ready};assertEquals("Leaving before the guarded write sends no DELETE",0,fake.deletes.get());assertFalse(has(fake.statement(id)))
        }
    }
    @Test fun leavingDuringCorrectionVerificationCannotSendTheOldWrite()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated correction")};fake.holdPage.set(true);click("保存校正")
            assertTrue("The correction membership read is held",fake.pageEntered.await(10,TimeUnit.SECONDS));scenario.onActivity{it.navigate("overview")};fake.pageRelease.countDown()
            until("The new page becomes idle"){var ready=false;scenario.onActivity{ready=!it.isWorking};ready};assertEquals("Leaving before the guarded write sends no correction",0,fake.corrections.get());assertFalse(has(fake.statement(id)))
        }
    }
    @Test fun signingOutDuringDeleteVerificationCannotSendTheOldWrite()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};click("删除记忆");until("Delete confirmation opens"){has("删除后无法恢复。")}
            fake.holdPage.set(true);click("确认");assertTrue("The delete membership read is held",fake.pageEntered.await(10,TimeUnit.SECONDS));Settings(context).signOut();CentralAccess.resolve(context);fake.pageRelease.countDown()
            until("Signed-out view is visible"){has("登录并继续")};assertEquals("A superseded session sends no DELETE",0,fake.deletes.get());assertFalse(has(fake.statement(id)))
        }
    }
    @Test fun sameSessionRecreationRestoresTheExactPageAndNewSessionDoesNot()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);click("下一页");until("Second page opens"){has(fake.title(fake.ids.last()))&&!has(fake.title(fake.ids.first()))};scenario.recreate()
            until("Same session restores the second page"){has(fake.title(fake.ids.last()))&&!has(fake.title(fake.ids.first()))};val id=fake.ids[20];tag("work-memory:$id");until("Selected Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated retained recreation edit")}
            val app=context.applicationContext as android.app.Application;val state=AtomicReference<android.os.Bundle>()
            val callback=object:android.app.Application.ActivityLifecycleCallbacks {
                override fun onActivitySaveInstanceState(activity:android.app.Activity,out:android.os.Bundle){if(activity is CentralActivity)state.set(android.os.Bundle(out))}
                override fun onActivityCreated(activity:android.app.Activity,out:android.os.Bundle?)=Unit;override fun onActivityStarted(activity:android.app.Activity)=Unit;override fun onActivityResumed(activity:android.app.Activity)=Unit;override fun onActivityPaused(activity:android.app.Activity)=Unit;override fun onActivityStopped(activity:android.app.Activity)=Unit;override fun onActivityDestroyed(activity:android.app.Activity)=Unit
            }
            app.registerActivityLifecycleCallbacks(callback);try{scenario.recreate()}finally{app.unregisterActivityLifecycleCallbacks(callback)}
            assertNotNull(state.get());assertFalse("User text is never placed in saved state",bundleStrings(state.get()).any{it.contains("Generated retained recreation edit")})
            until("Same session revalidates and restores the same Memory and edit"){has(fake.statement(id))&&has("Generated retained recreation edit")}
            val settings=Settings(context);settings.signOut();CentralAccess.resolve(context);settings.saveConnection(fake.origin,fake.token,"Generated activity memory",true);CentralAccess.resolve(context)
            scenario.recreate();until("A new session does not replay the old Memory"){has(fake.goal)&&!has(fake.statement(id))};assertFalse(has(fake.title(id)));assertFalse(has("Generated retained recreation edit"))
        }
    }
    @Test fun changedMemoryOnRecreationRetainsOnlyTheUserEdit()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated retained recreation edit")};fake.mutateStatement=true;scenario.recreate()
            until("Changed remote Memory is withdrawn but the user edit survives"){has("请求的资源不存在或已删除。")&&has("Generated retained recreation edit")}
            assertFalse(has(fake.statement(id)));assertFalse(has(fake.title(id)));assertFalse(has("保存校正"));assertEquals(0,fake.corrections.get())
        }
    }
    @Test fun recreatedMemoryTemporaryFailureOffersRetryAndRetainsEdit()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated pending recreation edit")};fake.failMemory.set(true);scenario.recreate()
            until("A recreated Memory offers retry while keeping only the edit"){has("中央服务暂不可用（503）")&&has("Generated pending recreation edit")&&has("重试")};assertFalse(has(fake.statement(id)));assertFalse(has(fake.title(id)));assertFalse(has("保存校正"))
            click("重试");until("Retry verifies and restores the Memory and edit"){has(fake.statement(id))&&has("Generated pending recreation edit")};assertTrue(has("保存校正"));assertEquals(0,fake.corrections.get())
        }
    }
    @Test fun intentionallyEmptyEditSurvivesRepeatedInvalidatedRecreation()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("")};fake.mutateStatement=true;scenario.recreate()
            fun emptyEdit()=main{shown().filterIsInstance<EditText>().singleOrNull{(it.tag as? MemoryTopicEdit)?.key=="statement"}?.text.toString()==""}
            until("The cleared edit is retained when the Memory changes"){has("有未保存的更改")&&emptyEdit()&&!has(fake.statement(id))};scenario.recreate()
            until("The cleared edit survives a second recreation"){has("有未保存的更改")&&emptyEdit()&&!has(fake.statement(id))}
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.key=="statement"}.setText("\u0000")};scenario.recreate()
            until("A NUL edit also survives recreation"){has("有未保存的更改")&&main{shown().filterIsInstance<EditText>().singleOrNull{(it.tag as? MemoryTopicEdit)?.key=="statement"}?.text.toString()=="\u0000"}};assertFalse(has("保存校正"));assertEquals(0,fake.corrections.get())
        }
    }
    @Test fun fileReaderRecreationRestoresOnlyTheSameAuthorizedMemoryAndEdit()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated file recreation edit")};click("查看原文依据 1");until("File original opens"){has("Generated exact Memory evidence")};scenario.recreate()
            until("Recreation revalidates the Memory and retains its edit"){has(fake.statement(id))&&has("Generated file recreation edit")};assertFalse(has("Generated exact Memory evidence"));assertEquals(0,fake.corrections.get())
        }
    }
    @Test fun anotherNodeAfterRecreationCannotReceiveTheOldEdit()=fixture{fake->
        ActivityScenario.launch<CentralActivity>(Intent(context,CentralActivity::class.java).putExtra("page","activity")).use{scenario->
            openResults(fake,scenario);val id=fake.ids[3];tag("work-memory:$id");until("Exact Memory opens"){has(fake.statement(id))};idle(scenario)
            main{shown().filterIsInstance<EditText>().single{(it.tag as? MemoryTopicEdit)?.label=="陈述"}.setText("Generated prior-node edit")}
            Settings(context).saveConnection("http://127.0.0.1:1","generated-other-node-owner-token-1234567890","Generated other node",true);CentralAccess.resolve(context);scenario.recreate()
            until("The other node cannot show the old Memory"){!has(fake.statement(id))&&!has(fake.title(id))&&!has("Generated prior-node edit")};Thread.sleep(1200);assertFalse(has("Generated prior-node edit"));assertEquals(0,fake.corrections.get())
        }
    }
    private class Fake:AutoCloseable{
        val token="generated-work-memory-owner-token";val workId="memory:"+UUID.randomUUID();val evidenceId=UUID.randomUUID().toString();val otherEvidence=UUID.randomUUID().toString();val goal="Generated activity memory work";val ids=List(23){UUID.randomUUID().toString()}.sorted();val removed=java.util.concurrent.ConcurrentHashMap.newKeySet<String>();val deletes=AtomicInteger();val corrections=AtomicInteger();val queryWrites=AtomicInteger();val captureWrites=AtomicInteger();val entered=CountDownLatch(1);val release=CountDownLatch(1);val captureEntered=CountDownLatch(1);val captureRelease=CountDownLatch(1);val pageEntered=CountDownLatch(1);val pageRelease=CountDownLatch(1);val captureReads=AtomicInteger();val failMemory=AtomicBoolean();val failCapture=AtomicBoolean();val failPage=AtomicBoolean();val holdPage=AtomicBoolean();@Volatile var holdMemory:String?=null;@Volatile var holdCapture=0;@Volatile var forbidden=false;@Volatile var source="file";@Volatile var mutateStatement=false;@Volatile var swapEvidence=false
        private val listener=ServerSocket(0,10,InetAddress.getByName("127.0.0.1"));val origin="http://127.0.0.1:${listener.localPort}";private val workers=Executors.newCachedThreadPool()
        fun title(id:String)="Generated memory "+(ids.indexOf(id)+1).toString().padStart(2,'0')
        fun statement(id:String)="Generated exact statement "+(ids.indexOf(id)+1).toString().padStart(2,'0')
        private fun work()=JSONObject().put("id",workId).put("kind","memory").put("goal",goal).put("state","completed").put("updatedAt","2026-10-30T00:00:00Z").put("progress",JSONObject().put("mode","semantic").put("stage","finished")).put("branchCounts",JSONObject().put("total",0).put("running",0).put("completed",0)).put("branches",JSONArray()).put("branchesNextCursor",JSONObject.NULL).put("artifacts",JSONArray().put(JSONObject().put("id","aggregate").put("kind","memory").put("count",ids.size-removed.size).put("title","Generated saved Memory aggregate").put("ref","memories"))).put("evidence",JSONObject().put("count",0).put("refs",JSONArray())).put("events",JSONArray()).put("destination","memories").put("technical",JSONObject().put("operationIds",JSONArray()))
        private fun memory(id:String)=JSONObject().put("id",id).put("title",title(id)).put("statement",statement(id)+(if(mutateStatement)" changed" else "")).put("uncertainty","").put("status","published").put("version",1).put("fingerprint","a".repeat(64)).put("evidenceIds",JSONArray().put(if(swapEvidence)otherEvidence else evidenceId))
        init{workers.submit{while(!listener.isClosed)runCatching{listener.accept()}.getOrNull()?.let{socket->workers.submit{socket.use{
            val input=it.getInputStream().bufferedReader();val first=input.readLine().orEmpty();val headers=mutableListOf<String>();while(true){val line=input.readLine();if(line.isNullOrEmpty())break;headers.add(line)}
            val length=headers.firstOrNull{line->line.startsWith("Content-Length:",true)}?.substringAfter(':')?.trim()?.toInt()?:0;val body=CharArray(length);var read=0;while(read<length){val count=input.read(body,read,length-read);if(count<0)break;read+=count}
            val parts=first.split(' ');val method=parts.firstOrNull().orEmpty();val uri=URI(parts.getOrElse(1){"/"});val path=uri.path;val params=uri.rawQuery.orEmpty().split('&').filter{pair->pair.contains('=')}.associate{pair->URLDecoder.decode(pair.substringBefore('='),"UTF-8") to URLDecoder.decode(pair.substringAfter('='),"UTF-8")}
            if(method=="POST"&&path.startsWith("/api/query"))queryWrites.incrementAndGet();if(method=="POST"&&path=="/api/captures")captureWrites.incrementAndGet()
            var status="200 OK";val response=when{
                forbidden||headers.none{line->line.equals("Authorization: Bearer $token",true)}->{status="403 Forbidden";JSONObject().put("error","forbidden")}
                path=="/api/work-activity"->JSONObject().put("items",JSONArray().put(work())).put("nextCursor",JSONObject.NULL)
                path=="/api/work-activity/$workId/memory-results"->{if(holdPage.compareAndSet(true,false)){pageEntered.countDown();pageRelease.await(15,TimeUnit.SECONDS)};if(failPage.compareAndSet(true,false)){status="503 Service Unavailable";JSONObject()}else{val available=ids.filterNot{it in removed};val cursor=params["cursor"];val page=available.filter{cursor==null||it>cursor}.take(20);JSONObject().put("ids",JSONArray(page)).put("total",available.size).put("nextCursor",if(available.count{cursor==null||it>cursor}>page.size)page.last()else JSONObject.NULL)}}
                path=="/api/work-activity/$workId"->work()
                path=="/api/capture-browser/$evidenceId"->{val n=captureReads.incrementAndGet();if(n==holdCapture){captureEntered.countDown();captureRelease.await(15,TimeUnit.SECONDS)};if(failCapture.compareAndSet(true,false)){status="503 Service Unavailable";JSONObject()}else JSONObject().put("id",evidenceId).put("source",source).put("deviceId","generated-device").put("libraryVersion","generated-version").put("appName","Generated evidence").put("capturedAt","2026-10-30T00:00:00Z").put("ocrText","Generated exact Memory evidence").put("metadata",JSONObject())}
                method=="POST" && path.startsWith("/api/memories/") && path.endsWith("/correct")->{corrections.incrementAndGet();JSONObject().put("id",UUID.randomUUID().toString())}
                path.startsWith("/api/memories/")->{val id=path.substringAfterLast('/');if(method=="GET"&&holdMemory==id){entered.countDown();release.await(15,TimeUnit.SECONDS)};if(method=="GET"&&failMemory.compareAndSet(true,false)){status="503 Service Unavailable";JSONObject()}else if(method=="DELETE"&&id in ids){removed.add(id);deletes.incrementAndGet();JSONObject().put("externalErase","acknowledged").put("physicalEraseVerified",true)}else if(id in ids&&id !in removed)memory(id)else{status="404 Not Found";JSONObject().put("error","not_found")}}
                else->JSONObject().put("items",JSONArray())
            };val bytes=response.toString().toByteArray();it.getOutputStream().apply{write("HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray());write(bytes);flush()}
        }}}}}
        override fun close(){release.countDown();captureRelease.countDown();pageRelease.countDown();listener.close();workers.shutdownNow()}
    }
}
