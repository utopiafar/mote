package dev.mote.collector

/** RFC 8259 syntax validation before Android's deliberately lenient JSONObject parser. */
internal object StrictJson {
    fun validate(text: String) { Parser(text).parse() }
    private class Parser(private val text: String) {
        private var at = 0
        private fun ws() { while (at < text.length && text[at] in " \t\r\n") at++ }
        private fun take(c: Char): Boolean { ws(); if (at < text.length && text[at] == c) { at++; return true }; return false }
        private fun expect(c: Char) { require(take(c)) { "JSON syntax" } }
        fun parse() { value(0); ws(); require(at == text.length) { "Trailing JSON content" } }
        private fun value(depth: Int) {
            require(depth < 16); ws(); require(at < text.length)
            when (text[at]) {
                '{' -> { at++; val keys = mutableSetOf<String>(); if (take('}')) return
                    do { ws(); val start = at; string(); val key = org.json.JSONTokener(text.substring(start, at)).nextValue() as String
                        require(keys.add(key)) { "Duplicate JSON key" }; expect(':'); value(depth + 1)
                    } while (take(',')); expect('}') }
                '[' -> { at++; if (take(']')) return; do { value(depth + 1) } while (take(',')); expect(']') }
                '"' -> string()
                't' -> literal("true")
                'f' -> literal("false")
                'n' -> literal("null")
                else -> { val match = Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?").find(text, at)
                    require(match != null && match.range.first == at); at = match.range.last + 1 }
            }
        }
        private fun literal(value: String) { require(text.startsWith(value, at)); at += value.length }
        private fun string() {
            expect('"')
            while (at < text.length) {
                val c = text[at++]; if (c == '"') return
                require(c.code >= 32)
                if (c == '\\') {
                    require(at < text.length)
                    when (text[at++]) {
                        '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> Unit
                        'u' -> { repeat(4) { require(at < text.length && text[at++] in "0123456789abcdefABCDEF") } }
                        else -> error("Invalid JSON escape")
                    }
                }
            }
            error("Unclosed JSON string")
        }
    }
}
