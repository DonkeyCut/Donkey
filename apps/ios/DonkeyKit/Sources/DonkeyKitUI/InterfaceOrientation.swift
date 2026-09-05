#if os(iOS)
import SwiftUI
import UIKit

/// Holds the screen still while a take is rolling.
///
/// A movie file output writes the whole take at the angle it started with,
/// so a phone turned mid-take would leave a level preview over a sideways
/// file and rearrange the controls under the hand holding them. The camera
/// screen pins the interface for the length of a take and lets it go again
/// the moment the take ends.
///
/// The app delegate answers the system's orientation question with `mask`.
public final class InterfaceOrientationLock {
    public static let shared = InterfaceOrientationLock()

    /// Which way this window may turn right now.
    public private(set) var mask: UIInterfaceOrientationMask = .all

    private init() {}

    /// Pins the interface to the orientation it is already in.
    public func hold() {
        guard let scene = Self.scenes.first else { return }
        set(Self.mask(for: scene.interfaceOrientation))
    }

    public func release() {
        set(.all)
    }

    private func set(_ mask: UIInterfaceOrientationMask) {
        guard mask != self.mask else { return }
        self.mask = mask
        for scene in Self.scenes {
            scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask))
        }
    }

    private static var scenes: [UIWindowScene] {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    }

    private static func mask(for orientation: UIInterfaceOrientation) -> UIInterfaceOrientationMask {
        switch orientation {
        case .landscapeLeft: .landscapeLeft
        case .landscapeRight: .landscapeRight
        case .portraitUpsideDown: .portraitUpsideDown
        default: .portrait
        }
    }
}
#endif
