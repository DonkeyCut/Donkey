@testable import DonkeyRuntime
import Foundation
import Testing

@Suite
struct CursorTrackTests {
    @Test
    func cursorTrackSitsBesideTheMovie() {
        let movie = URL(fileURLWithPath: "/Users/x/Desktop/Screen Recording 2026-07-21 at 15.24.05.mov")

        let sidecar = ScreenRecordingDestination.cursorTrackURL(for: movie)

        #expect(sidecar.lastPathComponent == "Screen Recording 2026-07-21 at 15.24.05.cursor.json")
        #expect(sidecar.deletingLastPathComponent() == movie.deletingLastPathComponent())
    }

    @Test
    func trackRoundTripsThroughJSON() throws {
        let track = CursorTrack(
            sampleRate: 60,
            frameSize: CGSize(width: 1512, height: 982),
            samples: [
                CursorSample(t: 0, x: 0.5, y: 0.25, pressed: false, inside: true),
                CursorSample(t: 0.5, x: 1.2, y: 0.25, pressed: true, inside: false)
            ]
        )

        let decoded = try JSONDecoder().decode(CursorTrack.self, from: JSONEncoder().encode(track))

        #expect(decoded == track)
        #expect(decoded.version == CursorTrack.version)
        #expect(decoded.frameWidth == 1512)
    }
}
