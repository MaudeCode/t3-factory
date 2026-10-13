import AppKit
import SwiftUI

// The web app's palette, so the panel and the browser read as one product.
enum Theme {
    static let bg = Color(red: 0.090, green: 0.075, blue: 0.125)
    static let surface = Color(red: 0.122, green: 0.102, blue: 0.169)
    static let surface2 = Color(red: 0.165, green: 0.141, blue: 0.220)
    static let ink = Color(red: 0.961, green: 0.945, blue: 0.980)
    static let muted = Color(red: 0.608, green: 0.573, blue: 0.678)
    static let line = Color(red: 0.200, green: 0.173, blue: 0.267)
    static let accent = Color(red: 0.749, green: 0.843, blue: 1.0)
    static let accentInk = bg
    static let attention = Color(red: 1.0, green: 0.639, blue: 0.420)
    static let ok = Color(red: 0.620, green: 0.886, blue: 0.722)
    static let danger = Color(red: 1.0, green: 0.482, blue: 0.525)
    static func mono(_ size: CGFloat = 12, weight: Font.Weight = .semibold) -> Font { .system(size: size, weight: weight, design: .monospaced) }
}

extension View {
    func card() -> some View {
        padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.line, lineWidth: 1))
    }
    func themed() -> some View { foregroundStyle(Theme.ink).tint(Theme.accent).preferredColorScheme(.dark) }
}

// A heading with an optional count and a question mark that explains it on hover.
struct SectionTitle<Trailing: View>: View {
    let title: String
    var count: Int? = nil
    var help: String? = nil
    @ViewBuilder var trailing: () -> Trailing
    init(_ title: String, count: Int? = nil, help: String? = nil, @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.title = title; self.count = count; self.help = help; self.trailing = trailing
    }
    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 13, weight: .semibold))
            if let count, count > 0 { Text("\(count)").font(.system(size: 11, weight: .medium).monospacedDigit()).foregroundStyle(Theme.muted) }
            if let help { HelpMark(text: help) }
            Spacer()
            trailing()
        }
    }
}

struct HelpMark: View {
    let text: String
    var body: some View {
        Text("?").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.muted).frame(width: 14, height: 14)
            .overlay(Circle().stroke(Theme.muted, lineWidth: 1)).help(text)
    }
}

struct Tag: View {
    let text: String; var color: Color = Theme.muted
    var body: some View {
        Text(text).font(.system(size: 10, weight: .semibold)).foregroundStyle(color).padding(.horizontal, 6).padding(.vertical, 2)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(color.opacity(0.9), lineWidth: 1)).fixedSize()
    }
}

// Remaining allowance with the line the scheduler holds back right now.
struct AllowanceBar: View {
    let label: String; let remaining: Double; let reserved: Double?; var note = ""
    var body: some View {
        let value = max(0, min(100, remaining)), low = value <= (reserved ?? 15)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).font(.system(size: 11)).foregroundStyle(Theme.muted)
                Spacer()
                Text("\(Int(value))").font(.system(size: 14, weight: .semibold).monospacedDigit()).foregroundStyle(low ? Theme.attention : Theme.ink) + Text("%").font(.system(size: 10)).foregroundStyle(Theme.muted)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.surface2)
                    Capsule().fill(low ? Theme.attention : Theme.accent).frame(width: geo.size.width * value / 100)
                    if let reserved, reserved > 0 { Rectangle().fill(Theme.muted).frame(width: 1.5, height: 11).offset(x: geo.size.width * min(100, reserved) / 100 - 0.75) }
                }
            }.frame(height: 7)
            if !note.isEmpty { Text(note).font(.system(size: 10)).foregroundStyle(Theme.muted) }
        }
    }
}

// Pill that toggles membership; `rank` numbers an ordered pick.
struct Chip: View {
    let text: String; let on: Bool; var rank: Int? = nil; let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let rank { Text("\(rank)").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.accent).frame(width: 14, height: 14).background(Circle().fill(Theme.accentInk)) }
                Text(text).font(.system(size: 12))
            }
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Capsule().fill(on ? Theme.accent : .clear))
            .overlay(Capsule().stroke(on ? Theme.accent : Theme.line, lineWidth: 1))
            .foregroundStyle(on ? Theme.accentInk : Theme.muted)
        }.buttonStyle(.plain)
    }
}

// Wraps chips onto as many lines as needed.
struct Wrap: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 400
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            x += size.width + spacing; rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width, height: y + rowHeight)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing; rowHeight = max(rowHeight, size.height)
        }
    }
}

// A labelled control with its explanation behind a question mark.
struct Field<Content: View>: View {
    let label: String; var help: String? = nil
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) { Text(label).font(.system(size: 11)).foregroundStyle(Theme.muted); if let help { HelpMark(text: help) } }
            content()
        }
    }
}

struct SliderField: View {
    let label: String; var help: String? = nil
    @Binding var value: Double
    let range: ClosedRange<Double>; let step: Double
    let format: (Double) -> String
    var body: some View {
        Field(label: label, help: help) {
            HStack(spacing: 10) {
                Slider(value: $value, in: min(range.lowerBound, value)...max(range.upperBound, value), step: step)
                Text(format(value)).font(.system(size: 12, weight: .semibold).monospacedDigit()).frame(width: 64, alignment: .trailing)
            }
        }
    }
}

struct Switch: View {
    let label: String; var help: String? = nil
    @Binding var on: Bool
    var body: some View {
        HStack {
            Text(label).font(.system(size: 13, weight: .semibold)); if let help { HelpMark(text: help) }
            Spacer()
            Toggle("", isOn: $on).toggleStyle(.switch).labelsHidden()
        }.padding(.vertical, 6)
    }
}

struct DarkTextField: View {
    let placeholder: String
    @Binding var text: String
    var mono = false
    var body: some View {
        TextField(placeholder, text: $text).textFieldStyle(.plain).font(mono ? Theme.mono(12, weight: .regular) : .system(size: 13))
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.bg))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.line, lineWidth: 1))
    }
}

struct Segments: View {
    let options: [(String, String)]
    @Binding var value: String
    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { option in
                Button { value = option.0 } label: {
                    Text(option.1).font(.system(size: 12, weight: .medium)).padding(.horizontal, 11).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 5).fill(value == option.0 ? Theme.surface2 : .clear))
                        .foregroundStyle(value == option.0 ? Theme.ink : Theme.muted)
                }.buttonStyle(.plain)
            }
        }.padding(3).background(RoundedRectangle(cornerRadius: 7).fill(Theme.surface))
    }
}

struct PrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 13, weight: .semibold)).padding(.horizontal, 14).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.accent)).foregroundStyle(Theme.accentInk)
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}
struct QuietButton: ButtonStyle {
    var color: Color = Theme.ink
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 12, weight: .semibold)).padding(.horizontal, 10).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface2.opacity(configuration.isPressed ? 1 : 0.6)))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.line, lineWidth: 1)).foregroundStyle(color)
    }
}
