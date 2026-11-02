package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test

/**
 * Contract the Android plugin navigation consumer relies on: plugin labels are
 * resolved against the runtime locale without changing route identity, English
 * is the canonical key set, and the approved home-only navigation stays intact.
 */
class PluginNavigationContractTest {
    private val namespace = "fixture.plugin"
    private val english = mapOf(
        "nav.library" to "Library",
        "nav.library.glyph" to "library",
        "nav.library.a11y" to "Library navigation",
    )
    private val chinese = mapOf(
        "nav.library" to "资料库",
        "nav.library.glyph" to "资料库",
        "nav.library.a11y" to "资料库导航",
    )
    private val presentation = PluginUiPresentation("nav.library", "nav.library.glyph", "nav.library.a11y", namespace)
    private val route = "fixture.library"

    @Test fun runtimeLocaleChangesPluginLabelsButNotRouteIdentity() {
        val registry = PluginI18nRegistry()
        registry.register(namespace, "en", english)
        registry.register(namespace, "zh-CN", chinese)
        val zh = registry.resolve(route, presentation, "zh-CN")
        val en = registry.resolve(route, presentation, "en")
        assertEquals("资料库", zh.label.text)
        assertEquals("Library", en.label.text)
        assertEquals("资料库导航", zh.a11y.text)
        assertEquals("Library navigation", en.a11y.text)
        assertEquals("资料库", zh.glyph?.text)
        assertEquals("library", en.glyph?.text)
        assertEquals(route, zh.routeId)
        assertEquals(route, en.routeId)
        assertTrue(zh.fallbackReasons.isEmpty())
        assertTrue(en.fallbackReasons.isEmpty())
    }

    @Test fun rebuildingTheRegistryResolvesTheSameKeysAndIdentity() {
        val first = PluginI18nRegistry().apply {
            register(namespace, "en", english)
            register(namespace, "zh-CN", chinese)
        }.resolve(route, presentation, "en")
        val rebuilt = PluginI18nRegistry().apply {
            register(namespace, "en", english)
            register(namespace, "zh-CN", chinese)
        }.resolve(route, presentation, "en")
        assertEquals(first, rebuilt)
        assertEquals(route, rebuilt.routeId)
    }

    @Test fun accessibleNameFallsBackToTheVisibleLabelAndGlyphStaysOptional() {
        val registry = PluginI18nRegistry()
        registry.register(namespace, "en", mapOf("nav.library" to "Library"))
        val resolved = registry.resolve(route, PluginUiPresentation("nav.library", i18nNamespace = namespace), "en")
        assertEquals("Library", resolved.label.text)
        assertEquals("Library", resolved.a11y.text)
        assertNull(resolved.glyph)
        assertTrue(resolved.fallbackReasons.isEmpty())
    }

    @Test fun missingTranslationUsesEnglishWithAnExplicitReason() {
        val registry = PluginI18nRegistry()
        registry.register(namespace, "en", english)
        val missingLocale = registry.resolve(route, presentation, "ja")
        assertEquals("Library", missingLocale.label.text)
        assertEquals(listOf("locale_missing"), missingLocale.fallbackReasons)
        val unknownNamespace = registry.resolve(route, PluginUiPresentation("nav.library", i18nNamespace = "fixture.unknown"), "en")
        assertEquals("nav.library", unknownNamespace.label.text)
        assertEquals(listOf("namespace_missing"), unknownNamespace.fallbackReasons)
        val unknownKey = registry.resolve(namespace, "nav.missing", "en")
        assertEquals(PluginUiText("nav.missing", "key_missing"), unknownKey)
    }

    @Test fun englishIsTheCanonicalKeySetForEveryLocale() {
        val early = PluginI18nRegistry()
        early.register(namespace, "zh-CN", chinese)
        early.register(namespace, "en", english)
        assertEquals("资料库", early.resolve(namespace, "nav.library", "zh-CN").text)
        assertThrows(IllegalArgumentException::class.java) {
            early.register(namespace, "fr", chinese + ("nav.extra" to "Extra"))
        }
        val late = PluginI18nRegistry()
        late.register(namespace, "de", mapOf("nav.library" to "Bibliothek", "nav.extra" to "Extra"))
        assertThrows(IllegalArgumentException::class.java) {
            late.register(namespace, "en", english)
        }
    }

    @Test fun duplicateInvalidAndEmptyCatalogsAreRejected() {
        val registry = PluginI18nRegistry()
        registry.register(namespace, "en", english)
        assertThrows(IllegalArgumentException::class.java) { registry.register(namespace, "en", english) }
        assertThrows(IllegalArgumentException::class.java) { registry.register("bad namespace", "en", english) }
        assertThrows(IllegalArgumentException::class.java) { registry.register(namespace, "xx", english) }
        assertThrows(IllegalArgumentException::class.java) { registry.register("fixture.other", "en", emptyMap()) }
        assertThrows(IllegalArgumentException::class.java) { registry.register("fixture.other", "en", mapOf("bad key" to "value")) }
        assertThrows(IllegalArgumentException::class.java) { registry.register("fixture.other", "en", mapOf("nav.library" to "   ")) }
    }

    @Test fun approvedAndroidNavigationKeepsOneHomeAndStableRoutes() {
        assertTrue("Management destinations stay in the secondary menu", MoteNavigation.primaryTabs().isEmpty())
        assertEquals("OVERVIEW", MoteNavigation.initialLocalPage())
        assertEquals(MotePrimaryTab.LIBRARY, MoteNavigation.centralTab("archive"))
        assertEquals(MotePrimaryTab.ACTIVITY, MoteNavigation.centralTab("activity"))
        assertEquals("overview", MoteNavigation.centralParent("actions"))
        assertEquals("archive", MoteNavigation.centralParent("files"))
    }
}
