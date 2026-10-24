import SwiftUI

struct ChatRichText: View {
    let content: ChatContent
    @ScaledMetric(relativeTo: .body) private var bodySize = 15.0
    @ScaledMetric(relativeTo: .body) private var cellWidth = 112.0
    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            ForEach(Array(content.blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let spans): inline(spans)
                case .heading(let level, let spans): inline(spans, heading: level)
                case .listItem(let marker, let spans):
                    HStack(alignment: .top, spacing: 9) {
                        Text(marker).foregroundStyle(BZZYTheme.accent).font(.system(size: bodySize, design: .monospaced))
                        inline(spans)
                    }
                case .quote(let spans):
                    HStack(alignment: .top, spacing: 12) {
                        RoundedRectangle(cornerRadius: 2).fill(BZZYTheme.accent.opacity(0.65)).frame(width: 2)
                        inline(spans).foregroundStyle(BZZYTheme.secondary)
                    }.fixedSize(horizontal: false, vertical: true)
                case .divider: Rectangle().fill(BZZYTheme.line).frame(height: 0.7)
                case .code(let language, let code):
                    VStack(alignment: .leading, spacing: 10) {
                        if !language.isEmpty { Text(language).bzzyFont(10, design: .monospaced).foregroundStyle(BZZYTheme.muted) }
                        ScrollView(.horizontal) {
                            Text(verbatim: code).font(.system(size: bodySize * 0.86, design: .monospaced))
                                .foregroundStyle(BZZYTheme.accent).textSelection(.enabled).fixedSize()
                        }.scrollIndicators(.hidden)
                    }.padding(13).background(BZZYTheme.surface, in: RoundedRectangle(cornerRadius: 4))
                        .accessibilityIdentifier("chat-code-block")
                case .table(let table): tableView(table)
                }
            }
        }.font(.system(size: bodySize, design: .monospaced)).textSelection(.enabled)
    }
    private func inline(_ spans: [ChatSpan], heading: Int? = nil) -> some View {
        Text(attributed(spans, heading: heading)).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
    }
    private func attributed(_ spans: [ChatSpan], heading: Int? = nil, scale: Double = 1, header: Bool = false) -> AttributedString {
        var result = AttributedString()
        for span in spans {
            var text = content.isFormatted ? AttributedString(span.text) : ((try? AttributedString(markdown: span.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(span.text))
            let factor = span.style.size == .small ? 0.82 : span.style.size == .large ? 1.2 : 1
            let size = heading == 1 ? bodySize * 1.35 : heading == 2 ? bodySize * 1.15 : bodySize * scale * factor
            for run in Array(text.runs) {
                let intent = run.inlinePresentationIntent ?? []
                let bold = span.style.bold || heading != nil || header || intent.contains(.stronglyEmphasized)
                let code = span.style.code || intent.contains(.code)
                var font = Font.system(size: size, weight: bold ? .semibold : .regular, design: .monospaced)
                if span.style.italic || intent.contains(.emphasized) { font = font.italic() }
                text[run.range].font = font
                if let tint = span.style.color { text[run.range].foregroundColor = color(tint) }
                else if code { text[run.range].foregroundColor = BZZYTheme.accent }
                if let url = run.link, !["https", "http"].contains(url.scheme?.lowercased() ?? "") { text[run.range].link = nil }
            }
            result.append(text)
        }
        return result
    }
    private func color(_ value: ChatTextColor) -> Color {
        switch value {
        case .mint: Color(hex: 0x00E5CB)
        case .amber: BZZYTheme.amber
        case .coral: Color(hex: 0xF28B82)
        case .blue: Color(hex: 0x8CBDF5)
        case .lavender: Color(hex: 0xB9A5F5)
        case .muted: Color(hex: 0x91A6A1)
        }
    }
    private func tableView(_ table: ChatTable) -> some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(table.headers.indices, id: \.self) { column in
                        Text(attributed(table.headers[column], scale: 0.85, header: true))
                            .frame(width: cellWidth, alignment: .leading).padding(11)
                    }
                }.background(BZZYTheme.elevated)
                ForEach(table.rows.indices, id: \.self) { row in
                    GridRow {
                        ForEach(table.headers.indices, id: \.self) { column in
                            Text(attributed(table.rows[row][column], scale: 0.85))
                                .frame(width: cellWidth, alignment: .leading).padding(11)
                                .accessibilityLabel(table.headers[column].map(\.text).joined() + ": " + table.rows[row][column].map(\.text).joined())
                        }
                    }.background(row.isMultiple(of: 2) ? BZZYTheme.background.opacity(0.35) : Color.clear)
                }
            }.fixedSize(horizontal: true, vertical: false)
        }.scrollIndicators(.visible)
            .background(BZZYTheme.background.opacity(0.35), in: RoundedRectangle(cornerRadius: 4))
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(BZZYTheme.line, lineWidth: 0.7))
            .accessibilityElement(children: .contain).accessibilityLabel("Table")
            .accessibilityIdentifier("chat-rich-table")
    }
}
