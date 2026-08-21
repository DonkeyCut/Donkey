import DonkeyKitModels
import Foundation
import Network

/// Feeds the sync engine the current network path so policy can decide what
/// moves. Cellular and other expensive paths (personal hotspots) both count
/// as cellular: they spend metered data.
final class NetworkMonitor {
    private let monitor = NWPathMonitor()

    init(onChange: @escaping @Sendable @MainActor (NetworkPath) -> Void) {
        monitor.pathUpdateHandler = { path in
            let mapped: NetworkPath = if path.status != .satisfied {
                .offline
            } else if path.usesInterfaceType(.cellular) || path.isExpensive {
                .cellular
            } else {
                .wifi
            }
            Task { @MainActor in onChange(mapped) }
        }
        monitor.start(queue: DispatchQueue(label: "network-monitor"))
    }

    deinit {
        monitor.cancel()
    }
}
