import CoreGraphics
import Testing
@testable import DonkeyRuntime

struct RecordingWindowResizerTests {
    @Test func movesWindowInsideDisplayBeforeGrowing() throws {
        let result = try RecordingWindowResizer.targetFrame(
            current: CGRect(x: 1200, y: 700, width: 300, height: 300),
            size: CGSize(width: 720, height: 960),
            visibleFrames: [CGRect(x: 0, y: 25, width: 1728, height: 1050)]
        )
        #expect(result == CGRect(x: 1008, y: 115, width: 720, height: 960))
    }

    @Test func usesSelectedWindowsDisplayWithNegativeCoordinates() throws {
        let result = try RecordingWindowResizer.targetFrame(
            current: CGRect(x: -1200, y: -700, width: 900, height: 700),
            size: CGSize(width: 540, height: 960),
            visibleFrames: [
                CGRect(x: 0, y: 25, width: 1728, height: 1050),
                CGRect(x: -1440, y: -900, width: 1440, height: 1100)
            ]
        )
        #expect(result == CGRect(x: -1200, y: -760, width: 540, height: 960))
    }

    @Test func keepsOriginWhenRequestedSizeFits() throws {
        let result = try RecordingWindowResizer.targetFrame(
            current: CGRect(x: 100, y: 100, width: 1200, height: 800),
            size: CGSize(width: 720, height: 960),
            visibleFrames: [CGRect(x: 0, y: 25, width: 1728, height: 1050)]
        )
        #expect(result == CGRect(x: 100, y: 100, width: 720, height: 960))
    }

    @Test(arguments: [CGSize(width: 540, height: 1920), CGSize(width: 0, height: 960), CGSize(width: -1, height: 960)])
    func rejectsInvalidOrOversizedDimensions(size: CGSize) {
        #expect(throws: RecordingWindowResizeError.self) {
            try RecordingWindowResizer.targetFrame(
                current: CGRect(x: 100, y: 100, width: 900, height: 700),
                size: size,
                visibleFrames: [CGRect(x: 0, y: 25, width: 1728, height: 1050)]
            )
        }
    }
}
