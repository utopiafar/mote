package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AppPageSetupTest {
    private fun article(app: String = "generated.reader", version: String = "1.2") = AppPageSetup.fieldRule(app, version, "article",
        mapOf("title" to "$app:id/title", "author" to "$app:id/author", "body" to "$app:id/body"))
    private fun product(app: String = "generated.shop", version: String = "3.4") = AppPageSetup.fieldRule(app, version, "product",
        mapOf("title" to "$app:id/title", "url" to "$app:id/url", "itemId" to "$app:id/item_id"), repeat = "$app:id/card")

    @Test fun configurationAvailabilityIsIsolatedByInstalledVersionAndApp() {
        val raw = article()
        assertEquals(setOf("title", "author", "body"), AppPageSetup.adapters(raw, "generated.reader", "1.2").single().fields)
        assertTrue(AppPageSetup.adapters(raw, "generated.reader", "1.3").isEmpty())
        assertTrue(AppPageSetup.adapters(raw, "generated.other", "1.2").isEmpty())
        assertTrue(AppPageSetup.adapters(raw, "generated.reader", "").isEmpty())
        val legacy = """[{"id":"old","version":"1","platform":"android","appId":"generated.reader","select":{"role":"Text"}}]"""
        assertTrue(AppPageSetup.adapters(legacy, "generated.reader", "1.2").isEmpty())
    }
    @Test fun importingOneAppVersionPreservesOtherAppRules() {
        val before = article()
        val merged = AppPageSetup.merge(before, product(), "generated.shop", "3.4")
        assertEquals(2, UiPageRules.parse(merged).size)
        assertEquals("article", AppPageSetup.adapters(merged, "generated.reader", "1.2").single().kind)
        assertEquals("product", AppPageSetup.adapters(merged, "generated.shop", "3.4").single().kind)
        assertThrows(IllegalArgumentException::class.java) { AppPageSetup.merge(before, product(), "generated.shop", "3.5") }
        assertThrows(IllegalArgumentException::class.java) { AppPageSetup.merge(before, article(), "generated.shop", "1.2") }
    }
    @Test fun ruleIdsCannotReplaceAnotherAppsConfiguration() {
        val other = JSONArray(product()).getJSONObject(0).put("id", JSONArray(article()).getJSONObject(0).getString("id"))
        assertThrows(IllegalArgumentException::class.java) { AppPageSetup.merge(article(), JSONArray().put(other).toString(), "generated.shop", "3.4") }
        assertEquals(1, UiPageRules.parse(AppPageSetup.merge(article(), article(), "generated.reader", "1.2")).size)
    }
    @Test fun formRequiresOriginalArticleBodyAndDoesNotInventProductLinks() {
        assertThrows(IllegalArgumentException::class.java) { AppPageSetup.fieldRule("generated.reader", "1.2", "article", mapOf("title" to "generated.reader:id/title")) }
        assertThrows(IllegalArgumentException::class.java) { AppPageSetup.fieldRule("generated.shop", "", "product", mapOf("title" to "generated.shop:id/title")) }
        val fields = JSONArray(AppPageSetup.fieldRule("generated.shop", "3.4", "product", mapOf("title" to "generated.shop:id/title", "url" to ""))).getJSONObject(0).getJSONObject("fields")
        assertEquals(setOf("title"), fields.keys().asSequence().toSet())
        assertTrue(fields.getJSONObject("title").getBoolean("required"))
    }
    @Test fun newConfigurationUsesPagePriorityWithoutContentAuthorizationExpansion() {
        val fresh = CollectorConfig(deviceName = "Generated phone")
        assertEquals("ui_preferred", fresh.uiPageMode)
        assertEquals(AppCollectionMode.ACTIVITY, fresh.collectionRules.defaultMode)
        assertFalse(fresh.collectionRules.mayCollectContent())
        for (mode in listOf("screen_only", "hybrid", "page_only")) {
            val old = fresh.copy(uiPageMode = mode)
            val restored = ConfigurationArchive.decode(ConfigurationArchive.encode(old), fresh)
            assertEquals(mode, restored.uiPageMode)
            assertEquals(old.appCollectionRules, restored.appCollectionRules)
        }
    }
}
