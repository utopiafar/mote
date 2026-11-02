package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

/** The native presentation registry is the real consumer of plugin namespace
 * labels: exact id@version binding, runtime locale, and safe builtin fallback. */
class NativeUiPacksPresentationTest {
    private val selected = MoteI18n::class.java.getDeclaredField("selected").apply { isAccessible = true }

    private fun withLocale(locale: String, body: () -> Unit) {
        val before = selected.get(null)
        selected.set(null, locale)
        try { body() } finally {
            selected.set(null, before)
            MoteI18n.pluginCatalogs.clear()
        }
    }

    private fun tokens(): Map<String, String> = buildMap {
        listOf(
            "background", "surface", "sidebar", "ink", "muted", "accent", "accent-hover", "tint",
            "border", "control-border", "divider", "success", "warning", "danger",
            "success-tint", "warning-tint", "danger-tint", "primary-background", "primary-ink", "surface-raised",
        ).forEach { put(it, "#112233") }
        listOf("radius", "radius-container", "radius-control", "radius-reading", "radius-indicator", "border-width", "panel-border-width")
            .forEach { put(it, "4") }
        listOf(
            "font-title", "font-title-mobile", "font-appbar", "font-section", "font-row", "font-body",
            "font-support", "font-meta", "font-action", "space-page", "space-panel", "space-group",
            "space-item", "space-inline", "control-height-mobile",
        ).forEach { put(it, "48") }
        put("weight-title", "700"); put("weight-section", "600"); put("weight-body", "400")
        put("line-body", "20"); put("letter-title", "0")
        put("font", "sans-serif"); put("font-heading", "sans-serif")
    }

    private fun themeProvider(id: String, version: String, presentation: PluginUiPresentation? = null) =
        object : NativeThemeProvider {
            override val snapshot = NativeThemeSnapshot(NativeUiIdentity(id, version), tokens(), emptyMap(), presentation)
        }

    private fun layoutProvider(id: String, version: String, presentation: PluginUiPresentation? = null) =
        object : NativeLayoutProvider {
            override val snapshot = NativeLayoutSnapshot(
                NativeUiIdentity(id, version), listOf("home"), "home", "home", "stack", presentation,
            )
        }

    private fun registryWithBuiltin(): NativeUiPackRegistry {
        val registry = NativeUiPackRegistry()
        registry.register(themeProvider("fixture.builtin", "1"))
        registry.register(layoutProvider("fixture.builtin", "1"))
        registry.setBuiltin(NativeUiBinding(NativeUiIdentity("fixture.builtin", "1"), NativeUiIdentity("fixture.builtin", "1")))
        return registry
    }

    private fun catalogs() {
        MoteI18n.pluginCatalogs.register("fixture.plugin", "en", mapOf("theme.name" to "Studio", "layout.name" to "Phone layout"))
        MoteI18n.pluginCatalogs.register("fixture.plugin", "zh-CN", mapOf("theme.name" to "影棚", "layout.name" to "手机布局"))
    }

    @Test fun contributionLabelsResolveAtTheCurrentRuntimeLocale() = withLocale("zh-CN") {
        val registry = registryWithBuiltin()
        catalogs()
        val theme = PluginUiPresentation("theme.name", i18nNamespace = "fixture.plugin")
        val layout = PluginUiPresentation("layout.name", i18nNamespace = "fixture.plugin")
        registry.register(themeProvider("fixture.theme", "1", theme))
        registry.register(layoutProvider("fixture.layout", "1", layout))
        registry.bind(NativeUiBinding(NativeUiIdentity("fixture.theme", "1"), NativeUiIdentity("fixture.layout", "1")))
        assertEquals("影棚", registry.themeLabel()?.text)
        assertEquals("手机布局", registry.layoutLabel()?.text)
        selected.set(null, "en")
        assertEquals("Studio", registry.themeLabel()?.text)
        assertEquals("Phone layout", registry.layoutLabel()?.text)
    }

    @Test fun removalRestoresBuiltinAndKeepsTheReadableFallbackLabel() = withLocale("zh-CN") {
        val registry = registryWithBuiltin()
        catalogs()
        registry.register(themeProvider("fixture.theme", "1", PluginUiPresentation("theme.name", i18nNamespace = "fixture.plugin")))
        registry.register(layoutProvider("fixture.layout", "1", PluginUiPresentation("layout.name", i18nNamespace = "fixture.plugin")))
        registry.bind(NativeUiBinding(NativeUiIdentity("fixture.theme", "1"), NativeUiIdentity("fixture.layout", "1")))
        registry.removeTheme(NativeUiIdentity("fixture.theme", "1"))
        assertEquals("theme_removed", registry.fallbackReason())
        assertEquals("fixture.builtin", registry.activeBinding().theme.id)
        assertEquals("影棚", registry.fallbackLabel()?.text)
        registry.removeLayout(NativeUiIdentity("fixture.layout", "1"))
        assertEquals("layout_removed", registry.fallbackReason())
        assertEquals("fixture.builtin", registry.activeBinding().layout.id)
        assertEquals("手机布局", registry.fallbackLabel()?.text)
    }

    @Test fun catalogUnloadBeforeRemovalKeepsTheLastReadableLabel() = withLocale("en") {
        val registry = registryWithBuiltin()
        catalogs()
        registry.register(themeProvider("fixture.theme", "1", PluginUiPresentation("theme.name", i18nNamespace = "fixture.plugin")))
        registry.register(layoutProvider("fixture.layout", "1", PluginUiPresentation("layout.name", i18nNamespace = "fixture.plugin")))
        registry.bind(NativeUiBinding(NativeUiIdentity("fixture.theme", "1"), NativeUiIdentity("fixture.layout", "1")))
        assertEquals("Studio", registry.themeLabel()?.text)
        MoteI18n.pluginCatalogs.clear()
        registry.removeTheme(NativeUiIdentity("fixture.theme", "1"))
        assertEquals("Studio", registry.fallbackLabel()?.text)
    }

    @Test fun themeAndLayoutSharingIdentityKeepSeparateLabels() = withLocale("en") {
        val registry = registryWithBuiltin()
        catalogs()
        val theme = PluginUiPresentation("theme.name", i18nNamespace = "fixture.plugin")
        val layout = PluginUiPresentation("layout.name", i18nNamespace = "fixture.plugin")
        registry.register(themeProvider("fixture.pack", "1", theme))
        registry.register(layoutProvider("fixture.pack", "1", layout))
        registry.bind(NativeUiBinding(NativeUiIdentity("fixture.pack", "1"), NativeUiIdentity("fixture.pack", "1")))
        assertEquals("Phone layout", registry.layoutLabel()?.text)
        assertEquals("Studio", registry.themeLabel()?.text)
        MoteI18n.pluginCatalogs.clear()
        assertEquals("Studio", registry.themeLabel()?.text)
        assertEquals("Phone layout", registry.layoutLabel()?.text)
        registry.removeTheme(NativeUiIdentity("fixture.pack", "1"))
        assertEquals("Studio", registry.fallbackLabel()?.text)
        assertEquals("fixture.builtin", registry.activeBinding().theme.id)
        registry.removeLayout(NativeUiIdentity("fixture.pack", "1"))
        assertEquals("Phone layout", registry.fallbackLabel()?.text)
    }

    @Test fun fallbackLabelReResolvesAfterLanguageChange() = withLocale("zh-CN") {
        val registry = registryWithBuiltin()
        catalogs()
        registry.register(themeProvider("fixture.theme", "1", PluginUiPresentation("theme.name", i18nNamespace = "fixture.plugin")))
        registry.register(layoutProvider("fixture.layout", "1", PluginUiPresentation("layout.name", i18nNamespace = "fixture.plugin")))
        registry.bind(NativeUiBinding(NativeUiIdentity("fixture.theme", "1"), NativeUiIdentity("fixture.layout", "1")))
        registry.removeTheme(NativeUiIdentity("fixture.theme", "1"))
        assertEquals("影棚", registry.fallbackLabel()?.text)
        selected.set(null, "en")
        assertEquals("Studio", registry.fallbackLabel()?.text)
    }

    @Test fun replacementCatalogUpdatesAccessibilityWhileLabelStaysReadable() = withLocale("en") {
        val registry = registryWithBuiltin()
        MoteI18n.pluginCatalogs.register("fixture.plugin", "en", mapOf("theme.name" to "Studio", "theme.a11y" to "Studio theme"))
        registry.register(themeProvider("fixture.theme", "1", PluginUiPresentation("theme.name", a11yKey = "theme.a11y", i18nNamespace = "fixture.plugin")))
        registry.bind(NativeUiBinding(NativeUiIdentity("fixture.theme", "1"), NativeUiIdentity("fixture.builtin", "1")))
        assertEquals("Studio theme", registry.themeA11y()?.text)
        MoteI18n.pluginCatalogs.clear()
        MoteI18n.pluginCatalogs.register("fixture.plugin", "en", mapOf("theme.a11y" to "Updated accessible name"))
        assertEquals("Studio", registry.themeLabel()?.text)
        assertEquals("Updated accessible name", registry.themeA11y()?.text)
        assertEquals("key_missing", registry.themeLabel()?.fallbackReason)
    }

    @Test fun catalogUnloadKeepsDistinctCachedAccessibleName() = withLocale("en") {
        val registry = registryWithBuiltin()
        MoteI18n.pluginCatalogs.register("fixture.plugin", "en", mapOf("theme.name" to "Studio", "theme.a11y" to "Studio theme"))
        registry.register(themeProvider("fixture.theme", "1", PluginUiPresentation("theme.name", a11yKey = "theme.a11y", i18nNamespace = "fixture.plugin")))
        registry.bind(NativeUiBinding(NativeUiIdentity("fixture.theme", "1"), NativeUiIdentity("fixture.builtin", "1")))
        assertEquals("Studio theme", registry.themeA11y()?.text)
        MoteI18n.pluginCatalogs.clear()
        assertEquals("Studio", registry.themeLabel()?.text)
        assertEquals("Studio theme", registry.themeA11y()?.text)
    }
}
