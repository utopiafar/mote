package dev.mote.collector

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.os.Bundle
import java.util.Locale
import org.json.JSONObject

/** Localizes authored UI messages only. Arguments and captured content remain verbatim. */
object MoteI18n {
    @Volatile private var application: Context? = null
    @Volatile private var english: Map<String, String> = emptyMap()
    @Volatile private var selected = "system"
    private val argument = Regex("\\{(\\d+)\\}")
    fun initialize(context: Context) {
        application = context.applicationContext
        selected = context.getSharedPreferences("mote.language", Context.MODE_PRIVATE).getString("language", "system") ?: "system"
        val json = context.assets.open("i18n-en.json").bufferedReader().use { JSONObject(it.readText()) }
        english = json.keys().asSequence().associateWith { json.getString(it) }
    }
    fun preference() = selected
    fun language(): String {
        if (selected == "en" || selected == "zh-CN") return selected
        if (application == null) return "zh-CN" // Headless unit fixtures retain the protocol default.
        val languages = Resources.getSystem().configuration.locales
        for (i in 0 until languages.size()) {
            if (languages[i].language == "zh") return "zh-CN"
            if (languages[i].language == "en") return "en"
        }
        return "en"
    }
    fun locale(): Locale = Locale.forLanguageTag(language())
    fun select(context: Context, value: String) {
        require(value in listOf("system", "zh-CN", "en"))
        check(context.getSharedPreferences("mote.language", Context.MODE_PRIVATE).edit().putString("language", value).commit())
        selected = value
        Notifications.create(context)
    }
    fun wrap(context: Context): Context {
        val config = Configuration(context.resources.configuration)
        config.setLocale(locale())
        config.setLayoutDirection(Locale.ENGLISH)
        return context.createConfigurationContext(config)
    }
    fun text(source: String, vararg values: Any?): String {
        val template = if (language() == "en") english[source] ?: source else source
        return argument.replace(template) { match ->
            val index = match.groupValues[1].toIntOrNull()
            if (index != null && index < values.size) values[index]?.toString() ?: "" else match.value
        }
    }
}

/** Recreate stale screens after returning from an app-language change. */
open class MoteActivity : Activity() {
    private var displayedLanguage = ""
    override fun attachBaseContext(newBase: Context) { super.attachBaseContext(MoteI18n.wrap(newBase)) }
    override fun onCreate(savedInstanceState: Bundle?) {
        displayedLanguage = MoteI18n.language()
        super.onCreate(savedInstanceState)
        window.decorView.layoutDirection = android.view.View.LAYOUT_DIRECTION_LTR
    }
    override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
        if (event.action == android.view.MotionEvent.ACTION_DOWN) {
            val field = currentFocus as? android.widget.EditText
            if (field != null) {
                val bounds = android.graphics.Rect()
                field.getGlobalVisibleRect(bounds)
                if (!bounds.contains(event.rawX.toInt(), event.rawY.toInt())) {
                    field.clearFocus()
                    getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                        .hideSoftInputFromWindow(field.windowToken, 0)
                }
            }
        }
        return super.dispatchTouchEvent(event)
    }
    override fun onResume() {
        super.onResume()
        if (displayedLanguage != MoteI18n.language()) recreate()
    }
}
