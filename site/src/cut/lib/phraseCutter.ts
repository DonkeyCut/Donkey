// Live dictation on the hosted transcriber cuts the take into phrases at the
// speaker's pauses. Each phrase goes out the moment it ends, so its words land
// while the next one is spoken. A phrase that runs on without a pause is cut
// at its quietest moment once it reaches the cap, so a fast talker still sees
// words every few seconds. Quiet before speech is trimmed as it arrives, so
// a long silence sends nothing and holds no memory.
//
// Input is 16 kHz signed 16-bit mono PCM, the worklet's wire format.

const RATE = 16000;
const FRAME = RATE / 50; // 20 ms analysis frames
const PAUSE_FRAMES = 23; // ~450 ms of quiet ends a phrase
const MIN_PHRASE_FRAMES = 75; // a phrase holds at least 1.5 s before a pause cuts it
const MAX_PHRASE_FRAMES = 400; // 8 s: past this, cut at the quietest point
const SEEK_FRAMES = 75; // the cap looks for its cut in the last 1.5 s
const PREROLL_FRAMES = 15; // 300 ms of the quiet before speech stays on
const MIN_SPEECH_FRAMES = 5; // 100 ms of voice makes a phrase; less is a click
// A frame is voice when it stands this far over the room's noise floor, and
// never below the absolute floor (about -40 dBFS).
const MIN_SPEECH_RMS = 0.01;
const SPEECH_OVER_FLOOR = 3;
// The floor starts at a quiet room, drops to any quieter frame at once, and
// climbs slowly toward louder ones: over seconds through room noise, over
// minutes through speech, so talking never drags it up to the voice.
const START_FLOOR = MIN_SPEECH_RMS / SPEECH_OVER_FLOOR;
const FLOOR_RISE_QUIET = 0.002;
const FLOOR_RISE_VOICED = 0.0002;

export class PhraseCutter {
  private buf = new Int16Array(RATE * 10);
  private length = 0;
  private scanned = 0;
  private rms: number[] = [];
  private speechFrames = 0;
  private silentRun = 0;
  private floor = START_FLOOR;

  /** Add captured audio; returns the phrases it completed, oldest first. */
  push(pcm: Int16Array): Int16Array[] {
    this.append(pcm);
    const out: Int16Array[] = [];
    while (this.length - this.scanned >= FRAME) {
      const cut = this.scanFrame();
      if (cut !== null) {
        out.push(this.take(cut));
      }
    }
    return out;
  }

  /** End the take: the phrase still open, or null when it holds no speech. */
  flush(): Int16Array | null {
    const phrase = this.speechFrames >= MIN_SPEECH_FRAMES ? this.take(this.length) : null;
    this.length = 0;
    this.scanned = 0;
    this.rms = [];
    this.speechFrames = 0;
    this.silentRun = 0;
    return phrase;
  }

  private append(pcm: Int16Array) {
    if (this.length + pcm.length > this.buf.length) {
      const grown = new Int16Array(Math.max(this.buf.length * 2, this.length + pcm.length));
      grown.set(this.buf.subarray(0, this.length));
      this.buf = grown;
    }
    this.buf.set(pcm, this.length);
    this.length += pcm.length;
  }

  /** Read one frame and say where to cut, if this frame ends a phrase. */
  private scanFrame(): number | null {
    const level = frameRms(this.buf, this.scanned);
    this.scanned += FRAME;
    this.rms.push(level);
    const voiced = level > Math.max(MIN_SPEECH_RMS, this.floor * SPEECH_OVER_FLOOR);
    const rise = voiced ? FLOOR_RISE_VOICED : FLOOR_RISE_QUIET;
    this.floor = level < this.floor ? level : this.floor + (level - this.floor) * rise;
    this.silentRun = voiced ? 0 : this.silentRun + 1;
    if (voiced) {
      this.speechFrames += 1;
    }

    // Before speech: a blip that a pause follows was a click, and the quiet
    // ahead of the pre-roll is dropped.
    if (this.speechFrames < MIN_SPEECH_FRAMES) {
      if (this.silentRun >= PAUSE_FRAMES) {
        this.speechFrames = 0;
      }
      if (this.speechFrames === 0) {
        this.trimLead();
      }
      return null;
    }

    // In a phrase: a pause ends it once it has some length; the cap cuts at
    // the quietest frame near the end.
    const frames = this.rms.length;
    if (this.silentRun >= PAUSE_FRAMES && frames >= MIN_PHRASE_FRAMES) {
      return this.scanned;
    }
    if (frames >= MAX_PHRASE_FRAMES) {
      let quietest = frames - SEEK_FRAMES;
      for (let i = quietest + 1; i < frames; i++) {
        if (this.rms[i] < this.rms[quietest]) {
          quietest = i;
        }
      }
      return quietest * FRAME + FRAME / 2;
    }
    return null;
  }

  /** Drop all but the pre-roll from the front of the buffer. */
  private trimLead() {
    const drop = this.rms.length - PREROLL_FRAMES;
    if (drop <= 0) {
      return;
    }
    this.shift(drop * FRAME);
    this.rms.splice(0, drop);
  }

  /** Cut the first `at` samples off as a phrase and rescan what follows. */
  private take(at: number): Int16Array {
    const phrase = this.buf.slice(0, at);
    this.shift(at);
    this.scanned = 0;
    this.rms = [];
    this.speechFrames = 0;
    this.silentRun = 0;
    return phrase;
  }

  private shift(by: number) {
    this.buf.copyWithin(0, by, this.length);
    this.length -= by;
    this.scanned = Math.max(0, this.scanned - by);
  }
}

/** Root-mean-square level of one frame, 0..1. */
function frameRms(buf: Int16Array, at: number): number {
  let sum = 0;
  for (let i = at; i < at + FRAME; i++) {
    const v = buf[i] / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / FRAME);
}
