import Testing
@testable import DonkeyUI

@MainActor
struct RecordingCloseTests {
    @Test func closeFinalizesActiveCapture() {
        let model = RecordingControlBarModel()
        model.isRecording = true
        var stopRequests = 0
        var closeRequests = 0
        model.onStop = { stopRequests += 1 }
        model.onClose = { closeRequests += 1 }

        // Closing a live capture must request its finalized file.
        model.requestClose()

        #expect(stopRequests == 1)
        #expect(closeRequests == 0)
    }

    @Test func closeDismissesArmedCapture() {
        let model = RecordingControlBarModel()
        var closeRequests = 0
        model.onClose = { closeRequests += 1 }

        // An armed capture has no movie to finalize.
        model.requestClose()

        #expect(closeRequests == 1)
    }

    @Test(arguments: [true, false])
    func closeWaitsForBusyCapture(isRecording: Bool) {
        let model = RecordingControlBarModel()
        model.isRecording = isRecording
        model.isBusy = true
        var requests = 0
        model.onStop = { requests += 1 }
        model.onClose = { requests += 1 }

        // Start and finalization retain ownership until they finish.
        model.requestClose()

        #expect(requests == 0)
    }
}
