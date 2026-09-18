// cut-stt — on-device speech-to-text with word timestamps.
//
// Wraps Apple's SpeechAnalyzer/SpeechTranscriber (macOS 26+, the engine
// behind Voice Memos transcripts): fully local, no permission needed for
// file input. Compiled on demand by server/transcribe.ts.
//
//   usage: cut-stt <audio-file> [locale]
//   stdout: {"locale":"en-US","words":[{"t0":0.12,"t1":0.48,"w":"Hello"}]}
//
//   usage: cut-stt --live [locale]
//   Streams live dictation: reads raw 16 kHz mono signed-16-bit little-endian
//   PCM from stdin (the browser captures the mic and pipes it in — this process
//   never touches the microphone itself) and emits one NDJSON line per update:
//     {"type":"partial","text":"Hello the"}      // evolving, may still change
//     {"type":"final","text":"Hello there."}      // on stdin EOF
//     {"type":"error","text":"…"}
//   The stream ends when stdin closes; the model then flushes its final text.

import AVFoundation
import Foundation
import Speech

struct Word: Codable {
  let t0: Double
  let t1: Double
  let w: String
}

struct Output: Codable {
  let locale: String
  let words: [Word]
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

/// One NDJSON event to stdout. FileHandle writes are unbuffered, so each line
/// reaches the parent (and the polling client) the instant it is produced.
func emit(_ type: String, _ text: String) {
  guard let data = try? JSONEncoder().encode(["type": type, "text": text]) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

@main
struct Main {
  static func main() async {
    let args = CommandLine.arguments
    if args.count >= 2 && args[1] == "--live" {
      let localeId = args.count >= 3 ? args[2] : "en-US"
      await runLive(locale: Locale(identifier: localeId))
      return
    }

    guard args.count >= 2 else { fail("usage: cut-stt <audio-file> [locale]") }
    let path = args[1]
    let localeId = args.count >= 3 ? args[2] : "en-US"
    let locale = Locale(identifier: localeId)

    do {
      let transcriber = SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [],
        attributeOptions: [.audioTimeRange]
      )

      // First run per locale downloads the on-device model; no-op afterwards.
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
      }

      let analyzer = SpeechAnalyzer(modules: [transcriber])
      let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))

      let collector = Task {
        var words: [Word] = []
        for try await result in transcriber.results {
          for run in result.text.runs {
            guard let range = run.audioTimeRange else { continue }
            let text = String(result.text[run.range].characters)
              .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            words.append(Word(t0: range.start.seconds, t1: range.end.seconds, w: text))
          }
        }
        return words
      }

      if let last = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: last)
      } else {
        await analyzer.cancelAndFinishNow()
      }

      let words = try await collector.value
      let out = Output(locale: locale.identifier(.bcp47), words: words)
      let data = try JSONEncoder().encode(out)
      FileHandle.standardOutput.write(data)
      FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
      fail("cut-stt: \(error)")
    }
  }
}

// MARK: - Live streaming (stdin PCM → partial transcripts)

/// Scratch shared by the stdin reader, the results loop, and the finish
/// watchdog: whether any audio ever arrived, and the newest text to fall back
/// on. Each of the three runs on its own thread, so the lock is the contract.
final class LiveState: @unchecked Sendable {
  private let lock = NSLock()
  private var heardAudio = false
  private var newest = ""
  func markAudio() {
    lock.lock()
    heardAudio = true
    lock.unlock()
  }
  var receivedAudio: Bool {
    lock.lock()
    defer { lock.unlock() }
    return heardAudio
  }
  func record(_ text: String) {
    lock.lock()
    newest = text
    lock.unlock()
  }
  var latest: String {
    lock.lock()
    defer { lock.unlock() }
    return newest
  }
}

// The finish is bounded: whatever the model has said by here is the final text.
// The parent waits on this process for its transcript, so a finalize that stops
// answering has to end as an answer, not as a stall.
let finishDeadline = Duration.seconds(6)

@MainActor
func runLive(locale: Locale) async {
  // The browser pipes raw mic audio in this exact format; keep in sync with the
  // client's downsampler in lib/micTranscribe.ts.
  let liveSampleRate = 16000.0
  let live = LiveState()
  do {
    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      // Volatile results give us the evolving partial as the user speaks;
      // finalized results are the stable prefix that will not change again.
      reportingOptions: [.volatileResults],
      attributeOptions: []
    )

    // First run per locale downloads the on-device model; no-op afterwards.
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    else {
      emit("error", "No compatible audio format for on-device transcription.")
      exit(1)
    }

    let inputFormat = AVAudioFormat(
      commonFormat: .pcmFormatInt16, sampleRate: liveSampleRate, channels: 1, interleaved: true
    )!
    let converter = AVAudioConverter(from: inputFormat, to: analyzerFormat)

    let (inputSequence, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream()

    // Blocking stdin reader on its own queue: it must not stall the actor or the
    // results loop. Odd trailing bytes carry over so we only ever emit whole
    // 16-bit samples.
    let readerDone = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .userInitiated).async {
      let handle = FileHandle.standardInput
      var carry = Data()
      while true {
        let data = handle.availableData
        if data.isEmpty { break } // EOF: browser stopped and the engine closed stdin.
        carry.append(data)
        let usable = carry.count - (carry.count % 2)
        guard usable > 0 else { continue }
        let chunk = carry.subdata(in: 0..<usable)
        carry.removeSubrange(0..<usable)
        if let buffer = makeInt16Buffer(chunk, format: inputFormat),
          let converted = convertBuffer(buffer, using: converter, to: analyzerFormat)
        {
          inputBuilder.yield(AnalyzerInput(buffer: converted))
          live.markAudio()
        }
      }
      inputBuilder.finish()
      readerDone.signal()
    }

    try await analyzer.start(inputSequence: inputSequence)

    // Consume results concurrently with feeding: the loop only ends once the
    // analyzer is finalized (below), so it cannot be awaited inline first.
    let results = Task {
      var finalized = ""
      for try await result in transcriber.results {
        let piece = String(result.text.characters)
        if result.isFinal {
          finalized += piece
          live.record(finalized)
          emit("partial", finalized)
        } else {
          live.record(finalized + piece)
          emit("partial", finalized + piece)
        }
      }
      return finalized
    }

    // Wait for stdin EOF (reader finished the input stream), flush the model,
    // then let the results loop drain to its final value.
    await withCheckedContinuation { cont in
      DispatchQueue.global().async { readerDone.wait(); cont.resume() }
    }
    // A session that was never fed has nothing to flush, and the analyzer's
    // finalize never returns for an input that carried no audio — answer with
    // the empty transcript and go.
    guard live.receivedAudio else {
      emit("final", "")
      exit(0)
    }
    let watchdog = Task { @MainActor in
      try? await Task.sleep(for: finishDeadline)
      guard !Task.isCancelled else { return }
      emit("final", live.latest)
      exit(0)
    }
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    let finalText = try await results.value
    watchdog.cancel()
    emit("final", finalText)
  } catch {
    emit("error", "\(error)")
    exit(1)
  }
}

/// Wrap raw signed-16-bit little-endian PCM bytes as an AVAudioPCMBuffer.
func makeInt16Buffer(_ data: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
  let frames = AVAudioFrameCount(data.count / 2)
  guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)
  else { return nil }
  buffer.frameLength = frames
  data.withUnsafeBytes { raw in
    guard let src = raw.baseAddress, let dst = buffer.int16ChannelData?[0] else { return }
    memcpy(dst, src, Int(frames) * 2)
  }
  return buffer
}

/// Resample/convert a buffer into the analyzer's required format.
func convertBuffer(
  _ input: AVAudioPCMBuffer, using converter: AVAudioConverter?, to outFormat: AVAudioFormat
) -> AVAudioPCMBuffer? {
  guard let converter else { return nil }
  let ratio = outFormat.sampleRate / input.format.sampleRate
  let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 1024
  guard let output = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return nil }
  var supplied = false
  var error: NSError?
  converter.convert(to: output, error: &error) { _, status in
    if supplied {
      status.pointee = .noDataNow
      return nil
    }
    supplied = true
    status.pointee = .haveData
    return input
  }
  return error == nil ? output : nil
}
