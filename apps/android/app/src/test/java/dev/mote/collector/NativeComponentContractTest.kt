package dev.mote.collector

import dev.mote.collector.ui.MoteGlyph
import dev.mote.collector.ui.MoteIconButtonSpec
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** V06: phone radii come from theme tokens; every icon button is named and 48dp. */
class NativeComponentContractTest {
    private val module = File(checkNotNull(System.getProperty("user.dir")))
    private val nativeUi = File(module, "src/main/java/dev/mote/collector/NativeUi.kt").readText()

    private fun callArguments(source: String, name: String): List<List<String>> {
        val args = mutableListOf<List<String>>()
        var at = source.indexOf("$name(")
        while (at >= 0) {
            var depth = 0; var start = -1
            for (i in at + name.length until source.length) {
                when (source[i]) {
                    '(' -> { depth++; if (depth == 1) start = i + 1 }
                    ')' -> { depth--; if (depth == 0) { args += splitTopLevel(source.substring(start, i)); break } }
                }
                if (depth == 0) break
            }
            at = source.indexOf("$name(", at + name.length)
        }
        return args
    }
    private fun splitTopLevel(body: String): List<String> {
        val parts = mutableListOf<String>(); var depth = 0; var current = StringBuilder()
        for (c in body) {
            when (c) {
                '(', '[', '{' -> depth++
                ')', ']', '}' -> depth--
            }
            if (c == ',' && depth == 0) { parts += current.toString(); current = StringBuilder() } else current.append(c)
        }
        parts += current.toString(); return parts.map { it.trim() }.filter { it.isNotEmpty() }
    }

    @Test fun nativeUiReadsEveryRadiusFromThemeTokens() {
        val literal = Regex("""^-?\d+(\.\d+)?[fF]?$""")
        val measured = Regex("""moteDp\(\d+\)""")
        val offenders = mutableListOf<String>()
        for (name in listOf("shape", "clickable")) for (args in callArguments(nativeUi, name)) {
            // Radius is the argument after the fill role/color.
            args.drop(2).filter { literal.matches(it) || measured.matches(it) }.forEach { offenders += "$name($it)" }
        }
        assertEquals("Hard-coded corner radii must read the mobile radius tokens", emptyList<String>(), offenders)
    }

    @Test fun everyIconButtonSpecIsNamedAndKeepsTheTouchTarget() {
        for (glyph in MoteGlyph.entries) {
            val spec = MoteIconButtonSpec(glyph, glyph.a11yKey)
            assertTrue("${glyph.name} icon button needs a non-empty contentDescription source", spec.description.isNotBlank())
            assertTrue("${glyph.name} icon button shrank below the touch target", spec.touchSizeDp >= 48)
        }
        assertThrows(IllegalArgumentException::class.java) { MoteIconButtonSpec(MoteGlyph.GEAR, " ") }
        assertThrows(IllegalArgumentException::class.java) { MoteIconButtonSpec(MoteGlyph.GEAR, "设置", touchSizeDp = 47) }
    }

    @Test fun everyGlyphHasASharedVectorDrawable() {
        for (glyph in MoteGlyph.entries) {
            val file = File(module, "src/main/res/drawable/ic_${glyph.name.lowercase()}.xml")
            assertTrue("Missing vector drawable for ${glyph.name}: ${file.path}", file.isFile)
        }
    }

    @Test fun historicalIconKindsResolveOntoTheSharedLineSet() {
        val kinds = sortedSetOf<String>()
        File(module, "src/main/java").walkTopDown().filter { it.extension == "kt" }.forEach { file ->
            val source = file.readText()
            Regex("""MoteNavigationIcon\([^)]*?"([a-z]+)"""").findAll(source).forEach { kinds += it.groupValues[1] }
            source.lineSequence().filter { "menu(" in it }.forEach { line ->
                Regex(""""([a-z]+)"""").findAll(line).lastOrNull()?.let { kinds += it.groupValues[1] }
            }
        }
        val unmapped = kinds.filterNot { MoteGlyph.hasKind(it) }
        assertEquals("Icon kinds without a shared-set mapping", emptyList<String>(), unmapped)
    }
}
