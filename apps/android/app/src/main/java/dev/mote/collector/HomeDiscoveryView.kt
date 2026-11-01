package dev.mote.collector

import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Existing archived results only. This independent read never generates a report. */
internal class HomeDiscoveryView(private val activity: MoteActivity, private val present: (Boolean) -> Unit = {}, private val open: (String?) -> Unit) : LinearLayout(activity), HomeSection {
    private val task=UiTask(activity)
    private val gate=HomeReadGate()
    private var closed=false
    private var active=false
    private var denied=false
    private var rendered=""
    init { orientation=VERTICAL;visibility=View.GONE;tag="home-existing-discovery" }
    private fun clear(){removeAllViews();rendered="";visibility=View.GONE;present(false)}
    override fun pause(){active=false;gate.wake();clear()}
    override fun close(){closed=true;pause();task.close()}
    override fun refresh(){
        if(closed)return
        active=true
        val access=runCatching{CentralAccess.resolve(activity)}.getOrNull()
        if(access==null){gate.invalidate();clear();return}
        if(gate.adopt(access.generation,access.server)){denied=false;clear()}
        if(access.client==null){denied=false;clear();return}
        // pause() cleared the denied affordance while the gate kept its stop; re-render it instead of reading.
        if(denied){denied();return}
        val stamp=if(task.busy||!gate.due(SystemClock.elapsedRealtime()))return else gate.begin(SystemClock.elapsedRealtime())
        task.start("",{}, {
            val page=access.client.get("/api/insights?limit=30")
            val after=CentralAccess.resolve(activity)
            check(after.generation==access.generation&&after.server==access.server&&after.client!=null)
            InsightPresentation.featured(page.getJSONArray("items"))
        }){outcome->
            if(closed||!active||!gate.current(stamp)||activity.isDestroyed||activity.isFinishing)return@start
            val selected=runCatching{CentralAccess.resolve(activity)}.getOrNull()
            if(selected==null||selected.generation!=access.generation||selected.server!=access.server||selected.client==null){clear();gate.invalidate();return@start}
            val now=SystemClock.elapsedRealtime()
            outcome.onSuccess{gate.success(now)}.onFailure{gate.failure(now,(it as? CentralFailure)?.status)}
            val finding=outcome.getOrNull()
            if(finding==null){
                // A revoked read offers an explicit retry that re-arms the gate; a transient failure stays hidden and auto-retries.
                denied=(outcome.exceptionOrNull() as? CentralFailure)?.status in setOf(401,403)
                if(denied)denied()else clear()
                return@start
            }
            denied=false
            if(rendered==finding.toString())return@start
            clear();rendered=finding.toString()
            val id=requireNotNull(InsightPresentation.id(finding))
            fun current()=active&&!closed&&gate.current(stamp)&&runCatching{CentralAccess.resolve(activity).let{it.client!=null&&it.generation==access.generation&&it.server==access.server}}.getOrDefault(false)
            val heading=LinearLayout(activity).apply{gravity=Gravity.CENTER_VERTICAL}
            heading.addView(label(MoteI18n.text("最近结果"),NativeFontRole.META).apply{MoteUi.type(this,12)},LayoutParams(0,-2,1f))
            heading.addView(MoteUi.action(android.widget.Button(activity).apply{text=MoteI18n.text("发现历史");tag="home-discovery-history";setOnClickListener{if(current())open(null)}},MoteUi.ButtonRole.TEXT).apply{MoteUi.type(this,10);MoteUi.textColor(this,NativeColorRole.MUTED)})
            addView(heading)
            val card=LinearLayout(activity).apply{
                orientation=VERTICAL;setPadding(activity.moteDp(19),activity.moteDp(19),activity.moteDp(19),activity.moteDp(19));background=MoteUi.clickable(activity,NativeColorRole.SURFACE,7,true)
                tag="home-discovery:$id";isFocusable=true;setOnClickListener{if(current())open(id)}
            }
            val whenText=finding.optString("createdAt").ifBlank{finding.optJSONObject("artifact")?.optString("createdAt").orEmpty()}
            val date=runCatching{DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(MoteI18n.locale()).withZone(ZoneId.systemDefault()).format(Instant.parse(whenText))}.getOrDefault(whenText)
            card.addView(label(MoteI18n.text("发现")+" · "+date,NativeFontRole.META))
            card.addView(label(InsightPresentation.title(finding),NativeFontRole.SECTION).apply{MoteUi.type(this,17);NativePresentationStyles.bind(this,"home-result-title"){(it as TextView).apply{typeface=android.graphics.Typeface.create(android.graphics.Typeface.create(MoteTheme.fontFamily(false),android.graphics.Typeface.NORMAL),500,false);setLineSpacing(0f,1.7f)}}})
            val formatted=JSONObject(finding.toString()).put("answer",NativeAnswerPresentation.format(finding.optString("answer"),emptyList()).text)
            card.addView(label(InsightPresentation.preview(formatted),NativeFontRole.SUPPORT))
            card.addView(label(MoteI18n.text("查看结果与依据 →"),NativeFontRole.ACTION).apply{MoteUi.textColor(this,NativeColorRole.ACCENT)})
            addView(card,LayoutParams(-1,-2).apply{bottomMargin=activity.moteDp(26)});visibility=View.VISIBLE;present(true)
        }
    }
    private fun denied(){clear();visibility=View.VISIBLE;rendered="denied";label(MoteI18n.text("暂不可读取"),NativeFontRole.META).also{addView(it)};addView(TextView(activity).apply{text=MoteI18n.text("重试");MoteUi.type(this,11);MoteUi.textColor(this,NativeColorRole.ACCENT);setPadding(0,activity.moteDp(5),0,activity.moteDp(5));isClickable=true;isFocusable=true;setOnClickListener{if(active&&!closed){denied=false;gate.retry();refresh()}}})}
    private fun label(value:String,role:NativeFontRole)=TextView(activity).apply{text=value;MoteUi.type(this,when(role){NativeFontRole.META->10;NativeFontRole.SUPPORT->12;NativeFontRole.ACTION->11;else->role.size()});MoteUi.textColor(this,if(role==NativeFontRole.META||role==NativeFontRole.SUPPORT)NativeColorRole.MUTED else NativeColorRole.INK);setPadding(0,activity.moteDp(5),0,activity.moteDp(5))}
}
