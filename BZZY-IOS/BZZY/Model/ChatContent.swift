import Foundation

// Display windows are independent of Core's durable event cursor and private
// replay cache. Anchoring IDs keeps incoming replies from moving older reading.
struct ConversationHistoryWindow {
    static let pageSize = 50
    static let maximumVisible = 200
    private var firstID: UUID?
    private(set) var count = pageSize

    func range(in messages: [LocalMessage]) -> Range<Int> {
        if let firstID {
            let start = messages.firstIndex { $0.id == firstID } ?? 0
            return start..<min(messages.count, start + count)
        }
        return max(0, messages.count - count)..<messages.count
    }
    func visible(in messages: [LocalMessage]) -> [LocalMessage] { Array(messages[range(in: messages)]) }
    func hasEarlier(in messages: [LocalMessage]) -> Bool { range(in: messages).lowerBound > 0 }
    func includesLatest(in messages: [LocalMessage]) -> Bool { range(in: messages).upperBound == messages.count }
    mutating func showLatest() { firstID = nil; count = Self.pageSize }
    mutating func freeze(in messages: [LocalMessage]) {
        if firstID == nil { firstID = visible(in: messages).first?.id }
    }
    @discardableResult mutating func revealEarlier(in messages: [LocalMessage]) -> Bool {
        let current = range(in: messages)
        guard current.lowerBound > 0 else { return false }
        let start = max(0, current.lowerBound - Self.pageSize)
        firstID = messages[start].id
        count = min(Self.maximumVisible, current.count + current.lowerBound - start)
        return true
    }
}

// Presentation only: this document cannot carry commands or runtime permissions.
enum ChatTextSize: String { case small, normal, large }
enum ChatTextColor: String { case mint, amber, coral, blue, lavender, muted }
struct ChatTextStyle: Equatable {
    var bold = false
    var italic = false
    var code = false
    var size: ChatTextSize = .normal
    var color: ChatTextColor?
}
struct ChatSpan: Equatable {
    var text: String
    var style = ChatTextStyle()
}
struct ChatTable: Equatable {
    var headers: [[ChatSpan]]
    var rows: [[[ChatSpan]]]
}
enum ChatBlock: Equatable {
    case paragraph([ChatSpan]), heading(Int, [ChatSpan]), listItem(String, [ChatSpan])
    case table(ChatTable), code(String, String), quote([ChatSpan]), divider
}
struct ChatContent: Equatable {
    let blocks: [ChatBlock]
    let isFormatted: Bool
    static func parse(_ source: String) -> ChatContent {
        let text = String(decoding: source.utf8.prefix(65_536), as: UTF8.self)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("<message"), source.utf8.count <= 65_536,
              let blocks = try? MessageMarkup.parse(trimmed) else {
            return ChatContent(blocks: [.paragraph([ChatSpan(text: text)])], isFormatted: false)
        }
        return ChatContent(blocks: blocks, isFormatted: true)
    }
    var plainText: String {
        blocks.map { block in
            switch block {
            case .paragraph(let spans), .heading(_, let spans), .quote(let spans): return spans.map(\.text).joined()
            case .listItem(let marker, let spans): return marker + " " + spans.map(\.text).joined()
            case .code(_, let text): return text
            case .table(let table):
                return ([table.headers] + table.rows).map { $0.map { $0.map(\.text).joined() }.joined(separator: " · ") }.joined(separator: "\n")
            case .divider: return ""
            }
        }.joined(separator: "\n\n")
    }
}

private final class MessageNode {
    let tag: String
    let attributes: [String: String]
    var children: [MessageNode] = []
    var text = ""
    init(_ tag: String, attributes: [String: String] = [:]) { self.tag = tag; self.attributes = attributes }
}

private enum MessageMarkupError: Error { case invalid }
private final class MessageMarkup: NSObject, XMLParserDelegate {
    private var stack: [MessageNode] = []
    private var root: MessageNode?
    private var count = 0
    private var failed = false
    private static let attributes: [String: Set<String>] = [
        "message": ["version"], "p": ["size"], "h1": [], "h2": [], "b": [], "strong": [], "i": [], "em": [],
        "span": ["size", "color"], "br": [], "code": [], "table": [], "tr": [], "th": [], "td": [],
        "thead": [], "tbody": [], "ul": [], "ol": [], "li": [], "pre": ["language"], "blockquote": [], "hr": []
    ]
    static func parse(_ source: String) throws -> [ChatBlock] {
        // Reject declarations before XMLParser can expand entities or resolve resources.
        guard source.range(of: "<!DOCTYPE", options: .caseInsensitive) == nil,
              source.range(of: "<!ENTITY", options: .caseInsensitive) == nil else { throw MessageMarkupError.invalid }
        let delegate = MessageMarkup()
        let parser = XMLParser(data: Data(source.utf8))
        parser.delegate = delegate
        parser.shouldResolveExternalEntities = false
        parser.externalEntityResolvingPolicy = .never
        guard parser.parse(), !delegate.failed, let root = delegate.root,
              root.tag == "message", root.attributes == ["version": "1"] else { throw MessageMarkupError.invalid }
        let nodes = try elements(root)
        guard nodes.count <= 128 else { throw MessageMarkupError.invalid }
        return try nodes.flatMap(blocks)
    }
    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String: String]) {
        count += 1
        guard !failed, count <= 2048, stack.count < 12, let allowed = Self.attributes[elementName],
              Set(attributeDict.keys).isSubset(of: allowed), namespaceURI == nil, !elementName.contains(":"),
              attributeDict["size"].map({ ChatTextSize(rawValue: $0) != nil }) ?? true,
              attributeDict["color"].map({ ChatTextColor(rawValue: $0) != nil }) ?? true,
              attributeDict["language"].map({ $0.range(of: "^[A-Za-z0-9_+#-]{1,24}$", options: .regularExpression) != nil }) ?? true else {
            failed = true; parser.abortParsing(); return
        }
        let node = MessageNode(elementName, attributes: attributeDict)
        if let parent = stack.last { parent.children.append(node) }
        else if root == nil { root = node }
        else { failed = true; parser.abortParsing(); return }
        stack.append(node)
    }
    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) { _ = stack.popLast() }
    func parser(_ parser: XMLParser, foundCharacters string: String) {
        guard let parent = stack.last, !string.isEmpty else { return }
        if let last = parent.children.last, last.tag == "#text" { last.text += string }
        else {
            count += 1
            guard count <= 2048 else { failed = true; parser.abortParsing(); return }
            let node = MessageNode("#text"); node.text = string; parent.children.append(node)
        }
    }
    func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) { self.parser(parser, foundCharacters: String(decoding: CDATABlock, as: UTF8.self)) }
    func parser(_ parser: XMLParser, resolveExternalEntityName name: String, systemID: String?) -> Data? { nil }
    func parser(_ parser: XMLParser, foundInternalEntityDeclarationWithName name: String, value: String?) { failed = true; parser.abortParsing() }
    func parser(_ parser: XMLParser, foundExternalEntityDeclarationWithName name: String, publicID: String?, systemID: String?) { failed = true; parser.abortParsing() }

    private static func elements(_ node: MessageNode) throws -> [MessageNode] {
        guard !node.children.contains(where: { $0.tag == "#text" && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            throw MessageMarkupError.invalid
        }
        return node.children.filter { $0.tag != "#text" }
    }
    private static func spans(_ node: MessageNode, style: ChatTextStyle = .init()) throws -> [ChatSpan] {
        var result: [ChatSpan] = []
        for child in node.children {
            var next = style
            switch child.tag {
            case "#text": result.append(ChatSpan(text: child.text, style: next)); continue
            case "b", "strong": next.bold = true
            case "i", "em": next.italic = true
            case "code": next.code = true
            case "span":
                if let value = child.attributes["size"] { next.size = ChatTextSize(rawValue: value)! }
                if let value = child.attributes["color"] { next.color = ChatTextColor(rawValue: value) }
            case "br":
                guard child.children.isEmpty else { throw MessageMarkupError.invalid }
                result.append(ChatSpan(text: "\n", style: next)); continue
            default: throw MessageMarkupError.invalid
            }
            result += try spans(child, style: next)
        }
        return result
    }
    private static func blocks(_ node: MessageNode) throws -> [ChatBlock] {
        switch node.tag {
        case "p":
            var style = ChatTextStyle()
            if let value = node.attributes["size"] { style.size = ChatTextSize(rawValue: value)! }
            return [.paragraph(try spans(node, style: style))]
        case "h1", "h2": return [.heading(node.tag == "h1" ? 1 : 2, try spans(node))]
        case "blockquote": return [.quote(try spans(node))]
        case "hr":
            guard node.children.isEmpty else { throw MessageMarkupError.invalid }; return [.divider]
        case "ul", "ol":
            let items = try elements(node)
            guard items.count <= 64, items.allSatisfy({ $0.tag == "li" }) else { throw MessageMarkupError.invalid }
            return try items.enumerated().map { index, item in .listItem(node.tag == "ol" ? "\(index + 1)." : "•", try spans(item)) }
        case "pre":
            let content = try spans(node).map(\.text).joined()
            return [.code(node.attributes["language"] ?? "", content)]
        case "table":
            let groups = try elements(node)
            var rows: [MessageNode] = []
            for group in groups {
                if group.tag == "tr" { rows.append(group) }
                else if ["thead", "tbody"].contains(group.tag) { rows += try elements(group) }
                else { throw MessageMarkupError.invalid }
            }
            guard !rows.isEmpty, rows.count <= 65, rows.allSatisfy({ $0.tag == "tr" }) else { throw MessageMarkupError.invalid }
            let cells = try rows.map(elements)
            guard let first = cells.first, (1...6).contains(first.count), first.allSatisfy({ $0.tag == "th" }),
                  cells.dropFirst().allSatisfy({ $0.count == first.count && $0.allSatisfy({ $0.tag == "td" }) }) else { throw MessageMarkupError.invalid }
            return [.table(ChatTable(headers: try first.map { try spans($0) }, rows: try cells.dropFirst().map { try $0.map { try spans($0) } }))]
        default: throw MessageMarkupError.invalid
        }
    }
}
