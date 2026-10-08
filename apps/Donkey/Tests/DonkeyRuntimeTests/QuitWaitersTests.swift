import DonkeyRuntime
import Testing

/// Quitting waits on the movie in flight, but never forever: a recorder whose stop never returns
/// still lets the quit, update or logout through once the deadline passes.
@MainActor
struct QuitWaitersTests {
    @Test func releaseAnswersEveryWaiterOnce() {
        let waiters = QuitWaiters(deadline: .seconds(60))
        var answered = 0
        waiters.add { answered += 1 }
        waiters.add { answered += 1 }

        waiters.release()
        waiters.release()

        #expect(answered == 2)
        #expect(waiters.isEmpty)
    }

    @Test func deadlineReleasesAStalledStop() async throws {
        let waiters = QuitWaiters(deadline: .milliseconds(20))
        var answered = 0
        waiters.add { answered += 1 }

        try await Task.sleep(for: .milliseconds(200))
        #expect(answered == 1)

        // The stop finishing late answers nobody twice.
        waiters.release()
        #expect(answered == 1)
    }
}
