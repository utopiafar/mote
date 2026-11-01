package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MoteI18nTranslationsTest {
    private val languages = MoteI18n.supported.filter { it != "zh-CN" }
    private val sources = SyncReadiness.obsoleteMessages
    private fun translated(language: String, source: String) = "[$language] $source"

    private class Fixture(val assets: MutableMap<String, String>, val reads: MutableMap<String, Int>, val select: (String) -> Unit) {
        val count get() = reads.values.sum()
    }

    @Suppress("UNCHECKED_CAST")
    private fun catalogs() = MoteI18n::class.java.getDeclaredField("catalogs").apply { isAccessible = true }
        .get(null) as MutableMap<String, Map<String, String>>

    private fun fixture(active: String = "zh-CN", body: (Fixture) -> Unit) {
        val selected = MoteI18n::class.java.getDeclaredField("selected").apply { isAccessible = true }
        val beforeLanguage = selected.get(null)
        val beforeCatalogs = catalogs().toMap()
        val beforeReader = MoteI18n.assetReader
        val assets = languages.associate { language ->
            "i18n-$language.json" to JSONObject().apply {
                sources.forEach { put(it, translated(language, it)) }
                put("Generated phrase {0}", translated(language, "Generated phrase {0}"))
                put("Generated unrelated UI key", "Generated unrelated UI value")
            }.toString()
        }.toMutableMap()
        val reads = mutableMapOf<String, Int>()
        selected.set(null, active)
        MoteI18n.assetReader = { name -> reads[name] = (reads[name] ?: 0) + 1; assets[name] }
        try { body(Fixture(assets, reads) { selected.set(null, it) }) }
        finally {
            MoteI18n.assetReader = beforeReader
            selected.set(null, beforeLanguage)
            catalogs().putAll(beforeCatalogs)
        }
    }

    private fun expected(source: String) = setOf(source) + languages.map { translated(it, source) }

    @Test fun persistedStatusesUseAllSixLanguagesWithoutRetainingTheirCatalogs() = fixture { f ->
        val labels = MoteI18n.translations(sources)
        assertEquals(languages.map { "i18n-$it.json" }.toSet(), f.reads.keys)
        assertTrue(f.reads.values.all { it == 1 })
        sources.forEach { assertEquals(expected(it), labels.getValue(it)) }
        assertTrue("status matching must not retain six full UI catalogs", catalogs().isEmpty())

        val config = CollectorConfig(deviceName = "Generated fixture", server = "http://127.0.0.1:47843",
            token = "generated-android-node-token-1234567890", debugHttp = true)
        for (source in sources) for (message in labels.getValue(source)) {
            val status = StoredSyncStatus(if (source == SyncReadiness.PAUSED) "paused" else "unconfigured", message)
            assertEquals("idle", SyncReadiness.heartbeatState(config, status, 0, PendingSync(0, null), 0) { key, text -> text in labels.getValue(key) })
            assertEquals(message, status.message)
        }
        assertEquals(labels, MoteI18n.translations(sources))
        assertEquals(6, f.count)
    }

    @Test fun setCachePreservesRequestOrderAndSeparatesMutableOrDifferentRequests() = fixture { f ->
        val a = sources[0]; val b = sources[1]; val c = sources[2]
        val first = MoteI18n.translations(listOf(a, b, a))
        assertEquals(listOf(a, b), first.keys.toList())
        val before = f.count
        @Suppress("UNCHECKED_CAST")
        (first.getValue(a) as MutableSet<String>).clear()
        @Suppress("UNCHECKED_CAST")
        (first as MutableMap<String, Set<String>>).remove(b)
        val reversed = MoteI18n.translations(listOf(b, a))
        assertEquals(listOf(b, a), reversed.keys.toList())
        assertEquals(expected(a), reversed.getValue(a))
        assertEquals(expected(b), reversed.getValue(b))
        assertEquals(before, f.count)

        assertEquals(mapOf(c to expected(c)), MoteI18n.translations(listOf(c)))
        val mutable = mutableListOf(a)
        assertEquals(mapOf(a to expected(a)), MoteI18n.translations(mutable))
        mutable += c
        assertEquals(mapOf(a to expected(a), c to expected(c)), MoteI18n.translations(mutable))
        val after = f.count
        assertEquals(mapOf(a to expected(a)), MoteI18n.translations(listOf(a)))
        assertEquals(after, f.count)
    }

    @Test fun activeUiCatalogIsReusedAndInactiveCatalogsAreReleasedEvenOnStatusCacheHits() = fixture("en") { f ->
        assertEquals(translated("en", sources[0]), MoteI18n.text(sources[0]))
        val labels = MoteI18n.translations(sources)
        assertEquals(6, f.count)
        assertEquals(setOf("en"), catalogs().keys)

        f.select("ja")
        assertEquals(translated("ja", sources[0]), MoteI18n.text(sources[0]))
        val before = f.count
        assertEquals(labels, MoteI18n.translations(sources.reversed()))
        assertEquals(before, f.count)
        assertEquals(setOf("ja"), catalogs().keys)
        assertEquals(translated("ja", sources[1]), MoteI18n.text(sources[1]))
        assertEquals(before, f.count)
    }

    @Test fun uiTextRetainsEnglishFallbackAndVerbatimArguments() = fixture("ja") { f ->
        val name = "i18n-ja.json"
        f.assets[name] = JSONObject(f.assets.getValue(name)).apply { remove("Generated phrase {0}") }.toString()
        assertEquals("[en] Generated phrase literal {0}", MoteI18n.text("Generated phrase {0}", "literal {0}"))
        assertEquals("Generated untranslated literal", MoteI18n.text("Generated untranslated {0}", "literal"))
        assertEquals(translated("ja", sources[0]), MoteI18n.text(sources[0]))
        assertEquals(1, f.reads[name])
        MoteI18n.translations(sources)
        assertEquals(setOf("ja"), catalogs().keys)
    }

    @Test fun missingOrUnreadableTranslationsDoNotCacheAFalseSuccess() = fixture { f ->
        val name = "i18n-fr.json"; val valid = f.assets.getValue(name)
        f.assets[name] = JSONObject(valid).apply { remove(sources[0]) }.toString()
        val missing = assertThrows(IllegalStateException::class.java) { MoteI18n.translations(listOf(sources[0])) }
        assertEquals("Sync status translations are unavailable", missing.message)
        f.assets[name] = valid
        assertEquals(mapOf(sources[0] to expected(sources[0])), MoteI18n.translations(listOf(sources[0])))

        f.assets[name] = "{generated invalid JSON"
        val unreadable = assertThrows(IllegalStateException::class.java) { MoteI18n.translations(listOf(sources[1])) }
        assertEquals("Sync status translations are unavailable", unreadable.message)
        f.assets[name] = valid
        assertEquals(mapOf(sources[1] to expected(sources[1])), MoteI18n.translations(listOf(sources[1])))
        val before = f.count
        MoteI18n.translations(listOf(sources[0])); MoteI18n.translations(listOf(sources[1]))
        assertEquals(before, f.count)
        assertTrue(catalogs().isEmpty())
    }
}
