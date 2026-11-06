import MoteDesign
import MoteWidgetUI
import SwiftUI

/// Generated preview of the widget layouts for visual and accessibility checks.
struct WidgetPreview: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("小组件")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(MoteDesignTokens.muted.color)
            widget(.small, width: 158, height: 158)
            widget(.medium, width: 356, height: 158)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.top, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(MoteDesignTokens.background.color)
        .statusBarHidden()
    }

    private func widget(_ layout: MoteWidgetLayout, width: CGFloat, height: CGFloat) -> some View {
        MoteWidgetContent(layout: layout)
            .frame(width: width, height: height)
            .background(MoteDesignTokens.surface.color)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(MoteDesignTokens.hair.color, lineWidth: 1)
            }
    }
}
