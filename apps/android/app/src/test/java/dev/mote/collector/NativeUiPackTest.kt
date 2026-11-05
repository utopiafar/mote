package dev.mote.collector

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class NativeUiPackTest {
    private val themeId = NativeUiIdentity("fixture.theme", "1")
    private val layoutId = NativeUiIdentity("fixture.layout", "1")
    private fun theme(version: String = "1"): NativeThemeProvider = object : NativeThemeProvider {
        override val snapshot = NativeThemeSnapshot(themeId.copy(version = version),
            listOf("background", "surface", "sidebar", "ink", "muted", "accent", "accent-hover", "tint", "border", "control-border", "divider", "hair", "fill", "surface-hover", "surface-sunken", "on-accent", "success", "warning", "danger", "success-tint", "warning-tint", "danger-tint", "primary-background", "primary-ink", "surface-raised").associateWith { "#123456" } +
            listOf("radius", "radius-container", "radius-control", "radius-reading", "radius-indicator", "border-width", "panel-border-width", "radius-thumb-mobile", "radius-control-mobile", "radius-container-mobile", "radius-panel-mobile", "radius-pill", "font-title", "font-title-mobile", "font-appbar", "font-section", "font-row", "font-body", "font-support", "font-meta", "font-action", "space-page", "space-panel", "space-group", "space-item", "space-inline").associateWith { "14px" } + mapOf(
                "control-height-mobile" to "48px", "weight-title" to "600", "weight-section" to "600", "weight-body" to "400", "line-body" to "1.65", "letter-title" to "-0.025em", "font" to "sans-serif", "font-heading" to "sans-serif"))
    }
    private fun layout(value: NativeLayoutSnapshot = NativeLayoutSnapshot(layoutId, listOf("home"), "home", "home", "stack")) = object : NativeLayoutProvider { override val snapshot = value }
    @Test fun explicitBindingSelectsExactInstalledThemeAndLayoutVersions() {
        val registry = NativeUiPackRegistry(); registry.register(theme()); registry.register(theme("2")); registry.register(layout())
        assertThrows(IllegalArgumentException::class.java) { registry.bind(NativeUiBinding(themeId.copy(version = "missing"), layoutId)) }
        registry.bind(NativeUiBinding(themeId, layoutId))
        val revision = registry.revision
        registry.bind(NativeUiBinding(themeId, layoutId)); assertEquals(revision, registry.revision)
        registry.bind(NativeUiBinding(themeId.copy(version = "2"), layoutId))
        assertEquals("2", registry.theme().identity.version); assertTrue(registry.revision > revision)
        assertThrows(IllegalArgumentException::class.java) { registry.register(theme()) }
    }
    @Test fun unsupportedLayoutCapabilitiesAndUnknownRoutesCannotActivate() {
        val registry = NativeUiPackRegistry()
        assertThrows(IllegalArgumentException::class.java) { registry.register(layout(layout().snapshot.copy(primary = listOf("arbitrary-url")))) }
        assertThrows(IllegalArgumentException::class.java) { registry.register(layout(layout().snapshot.copy(primary = listOf("library", "library")))) }
        assertThrows(IllegalArgumentException::class.java) { registry.register(layout(layout().snapshot.copy(primary = listOf("home", "library", "ask", "sources"), navigation = "adaptive"))) }
        assertThrows(IllegalArgumentException::class.java) { registry.register(layout(layout().snapshot.copy(navigation = "script"))) }
        assertThrows(IllegalArgumentException::class.java) { registry.register(layout(layout().snapshot.copy(initial = "overview"))) }
    }

    @Test fun registrationPinsSnapshotsAndActiveRemovalRestoresTheBuiltinBinding() {
        val registry = NativeUiPackRegistry()
        val supplied = theme().snapshot.tokens.toMutableMap()
        registry.register(object : NativeThemeProvider { override val snapshot = theme().snapshot.copy(tokens = supplied) })
        registry.register(layout()); registry.setBuiltin(NativeUiBinding(themeId, layoutId))
        supplied["font-body"] = "99px"; assertEquals(14, registry.theme().dimension("font-body"))
        val alternate = theme("2"); registry.register(alternate)
        var observations = 0; val stop = registry.observe { observations++ }
        registry.bind(NativeUiBinding(alternate.snapshot.identity, layoutId)); registry.removeTheme(alternate.snapshot.identity)
        assertEquals(NativeUiBinding(themeId, layoutId), registry.activeBinding()); assertEquals(2, observations)
        stop(); assertThrows(IllegalArgumentException::class.java) { registry.removeTheme(themeId) }
        val incomplete = theme("bad").snapshot.copy(tokens = theme().snapshot.tokens - "primary-ink")
        assertThrows(IllegalArgumentException::class.java) { registry.register(object : NativeThemeProvider { override val snapshot = incomplete }) }
    }
    @Test fun nativeUnitsKeepFractionalTypographyAndPhoneTouchTargets() {
        val value = theme().snapshot
        assertEquals(48, value.dimension("control-height-mobile"))
        assertEquals(1.65, value.number("line-body"), 0.00001)
        assertEquals(-0.025, value.number("letter-title"), 0.00001)
        assertFalse(layout().snapshot.usesDetailPane(360)); assertFalse("Phone home layout stays stacked at wider widths",layout().snapshot.usesDetailPane(840))
    }
    @Test fun eachAppearanceSchemeRejectsTheSameInvalidTokensAsTheBaseBeforePublishing() {
        val invalid = listOf(
            "font-body" to "broken", "font-body" to "0px", "radius-control" to "-1px",
            "control-height-mobile" to "-1px", "control-height-mobile" to "47px",
            "control-height-mobile" to "NaNpx", "control-height-mobile" to "Infinitypx",
            "weight-body" to "99", "weight-title" to "901", "weight-section" to "NaN",
            "line-body" to "0", "line-body" to "NaN", "letter-title" to "Infinityem",
            "font" to "  ", "font-heading" to "", "ink" to "not-a-color",
        )
        for (scheme in listOf("light", "dark")) for ((key, value) in invalid) {
            val registry = NativeUiPackRegistry(); registry.register(theme()); registry.register(layout())
            registry.setBuiltin(NativeUiBinding(themeId, layoutId))
            val original = registry.theme(); val revision = registry.revision
            var notifications = 0; registry.observe { notifications++ }
            val valid = theme("variant").snapshot
            val badTokens = valid.tokens + (key to value)
            val baseError = assertThrows(IllegalArgumentException::class.java) {
                registry.register(object : NativeThemeProvider { override val snapshot = valid.copy(tokens = badTokens) })
            }
            val error = assertThrows("$scheme $key=$value", IllegalArgumentException::class.java) {
                registry.register(object : NativeThemeProvider {
                    override val snapshot = valid.copy(schemes = mapOf("light" to valid.tokens, "dark" to valid.tokens) + (scheme to badTokens))
                })
            }
            assertEquals(baseError.javaClass, error.javaClass); assertEquals(baseError.message, error.message)
            assertEquals(original, registry.theme()); assertEquals(revision, registry.revision); assertEquals(0, notifications)
            // A rejected variant must not reserve its identity or replace a committed binding.
            registry.register(object : NativeThemeProvider {
                override val snapshot = valid.copy(schemes = mapOf("light" to valid.tokens, "dark" to valid.tokens))
            })
        }
    }
    @Test fun validAppearanceSchemesKeepFractionalTypographyAndPinnedSnapshots() {
        val registry = NativeUiPackRegistry(); val base = theme().snapshot
        val light = (base.tokens + mapOf("background" to "#f7f5f1", "font-body" to "16.5px", "control-height-mobile" to "52px")).toMutableMap()
        val dark = (base.tokens + mapOf("font-body" to "20.5px", "weight-body" to "500")).toMutableMap()
        registry.register(object : NativeThemeProvider { override val snapshot = base.copy(schemes = mapOf("light" to light, "dark" to dark)) })
        registry.register(layout()); registry.setBuiltin(NativeUiBinding(themeId, layoutId))
        light["font-body"] = "broken"; dark["control-height-mobile"] = "-1px"
        registry.colorScheme("light"); assertEquals(16.5, registry.theme().number("font-body"), 0.00001)
        assertEquals(17, registry.theme().dimension("font-body")); assertEquals(52, registry.theme().dimension("control-height-mobile"))
        registry.colorScheme("dark"); assertEquals(20.5, registry.theme().number("font-body"), 0.00001)
        assertEquals(500.0, registry.theme().number("weight-body"), 0.00001)
        assertEquals(48, registry.theme().dimension("control-height-mobile"))
    }
    @Test fun oneBrokenWindowObserverCannotPreventOtherWindowsFromReceivingTheCommittedBinding() {
        val registry = NativeUiPackRegistry(); registry.register(theme()); registry.register(theme("2")); registry.register(layout())
        registry.setBuiltin(NativeUiBinding(themeId, layoutId))
        registry.observe { throw IllegalStateException("Generated exception text must never enter the status") }
        var notified = false; registry.observe { notified = true }
        registry.bind(NativeUiBinding(themeId.copy(version = "2"), layoutId))
        assertTrue(notified); assertEquals("2", registry.activeBinding().theme.version)
        assertEquals(listOf(NativeUiNotificationError(0)), registry.getNotificationErrors())
    }
    @Test fun workCitationsPreserveTypedEvidenceNamespaces() {
        for (reference in listOf("memory:generated-memory@1", "material:mat_${"a".repeat(64)}@${"b".repeat(64)}", "artifact:generated@1")) assertEquals(reference, CentralEvidenceReference.normalize(reference))
        val id = "14254e08-7dc5-4c6b-a6cb-a5fa9bad807b"
        assertEquals("capture:$id", CentralEvidenceReference.normalize(id))
    }
    @Test fun relatedWorkMapsLibraryBeforeCheckingNativeDestinations() {
        val pages = CentralScreens.pages.map { it.first }.toSet()
        for (kind in listOf("image", "material-index")) {
            val work = JSONObject().put("kind", kind).put("destination", "library")
            assertEquals("archive", CentralWorkPresentation.destination(work.getString("destination"), pages))
        }
        for (page in pages) assertEquals(page, CentralWorkPresentation.destination(page, pages))
        for (unknown in listOf("", "unknown", "https://example.invalid", "#/library")) {
            assertThrows(IllegalArgumentException::class.java) { CentralWorkPresentation.destination(unknown, pages) }
        }
    }
    @Test fun workProgressUsesActualProductReceiptsAndNeverInventsAPercentage() {
        assertEquals("已处理 3 / 9 条资料", CentralWorkPresentation.progress(JSONObject().put("mode", "determinate").put("completed", 3).put("total", 9)))
        assertEquals("查找资料", CentralWorkPresentation.progress(JSONObject().put("mode", "semantic").put("stage", "searching")))
        assertEquals("Generated literal evidence", CentralWorkPresentation.progress(JSONObject().put("mode", "semantic").put("stage", "searching").put("summary", "Generated literal evidence")))
        assertEquals("需要处理", CentralWorkPresentation.state("needs_input"))
    }
}
