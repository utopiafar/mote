import Foundation

/// Display-only formatting for conversation turns. The original model text
/// stays the export and persistence authority; these transforms only shape
/// what the thread renders. Positions are Character offsets into `text`.
public enum ConversationPresentation {
    public struct Emphasis: Equatable, Sendable {
        public let start: Int
        public let end: Int
        public let bold: Bool

        public init(start: Int, end: Int, bold: Bool) {
            self.start = start
            self.end = end
            self.bold = bold
        }
    }

    public struct CitationSpan: Equatable, Sendable {
        public let start: Int
        public let end: Int
        public let id: String
        public let number: Int

        public init(start: Int, end: Int, id: String, number: Int) {
            self.start = start
            self.end = end
            self.id = id
            self.number = number
        }
    }

    public struct Display: Equatable, Sendable {
        public let text: String
        public let emphasis: [Emphasis]
        public let citations: [CitationSpan]
    }

    /// Citation numbers accumulate across the whole conversation in
    /// first-appearance order, matching the numbering the answer markers were
    /// written against.
    public static func citationNumbers(turns: [ConversationTurn]) -> [String: Int] {
        var numbers: [String: Int] = [:]
        for turn in turns {
            guard let result = turn.result else { continue }
            var seen = Set<String>()
            for citation in result.citations where seen.insert(citation.id).inserted {
                if numbers[citation.id] == nil { numbers[citation.id] = numbers.count + 1 }
            }
        }
        return numbers
    }

    /// The citations shown as cards under one turn are the ones not yet
    /// introduced by an earlier turn.
    public static func newCitations(turn: ConversationTurn, shown: inout Set<String>) -> [Answer.Citation] {
        guard let result = turn.result else { return [] }
        var seen = Set<String>()
        return result.citations.filter { citation in
            seen.insert(citation.id).inserted && shown.insert(citation.id).inserted
        }
    }

    public static func citationName(_ citation: Answer.Citation) -> String {
        let title = citation.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !title.isEmpty { return title }
        let appName = citation.appName.trimmingCharacters(in: .whitespacesAndNewlines)
        return appName.isEmpty ? "查看原文依据" : appName
    }

    /// Card subtitle: the stored position label, otherwise the capture day
    /// and time in the owner's calendar.
    public static func citationSubtitle(_ citation: Answer.Citation, now: Date = Date(),
                                        calendar: Calendar = .current) -> String {
        if let location = citation.location?.trimmingCharacters(in: .whitespacesAndNewlines), !location.isEmpty {
            return location
        }
        guard let captured = CentralTimestamp.parse(citation.contentAt ?? citation.capturedAt) else { return "记录" }
        let day: String
        if calendar.isDate(captured, inSameDayAs: now) {
            day = "今天"
        } else if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
                  calendar.isDate(captured, inSameDayAs: yesterday) {
            day = "昨天"
        } else {
            day = "\(calendar.component(.month, from: captured))月\(calendar.component(.day, from: captured))日"
        }
        let time = captured.formatted(Date.FormatStyle(time: .shortened).locale(Locale(identifier: "zh_CN")))
        return "记录 · \(day) \(time)"
    }

    public static func turnNotice(_ turn: ConversationTurn) -> String? {
        if turn.evidenceDeleted == true { return "相关证据已删除，这条历史回答已清除。可以继续提问查阅现有记录。" }
        if turn.evidenceUnavailable == true { return "引用原文已删除，历史问答仍保留。" }
        if turn.evidenceStale == true { return "这是历史版本，当前资料已更新。" }
        return nil
    }

    /// The scope chip above the composer: the resolved material title, the
    /// record title carried by the reader entry point, or the fixed label for
    /// each remaining scope kind.
    public static func scopeLabel(scope: ConversationScope, materialTitle: String?) -> String? {
        if scope.anchorMaterialRef?.isEmpty == false {
            return materialTitle ?? "参考整份资料"
        }
        if scope.anchorEvidenceIds?.isEmpty == false {
            return materialTitle ?? "参考这条记录，自动查找相关上下文"
        }
        if scope.evidenceIds?.isEmpty == false { return "仅查这条记录" }
        return nil
    }

    /// Turn-detail facts for the 更多 sheet: the model that answered, how many
    /// sources were cited, and the reported cost.
    public static func turnDetails(answer: Answer) -> [(String, String)] {
        let selected = answer.modelSelection?.model?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let usage = answer.usage?.model?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let model = !selected.isEmpty ? selected : (!usage.isEmpty ? usage : "未记录")
        let cost: String
        if let estimate = answer.usage?.estimatedCost, estimate.isFinite, estimate >= 0 {
            let amount = estimate.formatted(.number.precision(.fractionLength(0...6)).locale(Locale(identifier: "zh_CN")))
            cost = "\(amount) \(answer.usage?.currency ?? "")".trimmingCharacters(in: .whitespaces)
        } else {
            cost = "未提供估价"
        }
        return [
            ("使用模型", model),
            ("检索", answer.citations.isEmpty ? "没有档案引用" : "\(answer.citations.count) 份已引用资料"),
            ("费用", cost),
        ]
    }
}

// MARK: - Answer text formatting

extension ConversationPresentation {
    private struct MarkMatch {
        let range: Range<Int>
        let inner: Range<Int>
        let bold: Bool
    }

    private struct BracketMatch {
        let range: Range<Int>
        let id: String
    }

    /// Replace verified `[citation-id]` markers with their numbered chips,
    /// strip the light markdown the thread renders natively, and keep code
    /// spans, fenced blocks, authored links and image markers untouched.
    public static func formatAnswer(_ answer: String, numbers: [String: Int]) -> Display {
        let source = Array(prepareLines(answer))
        let sourceBlocked = protectedMask(source)
        var prose: [Character] = []
        var emphasis: [Emphasis] = []
        var offset = 0
        for match in markMatches(source) {
            if escaped(source, match.range.lowerBound) || match.range.contains(where: { sourceBlocked[$0] }) { continue }
            prose.append(contentsOf: source[offset..<match.range.lowerBound])
            let start = prose.count
            prose.append(contentsOf: source[match.inner])
            emphasis.append(Emphasis(start: start, end: prose.count, bold: match.bold))
            offset = match.range.upperBound
        }
        prose.append(contentsOf: source[offset...])
        let text = prose
        let blocked = protectedMask(text)
        let references = referenceDefinitionNames(text, blocked: blocked)
        var output: [Character] = []
        var citations: [CitationSpan] = []
        var replacements: [(start: Int, end: Int, length: Int)] = []
        offset = 0
        for match in bracketMatches(text) {
            if escaped(text, match.range.lowerBound) || match.range.contains(where: { blocked[$0] }) { continue }
            if match.range.upperBound < text.count,
               text[match.range.upperBound] == "(" || text[match.range.upperBound] == "[" { continue }
            guard let number = numbers[match.id] else { continue }
            if references.contains(match.id.trimmingCharacters(in: .whitespaces).lowercased()) { continue }
            if match.range.lowerBound > 0, text[match.range.lowerBound - 1] == "!" { continue }
            output.append(contentsOf: text[offset..<match.range.lowerBound])
            let start = output.count
            // Bare number padded so the tinted span reads as a pill, matching
            // the canvas's round citation chips.
            let label = " \(number) "
            output.append(contentsOf: label)
            citations.append(CitationSpan(start: start, end: output.count, id: match.id, number: number))
            replacements.append((match.range.lowerBound, match.range.upperBound, label.count))
            offset = match.range.upperBound
        }
        output.append(contentsOf: text[offset...])
        func translated(_ position: Int) -> Int {
            var delta = 0
            for replacement in replacements {
                if position <= replacement.start { break }
                if position < replacement.end {
                    return replacement.start + delta + (position == replacement.start ? 0 : replacement.length)
                }
                delta += replacement.length - (replacement.end - replacement.start)
            }
            return position + delta
        }
        return Display(text: String(output),
                       emphasis: emphasis.map { Emphasis(start: translated($0.start), end: translated($0.end), bold: $0.bold) },
                       citations: citations)
    }

    private static func escaped(_ text: [Character], _ position: Int) -> Bool {
        var index = position - 1
        while index >= 0 && text[index] == "\\" { index -= 1 }
        return (position - index - 1) % 2 == 1
    }

    /// `**x**`/`__x__` bold and `*x*` italic, mirroring the shared marks
    /// pattern; runs containing `*`/`\n` (or `_`/`\n` for `__`) never match.
    private static func markMatches(_ text: [Character]) -> [MarkMatch] {
        var output: [MarkMatch] = []
        var index = 0
        while index < text.count {
            if index + 1 < text.count, text[index] == "*", text[index + 1] == "*",
               let close = closingPair(text, from: index + 2, first: "*", second: "*") {
                let inner = (index + 2)..<close
                if !inner.isEmpty, !inner.contains(where: { text[$0] == "*" || text[$0] == "\n" }) {
                    output.append(MarkMatch(range: index..<(close + 2), inner: inner, bold: true))
                    index = close + 2
                    continue
                }
            }
            if index + 1 < text.count, text[index] == "_", text[index + 1] == "_",
               let close = closingPair(text, from: index + 2, first: "_", second: "_") {
                let inner = (index + 2)..<close
                if !inner.isEmpty, !inner.contains(where: { text[$0] == "_" || text[$0] == "\n" }) {
                    output.append(MarkMatch(range: index..<(close + 2), inner: inner, bold: true))
                    index = close + 2
                    continue
                }
            }
            if text[index] == "*",
               index == 0 || text[index - 1] != "*",
               index + 1 >= text.count || text[index + 1] != "*" {
                var search = index + 1
                while search < text.count, text[search] != "*" { search += 1 }
                if search > index + 1, search < text.count,
                   search + 1 >= text.count || text[search + 1] != "*" {
                    let inner = (index + 1)..<search
                    if !inner.contains(where: { text[$0] == "\n" }) {
                        output.append(MarkMatch(range: index..<(search + 1), inner: inner, bold: false))
                        index = search + 1
                        continue
                    }
                }
            }
            index += 1
        }
        return output
    }

    private static func closingPair(_ text: [Character], from start: Int,
                                    first: Character, second: Character) -> Int? {
        var index = start
        while index + 1 < text.count {
            if text[index] == first, text[index + 1] == second { return index }
            index += 1
        }
        return nil
    }

    /// `\[([^\]\r\n]+)]` — a bracket whose content stops at the first `]`.
    private static func bracketMatches(_ text: [Character]) -> [BracketMatch] {
        var output: [BracketMatch] = []
        var index = 0
        while index < text.count {
            if text[index] == "[" {
                var close = index + 1
                while close < text.count, text[close] != "]", text[close] != "\r", text[close] != "\n" { close += 1 }
                if close < text.count, text[close] == "]", close > index + 1 {
                    output.append(BracketMatch(range: index..<(close + 1), id: String(text[(index + 1)..<close])))
                }
                index = close > index + 1 ? close : index + 1
            } else {
                index += 1
            }
        }
        return output
    }

    /// `^[ \t]{0,3}(?:>[ \t]?)*(?:(?:[-*+•]|[0-9]+[.)])[ \t]+)?(`{3,}|~{3,})` —
    /// returns the fence char, run length and the offset right after the run.
    private static func fenceMarker(_ line: [Character]) -> (char: Character, length: Int, end: Int)? {
        var index = 0
        var margin = 0
        while index < line.count, margin < 3, line[index] == " " || line[index] == "\t" {
            index += 1; margin += 1
        }
        while index < line.count, line[index] == ">" {
            index += 1
            if index < line.count, line[index] == " " || line[index] == "\t" { index += 1 }
        }
        if index < line.count, "-*+•".contains(line[index]) {
            var cursor = index + 1
            while cursor < line.count, line[cursor] == " " || line[cursor] == "\t" { cursor += 1 }
            if cursor > index + 1 { index = cursor }
        } else if index < line.count, line[index].isNumber {
            var cursor = index
            while cursor < line.count, line[cursor].isNumber { cursor += 1 }
            if cursor < line.count, line[cursor] == "." || line[cursor] == ")" {
                var after = cursor + 1
                while after < line.count, line[after] == " " || line[after] == "\t" { after += 1 }
                if after > cursor + 1 { index = after }
            }
        }
        guard index < line.count, line[index] == "`" || line[index] == "~" else { return nil }
        let char = line[index]
        var length = 0
        while index < line.count, line[index] == char { index += 1; length += 1 }
        guard length >= 3 else { return nil }
        return (char, length, index)
    }

    /// Marks positions inside fenced code, indented code, inline code and
    /// authored links/images so citation replacement skips them.
    private static func protectedMask(_ text: [Character]) -> [Bool] {
        var blocked = [Bool](repeating: false, count: text.count)
        func mark(_ range: Range<Int>) {
            for i in range where i < text.count { blocked[i] = true }
        }
        var fenceChar: Character? = nil
        var fenceSize = 0
        var lineStart = 0
        while lineStart < text.count {
            let next = (text[lineStart...].firstIndex(of: "\n").map { $0 + 1 }) ?? text.count
            let line = Array(text[lineStart..<next])
            let marker = fenceMarker(line)
            if fenceChar != nil {
                mark(lineStart..<next)
                if let marker, marker.char == fenceChar, marker.length >= fenceSize,
                   line[marker.end...].allSatisfy({ $0 == " " || $0 == "\t" || $0 == "\n" }) {
                    fenceChar = nil
                }
            } else if let marker {
                fenceChar = marker.char
                fenceSize = marker.length
                mark(lineStart..<next)
            } else if line.starts(with: [" ", " ", " ", " "]) || line.starts(with: ["\t"]) {
                mark(lineStart..<next)
            }
            lineStart = next
        }
        var index = 0
        while index < text.count {
            if !blocked[index], text[index] == "`", !escaped(text, index) {
                var endRun = index + 1
                while endRun < text.count, text[endRun] == "`" { endRun += 1 }
                let delimiter = Array(text[index..<endRun])
                var close = indexOf(delimiter, in: text, from: endRun)
                while let found = close,
                      (found > 0 && text[found - 1] == "`")
                        || (found + delimiter.count < text.count && text[found + delimiter.count] == "`") {
                    close = indexOf(delimiter, in: text, from: found + 1)
                }
                if let close {
                    mark(index..<(close + delimiter.count))
                    index = close + delimiter.count
                    continue
                }
            }
            index += 1
        }
        index = 0
        while index < text.count {
            if (text[index] == "!" || text[index] == "["), !escaped(text, index) {
                var bracket = index
                if text[index] == "!" {
                    guard index + 1 < text.count, text[index + 1] == "[" else {
                        index += 1
                        continue
                    }
                    bracket = index + 1
                }
                if let closeBracket = scanSegment(text, from: bracket + 1, terminator: "]"),
                   closeBracket + 1 < text.count {
                    let next = closeBracket + 1
                    if text[next] == "(" {
                        if let closeParen = scanSegment(text, from: next + 1, terminator: ")") {
                            mark(index..<(closeParen + 1))
                            index = closeParen + 1
                            continue
                        }
                    } else if text[next] == "[" {
                        if let second = scanSegment(text, from: next + 1, terminator: "]") {
                            mark(index..<(second + 1))
                            index = second + 1
                            continue
                        }
                    }
                }
            }
            index += 1
        }
        return blocked
    }

    /// Scan `(?:\\.|[^X\\])*` then `X` — returns the terminator offset.
    private static func scanSegment(_ text: [Character], from start: Int, terminator: Character) -> Int? {
        var index = start
        while index < text.count {
            if text[index] == "\\" {
                index += 2
                continue
            }
            if text[index] == terminator { return index }
            index += 1
        }
        return nil
    }

    private static func indexOf(_ needle: [Character], in text: [Character], from start: Int) -> Int? {
        guard !needle.isEmpty, start + needle.count <= text.count else { return nil }
        var index = start
        while index + needle.count <= text.count {
            if Array(text[index..<(index + needle.count)]) == needle { return index }
            index += 1
        }
        return nil
    }

    /// `(?m)^[ \t]{0,3}\[([^\]\r\n]+)]:[ \t]*\S.*$` — link reference
    /// definition names, so `[name]: url` lines keep their brackets.
    private static func referenceDefinitionNames(_ text: [Character], blocked: [Bool]) -> Set<String> {
        var names = Set<String>()
        var lineStart = 0
        while lineStart < text.count {
            let lineEnd = text[lineStart...].firstIndex(of: "\n") ?? text.count
            let line = Array(text[lineStart..<lineEnd])
            var index = 0
            var margin = 0
            while index < line.count, margin < 3, line[index] == " " || line[index] == "\t" {
                index += 1; margin += 1
            }
            if index < line.count, line[index] == "[", !blocked[lineStart + index] {
                var close = index + 1
                while close < line.count, line[close] != "]", line[close] != "\r" { close += 1 }
                if close < line.count, line[close] == "]", close > index + 1, close + 1 < line.count,
                   line[close + 1] == ":" {
                    var cursor = close + 2
                    while cursor < line.count, line[cursor] == " " || line[cursor] == "\t" { cursor += 1 }
                    if cursor < line.count {
                        names.insert(String(line[(index + 1)..<close])
                            .trimmingCharacters(in: .whitespaces).lowercased())
                    }
                }
            }
            lineStart = lineEnd < text.count ? lineEnd + 1 : text.count
        }
        return names
    }

    /// The light line-level markdown the thread renders natively: `>` quote
    /// markers drop, list bullets become `•`, heading `#` runs drop. Fenced
    /// and indented code passes through untouched.
    private static func prepareLines(_ original: String) -> [Character] {
        var output: [Character] = []
        var fenceChar: Character? = nil
        var fenceSize = 0
        var start = original.startIndex
        while start < original.endIndex {
            let next = original[start...].firstIndex(of: "\n").map { original.index(after: $0) } ?? original.endIndex
            var line = Array(original[start..<next])
            let marker = fenceMarker(line)
            let inCode = fenceChar != nil || marker != nil
            if fenceChar != nil, let marker, marker.char == fenceChar, marker.length >= fenceSize,
               line[marker.end...].allSatisfy({ $0 == " " || $0 == "\t" || $0 == "\n" }) {
                fenceChar = nil
            } else if fenceChar == nil, let marker {
                fenceChar = marker.char
                fenceSize = marker.length
            }
            if !(inCode || line.starts(with: [" ", " ", " ", " "]) || line.starts(with: ["\t"])) {
                line = stripLineMarks(line)
            }
            output.append(contentsOf: line)
            start = next
        }
        return output
    }

    /// `^[ \t]{0,3}>[ \t]?` → "", `^[ \t]*[-*+] +` → "• ", `^#{1,6} +` → "".
    private static func stripLineMarks(_ line: [Character]) -> [Character] {
        var out = line
        var index = 0
        var margin = 0
        while index < out.count, margin < 3, out[index] == " " || out[index] == "\t" {
            index += 1; margin += 1
        }
        if index < out.count, out[index] == ">" {
            var cursor = index + 1
            if cursor < out.count, out[cursor] == " " || out[cursor] == "\t" { cursor += 1 }
            out = Array(out[cursor...])
        }
        index = 0
        while index < out.count, out[index] == " " || out[index] == "\t" { index += 1 }
        if index < out.count, "-*+".contains(out[index]) {
            var cursor = index + 1
            while cursor < out.count, out[cursor] == " " { cursor += 1 }
            if cursor > index + 1 {
                out = Array("• ") + out[cursor...]
            }
        } else if out.first == "#" {
            var cursor = 0
            var hashes = 0
            while cursor < out.count, out[cursor] == "#", hashes < 6 { cursor += 1; hashes += 1 }
            if cursor < out.count, out[cursor] == " " {
                var after = cursor
                while after < out.count, out[after] == " " { after += 1 }
                out = Array(out[after...])
            }
        }
        return out
    }
}
