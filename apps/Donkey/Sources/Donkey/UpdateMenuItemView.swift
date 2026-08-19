import AppKit

/// The body of the update menu row. Unlike a standard menu item, a click here does not dismiss the
/// menu: the tap fires the handler and the row swaps to a spinner in place, so "Check for Updates"
/// can show progress while the menu stays open. The menu closes only when the user clicks elsewhere.
///
/// It draws its own native-looking highlight and title because custom-view items opt out of the
/// system's menu styling. Hover state comes from a tracking area; the trailing spinner runs for
/// in-progress states.
@MainActor
final class UpdateMenuItemView: NSView {
    private enum Metrics {
        static let height: CGFloat = 22
        static let textLeading: CGFloat = 14
        static let highlightInset: CGFloat = 5
        static let cornerRadius: CGFloat = 4
        static let spinnerSize: CGFloat = 14
        static let spinnerTrailing: CGFloat = 10
        static let indicatorDiameter: CGFloat = 6
        static let indicatorLeading: CGFloat = 3
    }

    private let label = NSTextField(labelWithString: "")
    private let spinner = NSProgressIndicator()
    private let onClick: () -> Void

    private var isClickable = true
    private var isHovered = false
    /// Draws the blue leading dot marking a waiting update, mirroring the menu bar icon's badge.
    private var showsIndicator = false

    init(onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: NSRect(x: 0, y: 0, width: 220, height: Metrics.height))
        // Let the enclosing menu stretch the row to its content width so the highlight spans it.
        autoresizingMask = .width

        label.font = NSFont.menuFont(ofSize: 0)
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        // Animate off the main thread so the spinner keeps turning during menu event tracking.
        spinner.usesThreadedAnimation = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        addSubview(spinner)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Metrics.height),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Metrics.textLeading),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            spinner.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Metrics.spinnerTrailing),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
            spinner.widthAnchor.constraint(equalToConstant: Metrics.spinnerSize),
            spinner.heightAnchor.constraint(equalToConstant: Metrics.spinnerSize),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Point the row at the current update state: its title, whether a tap does anything, and whether
    /// the spinner runs. Safe to call while the menu is open — the row refreshes in place.
    func configure(title: String, isClickable: Bool, isBusy: Bool, showsIndicator: Bool = false) {
        label.stringValue = title
        self.isClickable = isClickable
        self.showsIndicator = showsIndicator
        if isBusy {
            spinner.startAnimation(nil)
        } else {
            spinner.stopAnimation(nil)
        }
        refreshAppearance()
    }

    private func refreshAppearance() {
        let highlighted = isHovered && isClickable
        if highlighted {
            label.textColor = .selectedMenuItemTextColor
        } else if isClickable {
            label.textColor = .labelColor
        } else {
            label.textColor = .disabledControlTextColor
        }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let highlighted = isHovered && isClickable
        if highlighted {
            let rect = bounds.insetBy(dx: Metrics.highlightInset, dy: 0)
            let path = NSBezierPath(
                roundedRect: rect,
                xRadius: Metrics.cornerRadius,
                yRadius: Metrics.cornerRadius
            )
            NSColor.selectedContentBackgroundColor.setFill()
            path.fill()
        }

        guard showsIndicator else { return }
        let diameter = Metrics.indicatorDiameter
        let dot = NSRect(
            x: Metrics.indicatorLeading,
            y: (bounds.height - diameter) / 2,
            width: diameter,
            height: diameter
        )
        // White over the blue hover fill, blue otherwise — matching the label's highlight treatment.
        (highlighted ? NSColor.white : NSColor.systemBlue).setFill()
        NSBezierPath(ovalIn: dot).fill()
    }

    // MARK: - Hover and click

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self
        ))
    }

    override func mouseEntered(with event: NSEvent) {
        setHovered(true)
    }

    override func mouseExited(with event: NSEvent) {
        setHovered(false)
    }

    private func setHovered(_ hovered: Bool) {
        guard hovered != isHovered else { return }
        isHovered = hovered
        refreshAppearance()
    }

    override func mouseUp(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard isClickable, bounds.contains(point) else { return }
        onClick()
    }
}
