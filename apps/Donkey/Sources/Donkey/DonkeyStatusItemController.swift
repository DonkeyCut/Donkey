import AppKit
import DonkeyRuntime

/// The menu bar entry point: a status item with the Donkey glyph whose menu carries "Go to App",
/// the update section — with an install item whenever a Sparkle background check has an update
/// waiting — and Quit. The menu is rebuilt each time it opens, so it always reflects the current
/// update state without push updates from the app delegate.
@MainActor
final class DonkeyStatusItemController: NSObject, NSMenuDelegate {
    /// The hosted app "Go to App" opens — the Cut app, same destination as the billing page's host.
    private static let appURL = URL(string: "https://donkeycut.com/app")!

    private let statusItem: NSStatusItem
    private let checkForUpdates: () -> Void
    private let installUpdate: () -> Void
    /// The "Record Screen" menu item's title and glyph, or `nil` to omit it (pre-macOS 15). Read on
    /// each menu open so the item reflects whether a recording is in progress.
    private let screenRecordingMenuItem: () -> (title: String, symbolName: String)?
    /// Opens the recording control bar, or stops an in-progress recording.
    private let toggleScreenRecording: () -> Void

    /// Latest update-checker state; drives the update section of the menu. Setting it while the menu
    /// is open refreshes the update row in place, so a user-triggered check spins and resolves without
    /// the menu having to be reopened.
    var updateState: DonkeyUpdateState? {
        didSet {
            refreshLiveUpdateItem()
            refreshStatusItemImage()
        }
    }

    /// The update row of the currently-open menu, held so state changes can refresh it in place. Weak:
    /// the menu owns the view, and it drops away when the menu is next rebuilt.
    private weak var liveUpdateView: UpdateMenuItemView?

    init(
        checkForUpdates: @escaping () -> Void,
        installUpdate: @escaping () -> Void,
        screenRecordingMenuItem: @escaping () -> (title: String, symbolName: String)? = { nil },
        toggleScreenRecording: @escaping () -> Void = {}
    ) {
        self.checkForUpdates = checkForUpdates
        self.installUpdate = installUpdate
        self.screenRecordingMenuItem = screenRecordingMenuItem
        self.toggleScreenRecording = toggleScreenRecording
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()

        refreshStatusItemImage()
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    deinit {
        MainActor.assumeIsolated {
            NSStatusBar.system.removeStatusItem(statusItem)
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        populateMenuItems(in: menu)
    }

    /// The shared item set — Go to App, the update section, and Quit. The status-item menu is
    /// exactly this; the app main menu appends it after About.
    func populateMenuItems(in menu: NSMenu) {
        menu.addItem(makeItem(title: "Go to App", action: #selector(goToAppAction), image: Self.donkeyMenuIcon()))

        if let recording = screenRecordingMenuItem() {
            menu.addItem(makeItem(
                title: recording.title,
                action: #selector(recordScreenAction),
                image: Self.recordMenuIcon(symbolName: recording.symbolName)
            ))
        }

        menu.addItem(.separator())
        menu.addItem(updateItem())

        menu.addItem(.separator())
        menu.addItem(makeItem(title: "Quit Donkey", action: #selector(quitAction), keyEquivalent: "q"))
    }

    private func makeItem(
        title: String,
        action: Selector,
        keyEquivalent: String = "",
        image: NSImage? = nil
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
        item.target = self
        item.image = image
        return item
    }

    /// The donkey glyph sized for a menu row, as a template so the menu recolors it for light/dark.
    private static func donkeyMenuIcon() -> NSImage {
        let glyph = loadGlyph()
        glyph.size = NSSize(width: 16, height: 16)
        glyph.isTemplate = true
        return glyph
    }

    /// A record/stop SF Symbol for the "Record Screen" row, as a template so the menu draws it white
    /// on the dark menu (and black on light) like the other rows, rather than a standout red.
    private static func recordMenuIcon(symbolName: String) -> NSImage? {
        let configuration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
        let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)?
            .withSymbolConfiguration(configuration)
        image?.isTemplate = true
        return image
    }

    /// The update section's single item, following the checker state: "Check for Updates" at rest,
    /// a spinning progress line while checking or installing, and "Update App" once a check has an
    /// update waiting — choosing it downloads, installs, quits, and relaunches automatically.
    ///
    /// The row is a custom view so a click keeps the menu open and spins in place instead of
    /// dismissing it; `liveUpdateView` holds it so later state changes refresh it live.
    private func updateItem() -> NSMenuItem {
        let item = NSMenuItem()
        let view = UpdateMenuItemView { [weak self] in self?.handleUpdateItemClick() }
        applyUpdatePresentation(to: view)
        item.view = view
        liveUpdateView = view
        return item
    }

    /// The title / clickability / busy triple the update row shows for the current checker state.
    private func updatePresentation() -> (title: String, isClickable: Bool, isBusy: Bool) {
        switch updateState?.status {
        case .available:
            let title = updateState?.latestVersion.map { "Update App (\($0))" } ?? "Update App"
            return (title, true, false)
        case .checking:
            return ("Checking for Updates…", false, true)
        case .installing:
            return ("Updating…", false, true)
        default:
            return ("Check for Updates", true, false)
        }
    }

    private func applyUpdatePresentation(to view: UpdateMenuItemView) {
        let presentation = updatePresentation()
        view.configure(
            title: presentation.title,
            isClickable: presentation.isClickable,
            isBusy: presentation.isBusy,
            showsIndicator: updateState?.isActionable ?? false
        )
    }

    private func refreshLiveUpdateItem() {
        guard let liveUpdateView else { return }
        applyUpdatePresentation(to: liveUpdateView)
    }

    /// Recompute the status-item glyph so a blue badge sits in its top-right corner exactly while an
    /// update is waiting to install, and clears once the app is up to date again.
    private func refreshStatusItemImage() {
        statusItem.button?.image = Self.menuBarIcon(updateAvailable: updateState?.isActionable ?? false)
    }

    /// Route an update-row tap by the current state: install a waiting update, or start a check.
    /// While a check or install is running the row is non-clickable, so no tap arrives here.
    private func handleUpdateItemClick() {
        switch updateState?.status {
        case .available:
            installUpdate()
        case .checking, .installing:
            break
        default:
            checkForUpdates()
        }
    }

    @objc private func recordScreenAction(_ sender: Any?) {
        toggleScreenRecording()
    }

    @objc private func goToAppAction(_ sender: Any?) {
        NSWorkspace.shared.open(Self.appURL)
    }

    @objc private func quitAction(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    /// The donkey glyph as a template image: pure black plus alpha, so the system recolors it
    /// for light/dark menu bars and the selected state (Apple's status-item guideline). The dev
    /// build gets a red-outlined variant instead, so it's unmistakable next to a release copy in
    /// the same menu bar. When an update is waiting, a blue badge is stamped into the top-right
    /// corner; a template image would strip the badge's color, so the badged variants recolor the
    /// glyph body to the dynamic label color themselves and still track the light/dark bar.
    private static func menuBarIcon(updateAvailable: Bool = false) -> NSImage {
        let glyph = loadGlyph()
        let base: NSImage
        if isDevBuild {
            base = devMenuBarIcon(glyph)
        } else if updateAvailable {
            base = recoloredGlyph(glyph, tint: .labelColor)
        } else {
            glyph.isTemplate = true
            return glyph
        }
        return updateAvailable ? badged(base) : base
    }

    /// The glyph as a non-template image recolored to `tint`, so a colored badge composited on top
    /// survives (a template image keeps only black plus alpha). Cache `.never` so a dynamic `tint`
    /// like `.labelColor` re-resolves as the menu bar flips between light and dark.
    private static func recoloredGlyph(_ glyph: NSImage, tint: NSColor) -> NSImage {
        let image = NSImage(size: glyph.size, flipped: false) { rect in
            stamp(glyph, in: rect, tint: tint)
            return true
        }
        image.cacheMode = .never
        return image
    }

    /// `base` with a blue badge in its top-right corner: a filled dot ringed by a thin transparent
    /// gap punched out of the glyph beneath, so the badge reads apart from it.
    private static func badged(_ base: NSImage) -> NSImage {
        let image = NSImage(size: base.size, flipped: false) { rect in
            base.draw(in: rect)
            let diameter: CGFloat = 7
            let dot = NSRect(
                x: rect.maxX - diameter,
                y: rect.maxY - diameter,
                width: diameter,
                height: diameter
            )
            NSGraphicsContext.current?.cgContext.setBlendMode(.clear)
            NSBezierPath(ovalIn: dot.insetBy(dx: -1.5, dy: -1.5)).fill()
            NSGraphicsContext.current?.cgContext.setBlendMode(.normal)
            NSColor.systemBlue.setFill()
            NSBezierPath(ovalIn: dot).fill()
            return true
        }
        image.cacheMode = .never
        return image
    }

    /// The dev build packages its own bundle identifier (com.donkeyuse.Donkey.dev), so a `.dev`
    /// suffix marks this as the dev app.
    private static let isDevBuild = Bundle.main.bundleIdentifier?.hasSuffix(".dev") ?? false

    /// The 20pt donkey glyph, both resolutions, with no template flag set yet.
    private static func loadGlyph() -> NSImage {
        let image = NSImage(size: NSSize(width: 20, height: 20))
        for resource in ["menu-bar-icon", "menu-bar-icon@2x"] {
            guard let url = DonkeyResourceBundle.app?.url(forResource: resource, withExtension: "png"),
                  let data = try? Data(contentsOf: url),
                  let representation = NSBitmapImageRep(data: data) else { continue }
            representation.size = image.size
            image.addRepresentation(representation)
        }
        return image
    }

    /// The donkey glyph with a red silhouette outline. Not a template image — a template discards
    /// color — so the body is filled with the dynamic label color to still track the light/dark
    /// menu bar while the outline stays red. Drawn on each render (cacheMode `.never`) so the body
    /// re-resolves when the menu bar appearance flips.
    private static func devMenuBarIcon(_ glyph: NSImage) -> NSImage {
        let stroke: CGFloat = 1.5
        let ring = (0 ..< 8).map { step -> CGVector in
            let angle = Double(step) / 8 * 2 * .pi
            return CGVector(dx: CGFloat(cos(angle)) * stroke, dy: CGFloat(sin(angle)) * stroke)
        }
        let image = NSImage(size: glyph.size, flipped: false) { rect in
            let body = rect.insetBy(dx: stroke, dy: stroke)
            for offset in ring {
                stamp(glyph, in: body.offsetBy(dx: offset.dx, dy: offset.dy), tint: .systemRed)
            }
            stamp(glyph, in: body, tint: .labelColor)
            return true
        }
        image.cacheMode = .never
        return image
    }

    /// Draw `glyph` recolored to `tint`, isolated in a transparency layer so the fill recolors only
    /// this stamp's pixels and leaves the halo stamps already composited beneath it untouched.
    private static func stamp(_ glyph: NSImage, in rect: NSRect, tint: NSColor) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState()
        context.beginTransparencyLayer(auxiliaryInfo: nil)
        glyph.draw(in: rect)
        tint.set()
        rect.fill(using: .sourceAtop)
        context.endTransparencyLayer()
        context.restoreGState()
    }
}
