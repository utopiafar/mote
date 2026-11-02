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
    val supported = listOf("zh-CN", "en", "ja", "fr", "de", "es", "ru")
    @Volatile private var application: Context? = null
    private val catalogs = java.util.concurrent.ConcurrentHashMap<String, Map<String, String>>()
    private val statusTranslations = java.util.concurrent.ConcurrentHashMap<Set<String>, Map<String, Set<String>>>()
    @Volatile internal var assetReader: ((String) -> String?)? = null
        set(value) { field = value; catalogs.clear(); statusTranslations.clear() }
    @Volatile private var selected = "system"
    private val argument = Regex("\\{(\\d+)\\}")
    fun initialize(context: Context) {
        application = context.applicationContext
        selected = context.getSharedPreferences("mote.language", Context.MODE_PRIVATE).getString("language", "system") ?: "system"
    }
    private fun load(name: String, keys: Set<String>? = null): Map<String, String> {
        return try {
            val reader = assetReader
            val content = if (reader != null) reader(name) else application?.assets?.open(name)?.bufferedReader()?.use { it.readText() }
            val json = JSONObject(content ?: return emptyMap())
            (keys?.asSequence() ?: json.keys().asSequence()).filter(json::has).associateWith { json.getString(it) }
        } catch (_: Exception) { emptyMap() }
    }
    private fun catalog(language: String): Map<String, String> = catalogs.getOrPut(language) { load("i18n-$language.json") }
    /** Match an authored status persisted before a language change without treating other messages as status codes. */
    internal fun translations(sources: Collection<String>): Map<String, Set<String>> {
        val active = language()
        // Keep the active UI cache, releasing a previous UI language or its English fallback.
        catalogs.keys.removeIf { it != active }
        val values = statusTranslations.computeIfAbsent(sources.toSet()) { keys ->
            val selectedCatalogs = supported.filter { it != "zh-CN" }.map { language ->
                if (language == active) catalogs[language] ?: load("i18n-$language.json", keys)
                else load("i18n-$language.json", keys)
            }
            check(selectedCatalogs.all { catalog -> keys.all(catalog::containsKey) }) { "Sync status translations are unavailable" }
            keys.associateWith { source -> setOf(source) + selectedCatalogs.mapNotNull { it[source] } }
        }
        // Request order and caller-owned collections must not change or expose the cached entry.
        return sources.associateWith { values.getValue(it).toSet() }
    }
    fun preference() = selected
    fun language(): String {
        if (selected in supported) return selected
        if (application == null) return "zh-CN" // Headless unit fixtures retain the protocol default.
        val languages = Resources.getSystem().configuration.locales
        for (i in 0 until languages.size()) {
            for (candidate in supported) {
                if (languages[i].language == Locale.forLanguageTag(candidate).language) return candidate
            }
        }
        return "en"
    }
    fun locale(): Locale = Locale.forLanguageTag(language())
    fun select(context: Context, value: String) {
        require(value == "system" || value in supported)
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
        val active = language()
        val template = if (active == "zh-CN") source else catalog(active)[source] ?: catalog("en")[source] ?: source
        return argument.replace(template) { match ->
            val index = match.groupValues[1].toIntOrNull()
            if (index != null && index < values.size) values[index]?.toString() ?: "" else match.value
        }
    }
}

/** One plugin message resolved for a locale. A missing translation reports an
 * explicit reason instead of changing route identity, authorization or drafts. */
internal data class PluginUiText(val text: String, val fallbackReason: String? = null)

/** The label/glyph/accessibility roles a contribution declares. Keys are
 * opaque authored identifiers resolved against the plugin namespace. */
internal data class PluginUiPresentation(
    val labelKey: String,
    val glyphKey: String? = null,
    val a11yKey: String? = null,
    val i18nNamespace: String,
)

internal data class ResolvedPluginUiPresentation(
    val routeId: String,
    val label: PluginUiText,
    val glyph: PluginUiText?,
    val a11y: PluginUiText,
    val fallbackReasons: List<String>,
)

/** Namespaced plugin-authored catalogs. Host catalogs never resolve plugin
 * keys; English is the canonical key set and every other locale may only
 * translate keys English declared. Registration order is free. */
internal class PluginI18nRegistry {
    private val namespaces = LinkedHashMap<String, LinkedHashMap<String, Map<String, String>>>()
    private val token = Regex("[\\x21-\\x7e]{1,256}")

    @Synchronized
    fun register(namespace: String, locale: String, catalog: Map<String, String>) {
        require(token.matches(namespace)) { "Invalid plugin i18n namespace" }
        require(locale in MoteI18n.supported) { "Unsupported plugin locale: $locale" }
        // Copy once so the empty check, entry validation, English key-set
        // checks and storage all see the same values; a mutable or changing
        // caller map cannot store anything it did not validate.
        val snapshot = LinkedHashMap(catalog)
        require(snapshot.isNotEmpty()) { "Empty plugin catalog" }
        snapshot.forEach { (key, value) ->
            require(token.matches(key)) { "Invalid plugin message key: $key" }
            require(value.isNotBlank() && value.length <= 2000) { "Invalid plugin translation: $key" }
        }
        val byLocale = namespaces.getOrPut(namespace) { LinkedHashMap() }
        require(!byLocale.containsKey(locale)) { "Plugin catalog already registered: $namespace@$locale" }
        if (locale == "en") {
            byLocale.forEach { (other, otherCatalog) ->
                require(otherCatalog.keys.all(snapshot::containsKey)) { "English catalog is missing plugin keys for $other" }
            }
        } else byLocale["en"]?.let { english ->
            require(snapshot.keys.all(english::containsKey)) { "English catalog is missing plugin keys for $locale" }
        }
        byLocale[locale] = java.util.Collections.unmodifiableMap(snapshot)
    }

    /** Resolves one key against the active locale, then English, then the key.
     * `locale` defaults to the runtime locale at call time. */
    @Synchronized
    fun resolve(namespace: String, key: String, locale: String = MoteI18n.language()): PluginUiText {
        val byLocale = namespaces[namespace] ?: return PluginUiText(key, "namespace_missing")
        val english = byLocale["en"] ?: return PluginUiText(key, "key_missing")
        byLocale[locale]?.get(key)?.let { return PluginUiText(it) }
        english[key]?.let { return PluginUiText(it, "locale_missing") }
        return PluginUiText(key, "key_missing")
    }

    /** Resolves a contribution's declared roles. A declared accessibility key
     * with no readable message falls back to the visible label while keeping
     * the diagnostic; nothing here reads data, commands or drafts. */
    @Synchronized
    fun resolve(routeId: String, presentation: PluginUiPresentation, locale: String = MoteI18n.language()): ResolvedPluginUiPresentation {
        val label = resolve(presentation.i18nNamespace, presentation.labelKey, locale)
        val glyph = presentation.glyphKey?.let { resolve(presentation.i18nNamespace, it, locale) }
        val declaredA11y = presentation.a11yKey?.let { resolve(presentation.i18nNamespace, it, locale) }
        // A declared key that resolves to itself carries no readable message.
        // An English translation for a missing target locale stays readable.
        val a11y = when {
            declaredA11y == null -> label
            declaredA11y.fallbackReason == "key_missing" || declaredA11y.fallbackReason == "namespace_missing" ->
                PluginUiText(label.text, declaredA11y.fallbackReason)
            else -> declaredA11y
        }
        val reasons = listOfNotNull(label.fallbackReason, glyph?.fallbackReason, a11y.fallbackReason).distinct()
        return ResolvedPluginUiPresentation(routeId, label, glyph, a11y, reasons)
    }

    @Synchronized
    fun clear() { namespaces.clear() }
}

/** Recreate stale screens after returning from an app-language change. */
open class MoteActivity : Activity() {
    private var displayedLanguage = ""
    private var displayedUiRevision = -1L
    private var uiResumed = false
    private var stopUiObservation: (() -> Unit)? = null
    private val uiHandler = android.os.Handler(android.os.Looper.getMainLooper())
    override fun attachBaseContext(newBase: Context) { super.attachBaseContext(MoteAppearance.wrap(MoteI18n.wrap(newBase))) }
    override fun onCreate(savedInstanceState: Bundle?) {
        displayedLanguage = MoteI18n.language()
        displayedUiRevision = NativeUiPacks.registry.revision
        setTheme(if (lightSurface()) R.style.AppThemeLight else R.style.AppThemeDark)
        super.onCreate(savedInstanceState)
        stopUiObservation = NativeUiPacks.registry.observe { uiHandler.post { applyUiRevision() } }
        window.decorView.layoutDirection = android.view.View.LAYOUT_DIRECTION_LTR
        applyWindowPresentation()
    }
    private fun lightSurface(): Boolean {
        val color = MoteTheme.background
        return (android.graphics.Color.red(color) * 299 + android.graphics.Color.green(color) * 587 + android.graphics.Color.blue(color) * 114) >= 128000
    }
    private fun applyWindowPresentation() {
        val light = lightSurface()
        val appearanceConfig = Configuration(resources.configuration)
        appearanceConfig.uiMode = (appearanceConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
            if (light) Configuration.UI_MODE_NIGHT_NO else Configuration.UI_MODE_NIGHT_YES
        @Suppress("DEPRECATION")
        resources.updateConfiguration(appearanceConfig, resources.displayMetrics)
        setTheme(if (light) R.style.AppThemeLight else R.style.AppThemeDark)
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(MoteTheme.background))
        @Suppress("DEPRECATION")
        window.statusBarColor = MoteTheme.background
        @Suppress("DEPRECATION")
        window.navigationBarColor = MoteTheme.background
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            val appearance = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (light) appearance else 0, appearance)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (light) android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR else 0
        }
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
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        MoteAppearance.refresh()
        // Handle uiMode in place: editors, open sheets and navigation keep their identity.
        applyWindowPresentation()
        NativePresentationStyles.refreshOwnedWindows(this)
        MoteDialogBuilder.refreshOwned(this)
    }
    override fun onResume() {
        super.onResume()
        MoteAppearance.refresh()
        uiResumed = true
        if (displayedLanguage != MoteI18n.language()) recreate() else applyUiRevision()
    }
    private fun applyUiRevision() {
        if (uiResumed && !isFinishing && !isDestroyed && displayedUiRevision != NativeUiPacks.registry.revision) {
            displayedUiRevision = NativeUiPacks.registry.revision
            applyWindowPresentation()
            NativePresentationStyles.refreshOwnedWindows(this)
            MoteDialogBuilder.refreshOwned(this)
        }
    }
    override fun onPause() { uiResumed = false; super.onPause() }
    override fun onDestroy() { stopUiObservation?.invoke(); uiHandler.removeCallbacksAndMessages(null); super.onDestroy() }
}
