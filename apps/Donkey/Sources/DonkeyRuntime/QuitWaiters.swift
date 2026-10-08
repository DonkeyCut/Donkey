import Foundation

/// Quits waiting on the movie in flight. Each waiter is answered once: when the movie is written or
/// abandoned, or when the deadline passes, so a stop that never returns cannot hold a quit, an update
/// install or a logout forever.
@MainActor
public final class QuitWaiters {
    private let deadline: Duration
    private var waiters: [@MainActor () -> Void] = []
    private var timeout: Task<Void, Never>?

    public init(deadline: Duration) {
        self.deadline = deadline
    }

    public var isEmpty: Bool { waiters.isEmpty }

    /// Queue `done`; the first waiter starts the deadline.
    public func add(_ done: @escaping @MainActor () -> Void) {
        waiters.append(done)
        guard timeout == nil else { return }

        let deadline = self.deadline
        timeout = Task { [weak self] in
            try? await Task.sleep(for: deadline)
            guard !Task.isCancelled else { return }
            self?.release()
        }
    }

    /// Answer every waiter and clear the deadline.
    public func release() {
        timeout?.cancel()
        timeout = nil
        let pending = waiters
        waiters = []
        pending.forEach { $0() }
    }
}
