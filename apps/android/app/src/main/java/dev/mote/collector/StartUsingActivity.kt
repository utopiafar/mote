package dev.mote.collector

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import dev.mote.collector.plugins.NativeAdministrationPlugin

/** Installation guidance is read or copied explicitly; this page never installs a service. */
class StartUsingActivity : MoteActivity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage(title = MoteI18n.text("开始使用"))
        fun text(value: String, role: NativeFontRole = NativeFontRole.SUPPORT) = TextView(this).apply {
            text = value; MoteUi.type(this,role); MoteUi.textColor(this,NativeColorRole.INK); setPadding(0,moteDp(12),0,moteDp(12))
        }.also(body::addView)
        fun button(value: String, primary: Boolean = false, run: () -> Unit) = MoteUi.button(Button(this).apply { text = value; setOnClickListener { run() } },primary).also { body.addView(it,android.widget.LinearLayout.LayoutParams(-2,-2).apply { bottomMargin=moteDp(16) }) }
        fun action(value: String, link: Boolean=false, run: () -> Unit) = object:TextView(this) { override fun getAccessibilityClassName(): CharSequence = Button::class.java.name }.apply {
            text=if(link) value+" ↗" else value; contentDescription=value; isFocusable=true; minimumHeight=moteDp(44); gravity=android.view.Gravity.CENTER_VERTICAL
            MoteUi.type(this,NativeFontRole.SUPPORT); MoteUi.textColor(this,if(link) NativeColorRole.ACCENT else NativeColorRole.MUTED)
            if(link) paintFlags=paintFlags or android.graphics.Paint.UNDERLINE_TEXT_FLAG
            background=MoteUi.clickable(this@StartUsingActivity,NativeColorRole.BACKGROUND,0,false); setOnClickListener { run() }
        }.also { body.addView(it,android.widget.LinearLayout.LayoutParams(-1,-2)) }
        text(MoteI18n.text("先准备你的中央档案"),NativeFontRole.TITLE_MOBILE)
        text(MoteI18n.text("在电脑上请安装助手准备 Central。完成后，用它给出的地址打开工作台，再生成设备连接邀请。"))
        button(MoteI18n.text("复制给安装助手"),true) {
            getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Mote",NativeAdministrationPlugin.INSTALL_PROMPT))
            android.widget.Toast.makeText(this,MoteI18n.text("已复制"),android.widget.Toast.LENGTH_SHORT).show()
        }
        val prompt = TextView(this).apply { text = NativeAdministrationPlugin.INSTALL_PROMPT; visibility = View.GONE; setTextIsSelectable(true); MoteUi.type(this,NativeFontRole.SUPPORT); MoteUi.textColor(this,NativeColorRole.MUTED) }
        body.addView(View(this).apply { MoteUi.backgroundColor(this,NativeColorRole.DIVIDER) },android.widget.LinearLayout.LayoutParams(-1,moteDp(1)))
        lateinit var disclosure: TextView
        disclosure=action(MoteI18n.text("查看安装提示词")) {
            prompt.visibility=if(prompt.visibility==View.VISIBLE) View.GONE else View.VISIBLE
            disclosure.text=(if(prompt.visibility==View.VISIBLE) "▾ " else "▸ ")+MoteI18n.text("查看安装提示词")
        }.apply { text="▸ "+MoteI18n.text("查看安装提示词") }
        body.addView(prompt)
        action(MoteI18n.text("查看安装文档"),link=true) { startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(NativeAdministrationPlugin.INSTALL_DOCUMENT))) }
        body.addView(View(this).apply { MoteUi.backgroundColor(this,NativeColorRole.DIVIDER) },android.widget.LinearLayout.LayoutParams(-1,moteDp(1)).apply { topMargin=moteDp(20); bottomMargin=moteDp(12) })
        action(MoteI18n.text("现在先记下来")) { openRecordEditor(); finish() }
    }
    companion object {
        internal val INSTALL_PROMPT: String get() = NativeAdministrationPlugin.INSTALL_PROMPT
    }
}
