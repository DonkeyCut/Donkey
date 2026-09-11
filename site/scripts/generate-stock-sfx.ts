// Generates the bundled Cut sound-effect catalog once, at build time, uploads
// the files to the media bucket, and writes the typed manifest the editor
// imports. The renderer is the ElevenLabs sound model; the app itself never
// calls it — people only ever see the files, served from media.donkeycut.com
// (the media Worker treats stock/sfx/ as public). The bytes live in R2 and a
// local cache, never in git; the manifest (ids, prompts, peaks) is committed.
// Idempotent: an id already in the bucket is skipped, so re-running fills gaps
// or picks up new catalog entries only. Ids named on the command line are
// rendered again under a fresh file name (the files are cached as immutable),
// so a weak take or a reworded prompt gets a new take:
//
//   cd site && ./node_modules/.bin/bun scripts/generate-stock-sfx.ts
//   cd site && ./node_modules/.bin/bun scripts/generate-stock-sfx.ts camera-burst-3
//
// Needs ELEVENLABS_API_KEY and R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
// R2_SECRET_ACCESS_KEY (bun auto-loads site/.env) and ffmpeg on PATH. Each take
// is trimmed of leading and trailing silence and peak-normalized so every card
// plays at the same level. The ElevenLabs response says what each take cost;
// the run logs the running total and stops at MAX_CREDITS.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { HeadObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

import { CUT_MEDIA_ORIGIN } from "../src/cut/lib/hosts";
import type { StockSfxCategory } from "../src/cut/lib/stock";
import { STOCK_SFX } from "../src/cut/lib/stockSfxManifest";

interface CatalogItem {
  id: string;
  category: StockSfxCategory;
  prompt: string;
  tags: string[];
  /** Requested length; a one-shot ends up shorter once silence is trimmed. */
  seconds: number;
  /** A bed that repeats seamlessly (ambience); one-shots leave it off. */
  loop?: boolean;
}

const MODEL = "eleven_text_to_sound_v2";
const BUCKET = "donkey-cut";
const KEY_PREFIX = "stock/sfx/";
const CACHE_DIR = path.join(import.meta.dirname, "..", ".cache", "stock-sfx");
const MANIFEST = path.join(import.meta.dirname, "..", "src", "cut", "lib", "stockSfxManifest.ts");
const CONCURRENCY = 4;
const PEAKS = 40;
// Follow the prompt closely: a one-shot is picked for one exact job, so a take
// that wanders from its description is a miss.
const PROMPT_INFLUENCE = 0.7;
// Trim points: anything under this is silence at the head; the tail keeps its
// decay down to a lower floor, plus a beat of quiet, so a snap or a click
// still rings out instead of ending on its transient.
const HEAD_SILENCE_DB = -45;
const TAIL_SILENCE_DB = -58;
const TAIL_KEEP_S = 0.12;
const PEAK_DB = -1;
// A one-shot whose waveform sits above half its peak for more than this share
// of its length is a noise take (the phone-snap failure) and is rendered again.
const NOISE_WALL_SHARE = 0.9;
// The model is asked for at least this long; a half-second request can come
// back as a near-empty take, and the trim takes the slack back off.
const MIN_REQUEST_SECONDS = 1;
// The families every edit reaches for get extra takes of each sound, numbered
// after the first, so a cut has more than one whoosh or click to pick from.
const CORE_TAKES = 3;
// The run stops spending here. The plan's monthly allowance is 30k; the margin
// leaves room for a re-run that only fills gaps.
const MAX_CREDITS = 29_500;

/** One row: id suffix, seconds, prompt, tags. The id is `<category>-<suffix>`. */
type Row = [suffix: string, seconds: number, prompt: string, tags: string[]];

const sfx = (category: StockSfxCategory, rows: Row[], opts: { loop?: boolean; takes?: number } = {}): CatalogItem[] =>
  rows.flatMap(([suffix, seconds, prompt, tags]) =>
    Array.from({ length: opts.takes ?? 1 }, (_, i) => ({
      id: `${category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}${i === 0 ? "" : `-${i + 1}`}`,
      category,
      prompt,
      tags,
      seconds,
      ...(opts.loop ? { loop: true } : {}),
    }))
  );
const core = { takes: CORE_TAKES };
const loops = { loop: true };

// Every prompt names one dry, close one-shot unless it says otherwise. The
// first nine families are the ones every social edit reaches for — clicks for
// things popping up, camera and flash for cuts, whooshes for scene changes,
// glitches, risers for tension, hits for landings, keyboard for typing — and
// the rest are the sounds people search a library for most.
const CATALOG: CatalogItem[] = [
  ...sfx("Clicks", [
    ["soft", 0.5, "A single short soft mouse click, clean and dry, close-miked, no reverb.", ["click", "mouse", "soft", "pop up", "ui"]],
    ["sharp", 0.5, "A single crisp sharp digital click, tight, dry, no reverb.", ["click", "sharp", "crisp", "digital", "pop up"]],
    ["double", 0.6, "Two quick soft clicks in fast succession, a double click, clean and dry.", ["click", "double", "mouse", "quick"]],
    ["pen", 0.5, "A single retractable pen click, small and dry, close-miked.", ["click", "pen", "small", "dry"]],
    ["switch", 0.5, "A single light switch flicking on, a small plastic click, dry.", ["click", "switch", "light", "flick", "toggle"]],
    ["tongue", 0.5, "A single sharp tongue click, a dry mouth tick, close-miked.", ["click", "tongue", "tick", "mouth", "snap"]],
    ["mouse", 0.5, "A single computer mouse button click, one crisp plastic click, dry, close-miked.", ["click", "mouse", "button", "single", "computer"]],
    ["mouse-release", 0.5, "A single computer mouse button press and release, two tiny plastic clicks close together, dry.", ["click", "mouse", "press", "release", "computer"]],
    ["trackpad", 0.5, "A single laptop trackpad click, one soft flat plastic tap, dry, close-miked.", ["click", "trackpad", "laptop", "tap", "single"]],
  ], core),
  ...sfx("Camera", [
    ["shutter", 0.6, "A single DSLR camera shutter click, crisp mechanical mirror slap, dry.", ["camera", "shutter", "photo", "snap", "dslr"]],
    ["burst", 1.2, "Burst mode on a DSLR: five fast mechanical shutter clicks in a tight even row, each one a crisp mirror slap, dry, close-miked, silent before and after, no motor whine.", ["camera", "shutter", "burst", "rapid", "photos"]],
    ["zoom", 0.8, "A quick camera lens zoom motor whir with a soft stop, dry, close-miked.", ["camera", "zoom", "lens", "motor", "whir"]],
    ["phone-snap", 0.6, "A smartphone camera taking one photo: a single short bright digital click-snap, crisp and clean, close, silent before and after, no hiss, no noise, no reverb.", ["camera", "phone", "snap", "shutter", "selfie"]],
    ["film-advance", 1, "A film camera shutter click followed by the film advance lever winding, mechanical.", ["camera", "film", "advance", "wind", "vintage"]],
    ["zoom-in-whoosh", 0.7, "A fast punch-in zoom whoosh, a quick rising air swipe that stops sharp.", ["camera", "zoom in", "punch in", "whoosh", "fast"]],
    ["zoom-out-whoosh", 0.7, "A fast zoom-out whoosh, a quick falling air swipe that stops sharp.", ["camera", "zoom out", "whoosh", "fast", "pull back"]],
  ], core),
  // One focus sound: the lock itself, the way a DSLR confirms it.
  ...sfx("Camera", [
    ["focus-lock", 0.6, "A single DSLR autofocus lock: one soft, precise lens click with a faint motor tick, dry, close-miked, no beep.", ["camera", "focus", "lock", "lens", "dslr"]],
  ], core),
  ...sfx("Flash", [
    ["pop", 0.8, "A camera flash firing: a quick rising electric charge whine then a bright pop.", ["flash", "camera", "pop", "charge", "quick cut"]],
    ["cut", 0.7, "A bright quick flash transition, a short shimmering white burst that cuts to silence.", ["flash", "transition", "bright", "burst", "quick cut"]],
    ["strobe", 1, "Three fast camera flash pops in quick succession, bright and snappy, dry.", ["flash", "strobe", "pops", "fast", "paparazzi"]],
    ["paparazzi", 2, "Paparazzi on a red carpet: many camera shutters clicking rapidly with bright flash pops layered over them, dense and busy, clean, no music, no voices.", ["flash", "paparazzi", "cameras", "red carpet", "crowd"]],
    ["bulb", 0.8, "An old-fashioned flashbulb firing with a soft crunching pop and a fizz.", ["flash", "bulb", "vintage", "pop", "fizz"]],
  ], core),
  ...sfx("UI", [
    ["pop", 0.5, "A short soft UI pop, like a notification bubble appearing, clean and rounded.", ["ui", "pop", "notification", "bubble", "appear"]],
    ["blip", 0.5, "A short bright synthetic UI blip, clean and dry.", ["ui", "blip", "bright", "beep", "select"]],
    ["tick", 0.5, "A tiny dry UI tick, very short, like a toggle switching.", ["ui", "tick", "toggle", "tiny", "switch"]],
    ["swipe", 0.6, "A short soft UI swipe, a quick airy sweep, clean and smooth.", ["ui", "swipe", "sweep", "slide", "smooth"]],
    ["confirm", 0.8, "A short two-note ascending UI confirmation chime, clean and bright.", ["ui", "confirm", "chime", "success", "done"]],
    ["error", 0.7, "A short low two-note descending UI error buzz, clean and dry.", ["ui", "error", "buzz", "wrong", "deny"]],
    ["hover", 0.5, "A very short soft UI hover tick, subtle and airy.", ["ui", "hover", "subtle", "tick", "soft"]],
    ["open", 0.7, "A short rising UI open sound, a soft synthetic sweep upward, clean.", ["ui", "open", "expand", "rise", "menu"]],
    ["close", 0.7, "A short falling UI close sound, a soft synthetic sweep downward, clean.", ["ui", "close", "collapse", "fall", "menu"]],
    ["typing-cursor", 0.5, "A single soft text cursor blip, a tiny digital tap.", ["ui", "cursor", "tap", "text", "type"]],
    ["toggle-on", 0.5, "A short bright UI toggle switching on, a rising two-part click.", ["ui", "toggle", "on", "switch", "enable"]],
    ["toggle-off", 0.5, "A short muted UI toggle switching off, a falling two-part click.", ["ui", "toggle", "off", "switch", "disable"]],
    ["unlock", 0.8, "A short phone unlock sound, a soft click with a light rising chime.", ["ui", "unlock", "phone", "chime", "click"]],
    ["lock", 0.6, "A short phone lock sound, a soft click with a light falling tone.", ["ui", "lock", "phone", "click", "tone"]],
  ], core),
  ...sfx("Whoosh", [
    ["quick", 0.8, "A quick airy whoosh transition, a fast swipe of air passing close by, dry.", ["whoosh", "transition", "quick", "swipe", "air"]],
    ["deep", 1.2, "A deep cinematic whoosh transition, a heavy rush of air passing by with a low body.", ["whoosh", "transition", "deep", "cinematic", "heavy"]],
    ["swish", 0.6, "A light fast swish, a thin high whoosh like a quick hand wave, dry.", ["whoosh", "swish", "light", "fast", "thin"]],
    ["reverse", 1, "A reversed whoosh sucking inward, swelling up then stopping sharp on the beat.", ["whoosh", "reverse", "suck", "swell", "transition"]],
    ["long", 1.8, "A long smooth cinematic whoosh sweeping past slowly with a soft tail.", ["whoosh", "long", "smooth", "sweep", "cinematic"]],
    ["swoosh", 0.8, "A fast swoosh, a bright quick air swipe with a whip-like snap at the end.", ["whoosh", "swoosh", "whip", "fast", "snap"]],
    ["fabric", 0.9, "A fabric whoosh, a quick flap of heavy cloth swinging past.", ["whoosh", "fabric", "cloth", "flap", "cape"]],
    ["double", 1, "Two quick whooshes back to back, a double swipe of air.", ["whoosh", "double", "swipe", "two", "transition"]],
    ["spin", 1.2, "A spinning whoosh, air whirling around in a fast rotation and slowing to a stop.", ["whoosh", "spin", "rotate", "whirl", "twirl"]],
    ["sub", 1.2, "A low sub-bass whoosh, a deep rumbling rush of air passing by.", ["whoosh", "sub", "bass", "low", "rumble"]],
    ["whip", 0.6, "A sharp whip crack whoosh, a fast air snap.", ["whoosh", "whip", "crack", "snap", "sharp"]],
    ["airy-slow", 1.6, "A soft slow airy whoosh, a gentle wide breath of wind passing.", ["whoosh", "soft", "slow", "airy", "gentle"]],
  ], core),
  ...sfx("Glitch", [
    ["digital", 0.8, "A short digital glitch, a stuttering burst of corrupted data noise, dry.", ["glitch", "digital", "stutter", "data", "corrupt"]],
    ["stutter", 0.7, "A quick glitchy stutter, chopped electronic tearing, fast and dry.", ["glitch", "stutter", "chop", "tear", "electronic"]],
    ["static", 0.7, "A short burst of harsh static interference cutting in and out, brief.", ["glitch", "static", "interference", "noise", "tv"]],
    ["bitcrush", 0.6, "A short bitcrushed digital error, a crunchy distorted zap, dry.", ["glitch", "bitcrush", "error", "zap", "crunchy"]],
    ["tv-noise", 1, "A short burst of old television static snow with a signal drop, harsh.", ["glitch", "tv", "static", "snow", "signal"]],
    ["signal-lost", 1, "A digital signal breaking up, chopped audio dropouts then silence.", ["glitch", "signal", "dropout", "break up", "lost"]],
    ["data-burst", 0.8, "A fast burst of modem-like digital data screeching, brief and harsh.", ["glitch", "data", "modem", "screech", "digital"]],
    ["vhs-tracking", 1.2, "VHS tape tracking glitch, a warbling wobble with a static rip.", ["glitch", "vhs", "tracking", "tape", "warble"]],
    ["scan", 0.8, "A quick digital scanline sweep, an electronic zip upward.", ["glitch", "scan", "sweep", "zip", "digital"]],
  ], core),
  ...sfx("Riser", [
    ["cinematic", 3, "A cinematic riser building tension: a rising filtered noise sweep with a swelling tone, ending abruptly at the peak.", ["riser", "tension", "build", "sweep", "cinematic"]],
    ["short", 1.5, "A short fast riser, a quick rising sweep that ends abruptly at its peak.", ["riser", "short", "fast", "sweep", "build"]],
    ["strings", 3, "A tense rising string tremolo swelling louder and higher, then a sharp stop.", ["riser", "strings", "tremolo", "tension", "swell"]],
    ["drum-roll", 2.5, "A tight snare drum roll accelerating and swelling to a sharp stop, dry.", ["riser", "drum roll", "snare", "build", "reveal"]],
    ["suspense", 4, "A slow ominous suspense riser, a low drone rising with a rattling texture, cut off at the top.", ["riser", "suspense", "ominous", "drone", "slow"]],
    ["synth", 2, "A bright synth riser, an electronic pitch sweep climbing fast to a sharp cut.", ["riser", "synth", "electronic", "sweep", "edm"]],
    ["reverse-cymbal", 2, "A reversed crash cymbal swelling up to a sharp stop.", ["riser", "reverse", "cymbal", "swell", "build"]],
    ["long", 5, "A long cinematic riser building slowly from nothing to a huge peak, then silence.", ["riser", "long", "epic", "build", "trailer"]],
    ["whistle", 2, "A rising whistle tone climbing steadily in pitch to a sharp stop, like a firework going up.", ["riser", "whistle", "rising", "pitch", "firework"]],
    ["ticking", 3, "Accelerating tension ticks speeding up to a frantic blur, then a sharp stop.", ["riser", "ticking", "accelerate", "tension", "countdown"]],
  ], core),
  ...sfx("Hits", [
    ["impact", 1.5, "A deep cinematic impact hit with a short sub boom and a quick tail.", ["hit", "impact", "boom", "cinematic", "land"]],
    ["punch", 0.7, "A tight punchy hit, a short percussive thud, dry and close.", ["hit", "punch", "thud", "tight", "percussive"]],
    ["boom", 2.5, "A big cinematic boom, a deep low impact with a long decaying tail.", ["hit", "boom", "deep", "trailer", "big"]],
    ["slam", 1, "A sharp slam hit with a brief metallic ring, dry.", ["hit", "slam", "metallic", "sharp", "ring"]],
    ["bass-drop", 1.5, "A heavy bass drop hit, a sub-bass thump with a short rumbling tail.", ["hit", "bass", "drop", "sub", "thump"]],
    ["deep-boom-reverb", 2.5, "A deep dramatic boom with a huge reverb tail, comedic and heavy.", ["hit", "boom", "reverb", "dramatic", "meme"]],
    ["braam", 3, "A massive cinematic trailer braam, a low brass blast that swells and decays.", ["hit", "braam", "trailer", "brass", "epic"]],
    ["thud", 0.8, "A dull heavy thud, something heavy landing on a floor, dry.", ["hit", "thud", "heavy", "land", "floor"]],
    ["metal-clang", 1.2, "A sharp metal clang, a steel object struck with a ringing tail.", ["hit", "metal", "clang", "steel", "ring"]],
    ["wood-knock", 0.6, "A single solid wood knock, dry and close.", ["hit", "wood", "knock", "solid", "dry"]],
    ["orchestral", 2, "A sharp orchestral stab hit, full orchestra striking one dramatic chord.", ["hit", "orchestral", "stab", "dramatic", "chord"]],
    ["distortion", 1, "A distorted electronic impact hit, gritty and heavy with a short tail.", ["hit", "distorted", "electronic", "gritty", "heavy"]],
  ], core),
  ...sfx("Keyboard", [
    ["typing", 1.5, "Fast typing on a clicky mechanical keyboard, a run of keystrokes, dry, close-miked.", ["keyboard", "typing", "mechanical", "keys", "text"]],
    ["key", 0.5, "A single mechanical keyboard key press, one crisp click, dry.", ["keyboard", "key", "single", "press", "click"]],
    ["laptop", 1.5, "Quick typing on a laptop keyboard, soft shallow keys, dry, close-miked.", ["keyboard", "laptop", "typing", "soft", "text"]],
    ["enter", 0.5, "A single firm keyboard enter key press, crisp, dry.", ["keyboard", "enter", "return", "press", "send"]],
    ["typewriter", 1.8, "A few keystrokes on an old typewriter ending with the carriage bell, dry.", ["keyboard", "typewriter", "vintage", "bell", "text"]],
    ["typing-long", 3, "Steady typing on a mechanical keyboard for three seconds, dry, close-miked.", ["keyboard", "typing", "long", "mechanical", "work"]],
    ["backspace", 0.8, "Three quick backspace key taps on a keyboard, dry.", ["keyboard", "backspace", "delete", "taps", "correct"]],
    ["phone-typing", 1.5, "Fast typing on a smartphone touchscreen, soft rapid taps with tiny clicks.", ["keyboard", "phone", "touchscreen", "taps", "texting"]],
    ["laptop-key", 0.5, "A single laptop keyboard key press, one soft shallow click, dry, close-miked.", ["keyboard", "laptop", "key", "single", "click"]],
    ["typewriter-key", 0.6, "A single key strike on an old manual typewriter, one sharp metallic clack, no bell, dry.", ["keyboard", "typewriter", "key", "single", "clack"]],
    ["typewriter-typing", 1.8, "A run of keystrokes on an old manual typewriter, sharp metallic clacks, no bell, dry.", ["keyboard", "typewriter", "typing", "vintage", "clacks"]],
    ["mechanical-key", 0.5, "A single clicky mechanical keyboard switch press, one sharp click with a light spring, dry, close-miked.", ["keyboard", "mechanical", "key", "single", "clicky"]],
    ["mechanical-thock", 0.5, "A single deep mechanical keyboard key press, a low dampened thock, dry, close-miked.", ["keyboard", "mechanical", "key", "single", "thock"]],
    ["mechanical-typing", 1.5, "Fast typing on a clicky mechanical keyboard with sharp switch clicks, a run of keystrokes, dry, close-miked.", ["keyboard", "mechanical", "typing", "clicky", "keys"]],
    ["mechanical-thock-typing", 1.5, "Fast typing on a deep mechanical keyboard, a run of low dampened thocks, dry, close-miked.", ["keyboard", "mechanical", "typing", "thock", "keys"]],
  ], core),
  ...sfx("Pops", [
    ["bubble", 0.5, "A single soft bubble pop, wet and round, dry.", ["pop", "bubble", "soft", "wet", "small"]],
    ["cork", 0.7, "A champagne cork popping out of a bottle with a small fizz.", ["pop", "cork", "champagne", "bottle", "celebrate"]],
    ["balloon", 0.6, "A balloon bursting with a sharp pop, dry.", ["pop", "balloon", "burst", "sharp", "bang"]],
    ["mouth", 0.5, "A single mouth pop, lips popping, dry and close.", ["pop", "mouth", "lips", "cartoon", "small"]],
    ["cartoon", 0.5, "A bouncy cartoon pop, short and springy, clean.", ["pop", "cartoon", "bouncy", "springy", "fun"]],
    ["bubble-wrap", 1.2, "Several bubble wrap bubbles popping in quick succession, dry.", ["pop", "bubble wrap", "popping", "plastic", "satisfying"]],
    ["triple", 0.8, "Three quick pops in a row, rising in pitch, clean.", ["pop", "triple", "three", "rising", "fun"]],
  ]),
  ...sfx("Stops", [
    ["tape-stop", 1.2, "A tape stop effect, music slowing down and pitching down to a halt.", ["stop", "tape stop", "slow down", "pitch down", "halt"]],
    ["record-scratch", 0.8, "A vinyl record scratch, a sharp needle scratch stopping the music.", ["stop", "record scratch", "vinyl", "needle", "interrupt"]],
    ["rewind", 1.5, "A fast tape rewind, a high squealing chatter speeding backwards.", ["stop", "rewind", "tape", "backwards", "fast"]],
    ["vinyl-stop", 1.5, "A turntable stopping, the record slowing and pitching down with crackle.", ["stop", "vinyl", "turntable", "slow", "crackle"]],
    ["needle-drop", 1.2, "A record needle dropping onto vinyl with a soft thump and crackle.", ["stop", "needle", "vinyl", "drop", "crackle"]],
    ["power-down", 1.5, "A machine powering down, a tone falling in pitch to silence.", ["stop", "power down", "shut off", "fall", "machine"]],
  ]),
  ...sfx("Dings", [
    ["notification", 0.8, "A soft clean notification ding, a single bright bell tone.", ["ding", "notification", "bell", "alert", "clean"]],
    ["bell", 1, "A single small bell ding, clear and ringing.", ["ding", "bell", "ring", "clear", "single"]],
    ["elevator", 0.9, "An elevator arrival ding, a single soft chime.", ["ding", "elevator", "chime", "arrive", "soft"]],
    ["service", 1, "A hotel front desk service bell, a single sharp ding.", ["ding", "service bell", "desk", "counter", "sharp"]],
    ["correct", 1, "A bright correct-answer ding, a cheerful two-note chime.", ["ding", "correct", "right", "chime", "quiz"]],
    ["level-up", 1.2, "A sparkling level-up chime, a quick ascending arpeggio, bright.", ["ding", "level up", "arpeggio", "win", "achievement"]],
    ["triangle", 1.5, "A single triangle ding with a long shimmering ring.", ["ding", "triangle", "shimmer", "ring", "percussion"]],
    ["bike-bell", 0.8, "A bicycle bell ringing twice, bright and metallic.", ["ding", "bike bell", "bicycle", "ring", "metallic"]],
    ["microwave", 1, "A microwave finishing, three short beeps.", ["ding", "microwave", "beeps", "done", "kitchen"]],
    ["xylophone", 1, "A single bright xylophone note, wooden and clean.", ["ding", "xylophone", "note", "wooden", "bright"]],
  ]),
  ...sfx("Buzzers", [
    ["wrong", 1, "A game show wrong-answer buzzer, a harsh low buzz.", ["buzzer", "wrong", "game show", "fail", "harsh"]],
    ["error-beep", 0.7, "A short electronic error beep, two low flat tones.", ["buzzer", "error", "beep", "flat", "deny"]],
    ["alarm", 1.5, "A short alarm beeping, three fast urgent beeps.", ["buzzer", "alarm", "beeps", "urgent", "warning"]],
    ["door-buzzer", 1, "An apartment door buzzer, a harsh electric buzz.", ["buzzer", "door", "electric", "harsh", "entry"]],
    ["siren-short", 1.5, "A short police siren burst, one whoop.", ["buzzer", "siren", "police", "whoop", "alert"]],
  ]),
  ...sfx("Notifications", [
    ["phone", 0.8, "A phone notification tone, a short soft two-note ping.", ["notification", "phone", "ping", "message", "alert"]],
    ["message-sent", 0.7, "A message sent sound, a short rising swoosh with a soft blip.", ["notification", "sent", "swoosh", "message", "send"]],
    ["message-received", 0.7, "A message received sound, a short soft descending two-note bubble.", ["notification", "received", "message", "bubble", "incoming"]],
    ["vibrate", 1, "A phone vibrating on a wooden table, two short buzzes.", ["notification", "vibrate", "buzz", "phone", "table"]],
    ["ringtone", 2, "A short classic phone ringtone, two rings, clean.", ["notification", "ringtone", "ring", "phone", "call"]],
    ["ping", 0.6, "A tiny bright ping, a single high note, clean.", ["notification", "ping", "bright", "high", "single"]],
    ["mail", 0.9, "An email arriving, a soft short chime.", ["notification", "email", "mail", "chime", "inbox"]],
    ["typing-bubble", 1.2, "A messaging app typing indicator, three soft ascending bubble blips.", ["notification", "typing", "bubbles", "chat", "blips"]],
    ["like", 0.6, "A social media like sound, a quick soft pop with a tiny sparkle.", ["notification", "like", "heart", "pop", "social"]],
    ["cash-app", 0.9, "A payment received sound, a bright quick chime with a coin tinkle.", ["notification", "payment", "chime", "coin", "money"]],
  ]),
  ...sfx("Money", [
    ["cash-register", 1.2, "A cash register opening with a cha-ching bell and drawer.", ["money", "cash register", "cha-ching", "sale", "drawer"]],
    ["coins", 1.2, "A handful of coins jingling and dropping onto a table.", ["money", "coins", "jingle", "drop", "change"]],
    ["coin-drop", 0.7, "A single coin dropping and spinning to rest on a hard surface.", ["money", "coin", "drop", "spin", "single"]],
    ["counter", 2, "A bill counting machine rapidly counting a stack of banknotes.", ["money", "counter", "bills", "cash", "stack"]],
    ["card-swipe", 0.7, "A credit card swiping through a reader with a confirmation beep.", ["money", "card", "swipe", "beep", "pay"]],
    ["slot-win", 2.5, "A slot machine jackpot, ringing bells and coins pouring out.", ["money", "jackpot", "slot", "win", "coins"]],
    ["bills-flip", 1.5, "Flipping through a thick stack of banknotes with a thumb.", ["money", "bills", "flip", "stack", "riffle"]],
  ]),
  ...sfx("Crowd", [
    ["applause", 3, "A medium crowd applauding warmly for three seconds.", ["crowd", "applause", "clap", "audience", "praise"]],
    ["laugh", 2.5, "A studio audience laughing, a warm laugh track.", ["crowd", "laugh", "audience", "laugh track", "funny"]],
    ["gasp", 1.2, "A crowd gasping in surprise all at once.", ["crowd", "gasp", "surprise", "shock", "audience"]],
    ["boo", 2.5, "A crowd booing with disapproval.", ["crowd", "boo", "disapprove", "audience", "bad"]],
    ["small-laugh", 1.5, "A few people chuckling quietly.", ["crowd", "chuckle", "small", "laugh", "quiet"]],
    ["ooh", 1.5, "A crowd going ooh in awe together.", ["crowd", "ooh", "awe", "impressed", "audience"]],
    ["awww", 1.5, "An audience going aww together, tender.", ["crowd", "aww", "cute", "tender", "audience"]],
  ]),
  // Cheering gets takes: a win, a reveal and a landing each want their own.
  ...sfx("Crowd", [
    ["cheer", 3, "A big crowd cheering and whooping loudly, excited.", ["crowd", "cheer", "whoop", "excited", "win"]],
    ["cheer-small", 2, "A small group of friends cheering and clapping, close and excited.", ["crowd", "cheer", "friends", "small", "clap"]],
    ["cheer-party", 2.5, "A lively party crowd cheering with whistles and whoops.", ["crowd", "cheer", "party", "whistle", "celebrate"]],
    ["cheer-team", 2, "A sports team cheering together in a huddle, one big group shout.", ["crowd", "cheer", "team", "huddle", "shout"]],
    ["cheer-office", 2, "An office full of coworkers cheering and applauding, indoors.", ["crowd", "cheer", "office", "coworkers", "applause"]],
    ["cheer-distant", 3, "A distant crowd cheering from far away, outdoors.", ["crowd", "cheer", "distant", "far", "outdoors"]],
    ["kids-cheer", 2, "A group of children cheering happily.", ["crowd", "kids", "cheer", "children", "happy"]],
    ["kids-yay", 1.5, "A classroom of children shouting yay together, happy.", ["crowd", "kids", "yay", "children", "classroom"]],
    ["stadium", 3, "A stadium crowd roaring after a goal, huge and distant.", ["crowd", "stadium", "roar", "goal", "sports"]],
  ], core),
  ...sfx("Cartoon", [
    ["boing", 0.8, "A cartoon boing, a springy bounce sound.", ["cartoon", "boing", "spring", "bounce", "funny"]],
    ["slide-up", 1, "A slide whistle sliding up in pitch, cartoonish.", ["cartoon", "slide whistle", "up", "rise", "funny"]],
    ["slide-down", 1, "A slide whistle sliding down in pitch, cartoonish.", ["cartoon", "slide whistle", "down", "fall", "fail"]],
    ["bonk", 0.6, "A cartoon bonk, a hollow wooden head-hit, comedic.", ["cartoon", "bonk", "hollow", "hit", "funny"]],
    ["squeak", 0.5, "A quick rubber squeak, a squeaky toy squeezed once.", ["cartoon", "squeak", "toy", "rubber", "funny"]],
    ["duck", 0.6, "A rubber duck squeaking once, comedic.", ["cartoon", "rubber duck", "squeak", "toy", "funny"]],
    ["stretch", 1, "A cartoon stretch, a rising rubbery creak.", ["cartoon", "stretch", "rubber", "creak", "pull"]],
    ["zip-away", 0.8, "A cartoon character zipping away fast, a quick rising whistle whoosh.", ["cartoon", "zip", "run away", "fast", "whistle"]],
    ["spring-wobble", 1.2, "A cartoon spring wobbling back and forth after being flicked.", ["cartoon", "spring", "wobble", "boing", "flick"]],
    ["eye-pop", 0.7, "A cartoon eye-pop, a quick comedic stretch and pop.", ["cartoon", "eye pop", "surprise", "pop", "funny"]],
    ["whistle-fall", 1.8, "A cartoon falling whistle descending in pitch then a small thud.", ["cartoon", "fall", "whistle", "descend", "thud"]],
    ["kazoo", 1, "A short silly kazoo buzz, two notes.", ["cartoon", "kazoo", "silly", "buzz", "funny"]],
    ["horn-honk", 0.7, "A clown horn honking once, comedic.", ["cartoon", "honk", "clown", "horn", "funny"]],
  ]),
  ...sfx("Magic", [
    ["sparkle", 1.5, "A magical sparkle shimmer, glittering high chimes fading.", ["magic", "sparkle", "shimmer", "glitter", "twinkle"]],
    ["wand", 1, "A magic wand twinkle, a quick ascending sparkle.", ["magic", "wand", "twinkle", "spell", "cast"]],
    ["fairy-dust", 2, "Fairy dust falling, soft tinkling bells cascading down.", ["magic", "fairy", "dust", "bells", "cascade"]],
    ["reveal", 1.5, "A magical reveal shimmer, a bright glimmering swell.", ["magic", "reveal", "glimmer", "swell", "transform"]],
    ["harp", 1.5, "A quick harp glissando sweeping upward, dreamy.", ["magic", "harp", "glissando", "dream", "flashback"]],
    ["poof", 0.8, "A magic poof, a soft puff with a sprinkle of sparkle.", ["magic", "poof", "puff", "vanish", "disappear"]],
    ["chime-swell", 2, "A soft wind chime swell, gentle and glowing.", ["magic", "chime", "swell", "wind chime", "gentle"]],
    ["harp-down", 1.5, "A quick harp glissando sweeping downward, dreamy.", ["magic", "harp", "glissando", "down", "dream"]],
  ]),
  ...sfx("Stingers", [
    ["dramatic", 2, "A dramatic three-note dun dun dun orchestral sting, suspenseful.", ["stinger", "dramatic", "dun dun dun", "suspense", "reveal"]],
    ["horror", 2, "A horror sting, a sharp screeching violin stab with a dark tail.", ["stinger", "horror", "violin", "screech", "scare"]],
    ["suspense", 2.5, "A suspense sting, a low ominous string swell with a sharp accent.", ["stinger", "suspense", "ominous", "strings", "tension"]],
    ["rimshot", 1, "A comedy rimshot, ba-dum-tss on snare and cymbal.", ["stinger", "rimshot", "ba dum tss", "joke", "comedy"]],
    ["sad-trombone", 2, "A sad trombone, a descending wah wah wah waaah.", ["stinger", "sad trombone", "womp", "fail", "comedy"]],
    ["brass-fanfare", 2, "A short triumphant brass fanfare, a victory flourish.", ["stinger", "fanfare", "brass", "victory", "triumph"]],
    ["mystery", 2, "A mysterious sting, a shimmering suspended chord with a question mark feel.", ["stinger", "mystery", "curious", "question", "hmm"]],
    ["evil-laugh-organ", 2, "A dramatic pipe organ chord, villainous and grand.", ["stinger", "organ", "villain", "dramatic", "evil"]],
    ["news", 2, "A short breaking-news sting, urgent synth hits with a whoosh.", ["stinger", "news", "breaking", "urgent", "broadcast"]],
    ["dun", 1.5, "A single deep dramatic dun, an orchestral low accent with reverb.", ["stinger", "dun", "dramatic", "low", "accent"]],
  ]),
  ...sfx("Drums", [
    ["snare", 0.6, "A single tight snare drum hit, dry.", ["drum", "snare", "hit", "single", "tight"]],
    ["kick", 0.6, "A single punchy kick drum hit, dry.", ["drum", "kick", "punch", "single", "bass"]],
    ["crash", 2, "A single crash cymbal hit with a long ring.", ["drum", "crash", "cymbal", "ring", "accent"]],
    ["fill", 1.5, "A short fast drum fill on toms ending with a crash.", ["drum", "fill", "toms", "crash", "break"]],
    ["hi-hat", 0.5, "A single closed hi-hat tick, crisp and dry.", ["drum", "hi-hat", "tick", "crisp", "single"]],
    ["timpani", 2, "A dramatic timpani roll swelling to a hit.", ["drum", "timpani", "roll", "dramatic", "orchestral"]],
    ["tom-hits", 1, "Three descending tom drum hits, dry.", ["drum", "toms", "descending", "hits", "three"]],
    ["clap-808", 0.6, "A single sharp electronic clap, a classic drum machine clap.", ["drum", "clap", "electronic", "drum machine", "sharp"]],
    ["snare-roll-short", 1.2, "A short crisp snare roll ending with a single hit.", ["drum", "snare", "roll", "short", "hit"]],
    ["gong", 3, "A large gong struck once with a long shimmering decay.", ["drum", "gong", "strike", "decay", "ceremony"]],
  ]),
  ...sfx("Time", [
    ["tick", 0.5, "A single clock tick, dry and wooden.", ["time", "clock", "tick", "single", "wooden"]],
    ["ticking", 3, "A clock ticking steadily for three seconds, dry.", ["time", "clock", "ticking", "steady", "wait"]],
    ["stopwatch", 0.6, "A stopwatch button click starting, a mechanical click.", ["time", "stopwatch", "click", "start", "timer"]],
    ["countdown", 3, "Three countdown beeps then a long final beep.", ["time", "countdown", "beeps", "three", "go"]],
    ["alarm-clock", 2, "An old alarm clock ringing with a metal bell, harsh.", ["time", "alarm clock", "ring", "bell", "wake up"]],
    ["timer-ding", 1, "A kitchen timer ding, a single bright bell.", ["time", "timer", "ding", "kitchen", "done"]],
    ["cuckoo", 1.5, "A cuckoo clock chiming twice.", ["time", "cuckoo", "clock", "chime", "hour"]],
    ["grandfather", 3, "A grandfather clock striking deep chimes.", ["time", "grandfather clock", "chime", "deep", "strike"]],
  ]),
  ...sfx("Tension", [
    ["heartbeat-slow", 3, "A slow heavy heartbeat, deep and steady, three seconds.", ["tension", "heartbeat", "slow", "deep", "steady"]],
    ["heartbeat-fast", 3, "A fast racing heartbeat, deep and urgent, three seconds.", ["tension", "heartbeat", "fast", "racing", "urgent"]],
    ["drone", 4, "A low ominous drone hum holding steady, dark.", ["tension", "drone", "hum", "ominous", "dark"]],
    ["breath", 2, "A tense held breath then a sharp exhale.", ["tension", "breath", "exhale", "hold", "nervous"]],
    ["pulse", 3, "A low pulsing sub-bass throb, steady and tense.", ["tension", "pulse", "throb", "sub", "steady"]],
    ["ringing-ears", 3, "A high-pitched ear ringing tone, thin and steady.", ["tension", "ringing", "ears", "tinnitus", "high"]],
  ]),
  ...sfx("Paper", [
    ["page-flip", 0.7, "A single page flipping in a book, dry.", ["paper", "page", "flip", "book", "turn"]],
    ["page-turn-slow", 1.2, "A page turning slowly in a large book with a soft rustle.", ["paper", "page", "turn", "slow", "rustle"]],
    ["crumple", 1.2, "A sheet of paper being crumpled into a ball.", ["paper", "crumple", "ball", "crush", "trash"]],
    ["tear", 0.8, "A sheet of paper tearing in half.", ["paper", "tear", "rip", "half", "shred"]],
    ["book-close", 0.8, "A hardcover book closing with a soft thump.", ["paper", "book", "close", "thump", "shut"]],
    ["scribble", 1.5, "A pen scribbling quickly on paper.", ["paper", "pen", "scribble", "write", "note"]],
    ["pencil", 1.5, "A pencil writing on paper, soft scratching.", ["paper", "pencil", "write", "scratch", "sketch"]],
    ["stamp", 0.7, "A rubber stamp thumping down on paper.", ["paper", "stamp", "approve", "thump", "office"]],
    ["pages-riffle", 1.5, "Riffling through the pages of a book quickly.", ["paper", "riffle", "pages", "flip", "fast"]],
    ["envelope", 1.2, "An envelope being torn open.", ["paper", "envelope", "open", "tear", "mail"]],
    ["marker", 1, "A marker squeaking as it writes on a whiteboard.", ["paper", "marker", "whiteboard", "squeak", "write"]],
    ["check-mark", 0.6, "A quick pen stroke drawing a check mark on paper.", ["paper", "check", "tick", "pen", "done"]],
  ]),
  ...sfx("Doors", [
    ["knock", 1.2, "Three knocks on a wooden door.", ["door", "knock", "three", "wood", "visitor"]],
    ["open-creak", 1.5, "A wooden door opening slowly with a creak.", ["door", "open", "creak", "slow", "wood"]],
    ["close", 0.8, "A door closing with a solid click.", ["door", "close", "click", "shut", "solid"]],
    ["slam", 0.9, "A door slamming shut hard.", ["door", "slam", "hard", "angry", "shut"]],
    ["doorbell", 1.5, "A classic two-tone doorbell ding-dong.", ["door", "doorbell", "ding dong", "chime", "visitor"]],
    ["car-door", 0.8, "A car door closing with a solid thunk.", ["door", "car", "thunk", "close", "vehicle"]],
    ["sliding", 1.2, "A sliding glass door rolling open.", ["door", "sliding", "glass", "roll", "open"]],
    ["lock", 0.7, "A door lock turning with a key, a metallic click.", ["door", "lock", "key", "click", "metal"]],
    ["fridge", 1, "A refrigerator door opening with a soft suction seal.", ["door", "fridge", "open", "seal", "kitchen"]],
  ]),
  ...sfx("Footsteps", [
    ["concrete", 2, "Footsteps walking on concrete, four steps, hard shoes.", ["footsteps", "concrete", "walk", "shoes", "hard"]],
    ["wood", 2, "Footsteps walking on a wooden floor, four steps.", ["footsteps", "wood", "floor", "walk", "creak"]],
    ["gravel", 2, "Footsteps walking on gravel, four crunching steps.", ["footsteps", "gravel", "crunch", "walk", "path"]],
    ["running", 2, "Fast running footsteps on pavement.", ["footsteps", "running", "pavement", "fast", "sprint"]],
    ["heels", 2, "High heels clicking on a tile floor, four steps.", ["footsteps", "heels", "tile", "click", "walk"]],
    ["grass", 2, "Soft footsteps walking on grass, four steps.", ["footsteps", "grass", "soft", "walk", "outdoor"]],
    ["snow", 2, "Footsteps crunching through snow, four steps.", ["footsteps", "snow", "crunch", "walk", "winter"]],
    ["stairs", 2, "Footsteps climbing wooden stairs quickly.", ["footsteps", "stairs", "climb", "wood", "up"]],
  ]),
  ...sfx("Water", [
    ["drop", 0.8, "A single water drop falling into still water with a small plink.", ["water", "drop", "plink", "single", "drip"]],
    ["splash", 1.2, "A splash, something dropping into water.", ["water", "splash", "drop", "pool", "wet"]],
    ["pour", 2, "Water pouring from a bottle into a glass.", ["water", "pour", "glass", "bottle", "drink"]],
    ["bubbles", 2, "Bubbles rising underwater, gentle gurgling.", ["water", "bubbles", "underwater", "gurgle", "rise"]],
    ["wave", 3, "A single ocean wave crashing on the shore.", ["water", "wave", "crash", "ocean", "shore"]],
    ["faucet", 2, "A kitchen faucet running then turning off.", ["water", "faucet", "tap", "running", "sink"]],
    ["underwater", 3, "A muffled underwater ambience with slow bubbles.", ["water", "underwater", "muffled", "deep", "dive"]],
    ["stream", 3, "A small stream babbling over rocks.", ["water", "stream", "babble", "creek", "nature"]],
    ["drip-echo", 1.5, "A water drip echoing in a cave.", ["water", "drip", "echo", "cave", "lonely"]],
    ["sip", 0.8, "A person sipping a drink through a straw, short.", ["water", "sip", "straw", "drink", "slurp"]],
  ]),
  ...sfx("Weather", [
    ["thunder", 3, "A sharp thunder crack followed by a rolling rumble.", ["weather", "thunder", "crack", "rumble", "storm"]],
    ["rain", 4, "Steady rain falling on a roof.", ["weather", "rain", "roof", "steady", "storm"]],
    ["wind-gust", 2.5, "A strong wind gust howling past.", ["weather", "wind", "gust", "howl", "storm"]],
    ["lightning", 1.5, "A lightning strike, a sharp electric crack.", ["weather", "lightning", "strike", "crack", "electric"]],
    ["distant-thunder", 3, "Distant thunder rumbling softly.", ["weather", "thunder", "distant", "rumble", "soft"]],
    ["rain-window", 4, "Rain tapping on a window pane.", ["weather", "rain", "window", "tap", "cozy"]],
    ["hail", 2.5, "Hail pelting a metal roof.", ["weather", "hail", "metal", "roof", "pelt"]],
    ["breeze", 3, "A soft gentle breeze through leaves.", ["weather", "breeze", "leaves", "gentle", "calm"]],
  ]),
  ...sfx("Fire", [
    ["explosion", 2.5, "A big explosion with debris and a rumbling tail.", ["fire", "explosion", "blast", "debris", "boom"]],
    ["small-explosion", 1.2, "A small sharp explosion, a firecracker bang.", ["fire", "explosion", "small", "bang", "firecracker"]],
    ["crackle", 3, "A campfire crackling and popping.", ["fire", "crackle", "campfire", "pop", "cozy"]],
    ["fuse", 2, "A fuse burning with a hissing sizzle.", ["fire", "fuse", "hiss", "burn", "bomb"]],
    ["firework-launch", 1.2, "A firework launching with a whistling rise.", ["fire", "firework", "launch", "whistle", "rise"]],
    ["firework-burst", 1.5, "A firework bursting in the sky with crackles.", ["fire", "firework", "burst", "crackle", "sky"]],
    ["fireworks-show", 4, "Several fireworks bursting in a finale with crackles.", ["fire", "fireworks", "finale", "show", "celebrate"]],
    ["whoosh-flame", 1, "A burst of flame igniting with a whoosh.", ["fire", "flame", "ignite", "whoosh", "burst"]],
    ["match", 1, "A match striking and igniting.", ["fire", "match", "strike", "ignite", "light"]],
    ["lighter", 0.8, "A lighter flicking and lighting.", ["fire", "lighter", "flick", "light", "click"]],
    ["torch", 2.5, "A torch flame roaring and flickering.", ["fire", "torch", "roar", "flicker", "flame"]],
  ]),
  ...sfx("Horns", [
    ["air-horn", 1.5, "A loud air horn blast, one long blast.", ["horn", "air horn", "blast", "loud", "hype"]],
    ["air-horn-triple", 1.5, "Three quick air horn blasts.", ["horn", "air horn", "triple", "blasts", "hype"]],
    ["foghorn", 3, "A deep ship foghorn blast, distant.", ["horn", "foghorn", "ship", "deep", "distant"]],
    ["car-horn", 0.8, "A car horn honking once.", ["horn", "car", "honk", "traffic", "beep"]],
    ["party", 1, "A party horn blowing with a rattle.", ["horn", "party", "blow", "rattle", "celebrate"]],
    ["train", 2.5, "A train horn blaring twice, distant.", ["horn", "train", "blare", "distant", "railway"]],
    ["truck", 1.5, "A big truck air horn blasting.", ["horn", "truck", "air horn", "blast", "road"]],
    ["vuvuzela", 1.5, "A vuvuzela buzzing loudly.", ["horn", "vuvuzela", "buzz", "stadium", "loud"]],
  ]),
  ...sfx("Vehicles", [
    ["car-pass", 2.5, "A car driving past quickly on a road.", ["vehicle", "car", "pass by", "road", "drive"]],
    ["car-start", 2, "A car engine starting and idling.", ["vehicle", "car", "start", "engine", "idle"]],
    ["tire-screech", 1.5, "Tires screeching as a car brakes hard.", ["vehicle", "tires", "screech", "brake", "skid"]],
    ["motorcycle", 2.5, "A motorcycle revving and speeding away.", ["vehicle", "motorcycle", "rev", "speed", "engine"]],
    ["helicopter", 4, "A helicopter hovering overhead, rotor blades thumping.", ["vehicle", "helicopter", "rotor", "hover", "overhead"]],
    ["jet-flyby", 3, "A jet flying past overhead with a roar.", ["vehicle", "jet", "flyby", "roar", "plane"]],
    ["train-pass", 4, "A train rushing past on the tracks.", ["vehicle", "train", "pass", "tracks", "rush"]],
    ["bike-chain", 2, "A bicycle coasting, the chain and freewheel clicking.", ["vehicle", "bicycle", "chain", "click", "coast"]],
    ["engine-rev", 1.5, "A sports car engine revving twice.", ["vehicle", "engine", "rev", "sports car", "loud"]],
    ["seatbelt", 0.8, "A seatbelt clicking into its buckle.", ["vehicle", "seatbelt", "click", "buckle", "car"]],
    ["turn-signal", 2, "A car turn signal clicking steadily.", ["vehicle", "turn signal", "blinker", "click", "car"]],
    ["skateboard", 2.5, "A skateboard rolling on pavement and doing a kick trick.", ["vehicle", "skateboard", "roll", "trick", "pavement"]],
    ["airplane-cabin", 4, "An airplane cabin interior hum during flight.", ["vehicle", "airplane", "cabin", "hum", "flight"]],
    ["subway", 3, "A subway train arriving at a station with brakes squealing.", ["vehicle", "subway", "arrive", "brakes", "station"]],
  ]),
  ...sfx("Kitchen", [
    ["sizzle", 3, "Food sizzling in a hot pan.", ["kitchen", "sizzle", "pan", "cook", "fry"]],
    ["chop", 2, "A knife chopping vegetables on a wooden board, quick chops.", ["kitchen", "chop", "knife", "board", "cut"]],
    ["kettle", 3, "A kettle whistling as it boils.", ["kitchen", "kettle", "whistle", "boil", "tea"]],
    ["toaster", 1, "A toaster popping up.", ["kitchen", "toaster", "pop", "toast", "breakfast"]],
    ["soda-open", 1.2, "A soda can opening with a crack and a fizz.", ["kitchen", "soda", "can", "open", "fizz"]],
    ["glass-clink", 0.8, "Two wine glasses clinking together.", ["kitchen", "glass", "clink", "cheers", "toast"]],
    ["crunch", 0.8, "A crisp bite into a crunchy apple.", ["kitchen", "crunch", "bite", "apple", "crisp"]],
    ["pan-clang", 1, "A metal pan clanging on a stove.", ["kitchen", "pan", "clang", "metal", "stove"]],
    ["pour-drink", 2, "A drink pouring into a glass with ice.", ["kitchen", "pour", "drink", "ice", "glass"]],
    ["blender", 3, "A blender whirring on high.", ["kitchen", "blender", "whir", "smoothie", "loud"]],
    ["egg-crack", 0.8, "An egg cracking on the edge of a bowl.", ["kitchen", "egg", "crack", "bowl", "cook"]],
    ["coffee-machine", 3, "An espresso machine brewing and steaming.", ["kitchen", "coffee", "espresso", "brew", "steam"]],
    ["fridge-hum", 3, "A refrigerator humming quietly.", ["kitchen", "fridge", "hum", "quiet", "appliance"]],
    ["cutlery", 1.2, "Cutlery clinking on a plate.", ["kitchen", "cutlery", "clink", "plate", "eat"]],
    ["popcorn", 3, "Popcorn popping in a pot.", ["kitchen", "popcorn", "pop", "movie", "snack"]],
    ["slurp", 1, "A loud noodle slurp.", ["kitchen", "slurp", "noodles", "eat", "soup"]],
    ["bottle-open", 0.8, "A beer bottle cap popping off with an opener.", ["kitchen", "bottle", "cap", "open", "beer"]],
    ["ice", 1.2, "Ice cubes dropping into a glass.", ["kitchen", "ice", "cubes", "glass", "drink"]],
  ]),
  ...sfx("Body", [
    ["snap", 0.5, "A single finger snap, dry and crisp.", ["body", "snap", "finger", "crisp", "click"]],
    ["clap", 0.5, "A single hand clap, dry.", ["body", "clap", "hand", "single", "dry"]],
    ["double-clap", 0.8, "Two quick hand claps.", ["body", "clap", "double", "two", "hands"]],
    ["hand-rub", 1.5, "Hands rubbing together eagerly.", ["body", "hands", "rub", "eager", "scheme"]],
    ["slap", 0.6, "A sharp face slap.", ["body", "slap", "face", "sharp", "smack"]],
    ["gulp", 0.8, "A loud nervous gulp swallow.", ["body", "gulp", "swallow", "nervous", "throat"]],
    ["punch", 0.7, "A punch landing with a meaty thud.", ["body", "punch", "thud", "fight", "hit"]],
    ["stomach", 1.5, "A stomach growling with hunger.", ["body", "stomach", "growl", "hungry", "rumble"]],
    ["knuckle-crack", 1, "Knuckles cracking one after another.", ["body", "knuckles", "crack", "fingers", "ready"]],
    ["whistle", 1, "A short sharp two-tone wolf whistle.", ["body", "whistle", "wolf whistle", "sharp", "hey"]],
    ["snore", 2.5, "A loud rhythmic snore.", ["body", "snore", "sleep", "loud", "asleep"]],
    ["footstomp", 0.6, "A single foot stomping on a wooden floor.", ["body", "stomp", "foot", "floor", "angry"]],
    ["kiss", 0.5, "A quick kiss smack.", ["body", "kiss", "smack", "mwah", "love"]],
    ["sneeze", 1, "A sudden loud sneeze.", ["body", "sneeze", "achoo", "sudden", "sick"]],
  ]),
  ...sfx("Cloth", [
    ["zipper", 0.8, "A jacket zipper zipping up quickly.", ["cloth", "zipper", "zip", "jacket", "fast"]],
    ["velcro", 0.8, "A velcro strap ripping open.", ["cloth", "velcro", "rip", "open", "strap"]],
    ["rustle", 1.5, "Clothes rustling as someone moves.", ["cloth", "rustle", "clothes", "move", "fabric"]],
    ["snap-fabric", 0.7, "A sheet of fabric snapping taut.", ["cloth", "fabric", "snap", "sheet", "taut"]],
    ["bag-zip", 1, "A backpack zipper opening slowly.", ["cloth", "backpack", "zipper", "open", "bag"]],
    ["shoes", 1, "Sneakers squeaking on a gym floor.", ["cloth", "sneakers", "squeak", "gym", "floor"]],
    ["bag-rustle", 1.5, "A plastic shopping bag rustling.", ["cloth", "plastic bag", "rustle", "shopping", "crinkle"]],
  ]),
  ...sfx("Tech", [
    ["boot", 2, "A computer booting up with a soft synth chime.", ["tech", "boot", "startup", "chime", "computer"]],
    ["shutdown", 1.5, "A computer shutting down with a soft descending chime.", ["tech", "shutdown", "off", "chime", "computer"]],
    ["modem", 3, "A dial-up modem connecting, screeching tones.", ["tech", "modem", "dial-up", "screech", "internet"]],
    ["printer", 3, "An inkjet printer printing a page.", ["tech", "printer", "print", "page", "office"]],
    ["scanner-beep", 0.6, "A barcode scanner beep, one short high beep.", ["tech", "scanner", "beep", "barcode", "checkout"]],
    ["robot-beep", 1, "A friendly robot beeping three quick notes.", ["tech", "robot", "beep", "friendly", "notes"]],
    ["data", 1.5, "Digital data transferring, fast electronic blips.", ["tech", "data", "transfer", "blips", "loading"]],
    ["laser", 0.6, "A sci-fi laser zap, a short pew.", ["tech", "laser", "zap", "pew", "sci-fi"]],
    ["power-up", 1.5, "A machine powering up, a tone rising in pitch and settling.", ["tech", "power up", "rise", "on", "machine"]],
    ["electric-zap", 0.7, "A sharp electric zap, a brief crackling spark.", ["tech", "electric", "zap", "spark", "crackle"]],
    ["static-shock", 0.5, "A tiny static shock crackle.", ["tech", "static", "shock", "crackle", "tiny"]],
    ["hard-drive", 2, "A hard drive clicking and spinning.", ["tech", "hard drive", "click", "spin", "computer"]],
    ["camera-beep", 0.6, "A digital camera beeping once.", ["tech", "camera", "beep", "digital", "single"]],
    ["loading", 2, "A loading spinner ticking, soft repeating blips.", ["tech", "loading", "spinner", "blips", "wait"]],
    ["error-glitch", 0.8, "A computer error, a harsh digital blip with a buzz.", ["tech", "error", "computer", "buzz", "blip"]],
    ["drone-fly", 3, "A camera drone flying past, buzzing propellers.", ["tech", "drone", "fly", "propellers", "buzz"]],
    ["mouse-scroll", 1, "A mouse scroll wheel clicking rapidly.", ["tech", "mouse", "scroll", "wheel", "click"]],
    ["dial-tone", 1.5, "A phone dial tone, a flat steady hum.", ["tech", "dial tone", "phone", "hum", "hang up"]],
    ["busy-signal", 2, "A phone busy signal beeping.", ["tech", "busy", "signal", "beep", "phone"]],
    ["hang-up", 0.7, "A phone handset hanging up with a click.", ["tech", "hang up", "click", "phone", "end call"]],
  ]),
  ...sfx("Sci-Fi", [
    ["teleport", 1.5, "A sci-fi teleport, a shimmering electronic swirl that vanishes.", ["sci-fi", "teleport", "shimmer", "swirl", "vanish"]],
    ["force-field", 2, "A force field activating with a rising hum.", ["sci-fi", "force field", "hum", "shield", "activate"]],
    ["spaceship", 3, "A spaceship flying past with a deep engine roar.", ["sci-fi", "spaceship", "fly", "engine", "roar"]],
    ["hologram", 1.5, "A hologram flickering on, a glitchy electronic shimmer.", ["sci-fi", "hologram", "flicker", "shimmer", "on"]],
    ["portal", 2.5, "A portal opening, a swirling energy whoosh.", ["sci-fi", "portal", "open", "swirl", "energy"]],
    ["laser-blast", 1, "A heavy sci-fi laser cannon blast.", ["sci-fi", "laser", "cannon", "blast", "heavy"]],
    ["scan", 1.5, "A sci-fi scanner sweeping, a rising and falling electronic tone.", ["sci-fi", "scan", "sweep", "tone", "scanner"]],
    ["alarm", 2, "A spaceship alert alarm, a repeating klaxon.", ["sci-fi", "alarm", "klaxon", "alert", "spaceship"]],
    ["door", 1.2, "A sci-fi sliding door hissing open.", ["sci-fi", "door", "hiss", "slide", "open"]],
    ["computer-voice-beep", 1, "A sci-fi computer processing, rapid electronic beeps.", ["sci-fi", "computer", "beeps", "process", "rapid"]],
    ["energy-charge", 2, "An energy weapon charging up with a rising whine.", ["sci-fi", "charge", "whine", "rise", "weapon"]],
    ["robot-servo", 1, "A robot servo motor moving with a whir.", ["sci-fi", "robot", "servo", "whir", "move"]],
  ]),
  ...sfx("Games", [
    ["coin", 0.6, "A retro video game coin collect, a bright two-note ding.", ["game", "coin", "collect", "retro", "ding"]],
    ["level-up", 1.5, "A retro video game level-up jingle, a short ascending chiptune melody.", ["game", "level up", "jingle", "chiptune", "win"]],
    ["power-up", 1.2, "A retro video game power-up, a rising chiptune sweep.", ["game", "power up", "chiptune", "rise", "boost"]],
    ["jump", 0.5, "A retro video game jump, a quick rising chiptune blip.", ["game", "jump", "chiptune", "blip", "retro"]],
    ["game-over", 2, "A retro video game game-over jingle, a short descending chiptune melody.", ["game", "game over", "lose", "chiptune", "fail"]],
    ["hit", 0.5, "A retro video game hit, a short harsh chiptune blip.", ["game", "hit", "damage", "chiptune", "retro"]],
    ["achievement", 1.5, "An achievement unlocked chime, a bright modern two-note sting.", ["game", "achievement", "unlock", "chime", "trophy"]],
    ["select", 0.5, "A retro video game menu select blip.", ["game", "select", "menu", "blip", "retro"]],
    ["explosion-8bit", 1, "A retro 8-bit explosion, a crunchy noise burst.", ["game", "explosion", "8-bit", "noise", "retro"]],
    ["pause", 0.7, "A retro video game pause blip, two quick notes.", ["game", "pause", "blip", "retro", "menu"]],
    ["one-up", 1, "A retro video game extra life jingle, a quick rising chiptune arpeggio.", ["game", "extra life", "1up", "chiptune", "arpeggio"]],
    ["laser-8bit", 0.6, "A retro 8-bit laser shot, a quick descending zap.", ["game", "laser", "8-bit", "zap", "shoot"]],
    ["victory", 2.5, "A retro video game victory fanfare, a triumphant chiptune melody.", ["game", "victory", "fanfare", "chiptune", "win"]],
    ["wrong-buzz", 0.8, "A retro video game wrong answer buzz, a low chiptune buzz.", ["game", "wrong", "buzz", "chiptune", "fail"]],
  ]),
  ...sfx("Toys", [
    ["dice", 1.2, "Dice rolling across a wooden table.", ["toys", "dice", "roll", "table", "board game"]],
    ["cards-shuffle", 1.5, "A deck of cards being shuffled.", ["toys", "cards", "shuffle", "deck", "poker"]],
    ["card-flip", 0.6, "A single playing card flipping over on a table.", ["toys", "card", "flip", "reveal", "poker"]],
    ["chess", 0.6, "A chess piece being placed firmly on a board.", ["toys", "chess", "piece", "place", "move"]],
    ["whistle-referee", 1, "A referee whistle blowing sharply once.", ["toys", "whistle", "referee", "sharp", "foul"]],
    ["rattle", 1.2, "A baby rattle shaking.", ["toys", "rattle", "baby", "shake", "toy"]],
    ["wind-up", 2, "A wind-up toy being wound then whirring.", ["toys", "wind up", "whir", "mechanical", "toy"]],
    ["ball-bounce", 1.5, "A rubber ball bouncing three times on a floor.", ["toys", "ball", "bounce", "rubber", "floor"]],
    ["lego", 1, "Plastic building bricks clicking together.", ["toys", "bricks", "click", "plastic", "build"]],
    ["squeaky-toy", 0.8, "A dog squeaky toy being squeezed twice.", ["toys", "squeaky", "dog toy", "squeeze", "squeak"]],
    ["spinner", 2, "A fidget spinner spinning with a soft whir.", ["toys", "spinner", "fidget", "whir", "spin"]],
    ["bell-jingle", 1.2, "Small jingle bells shaking.", ["toys", "jingle bells", "shake", "holiday", "sleigh"]],
  ]),
  ...sfx("Sports", [
    ["basketball-bounce", 1.5, "A basketball bouncing three times on a court.", ["sports", "basketball", "bounce", "court", "dribble"]],
    ["swish", 0.8, "A basketball swishing through a net.", ["sports", "basketball", "swish", "net", "score"]],
    ["golf", 0.8, "A golf club striking a ball cleanly.", ["sports", "golf", "swing", "strike", "club"]],
    ["tennis", 0.7, "A tennis racket hitting a ball.", ["sports", "tennis", "racket", "hit", "ball"]],
    ["baseball", 0.8, "A baseball bat cracking against a ball.", ["sports", "baseball", "bat", "crack", "hit"]],
    ["punch-bag", 0.8, "A fist hitting a heavy punching bag.", ["sports", "punching bag", "hit", "boxing", "gym"]],
    ["boxing-bell", 1.5, "A boxing ring bell ringing three times.", ["sports", "boxing", "bell", "ring", "round"]],
    ["whistle-start", 1, "A starting whistle blowing then a crowd murmur.", ["sports", "whistle", "start", "game", "kickoff"]],
    ["soccer-kick", 0.7, "A soccer ball being kicked hard.", ["sports", "soccer", "kick", "ball", "shot"]],
    ["sneaker-squeak", 1, "Basketball sneakers squeaking on a court.", ["sports", "sneakers", "squeak", "court", "basketball"]],
    ["weights", 1.2, "A barbell being set down on a rack with a clang.", ["sports", "weights", "barbell", "rack", "gym"]],
    ["swim-splash", 1.5, "A swimmer diving into a pool with a splash.", ["sports", "swim", "dive", "splash", "pool"]],
    ["skate-ice", 2, "Ice skates carving across a rink.", ["sports", "ice skating", "carve", "rink", "skate"]],
    ["crowd-chant", 3, "A stadium crowd chanting and clapping in rhythm.", ["sports", "crowd", "chant", "clap", "stadium"]],
  ]),
  ...sfx("Animals", [
    ["dog-bark", 1, "A dog barking twice.", ["animal", "dog", "bark", "woof", "pet"]],
    ["cat-meow", 1, "A cat meowing once.", ["animal", "cat", "meow", "pet", "kitten"]],
    ["bird-chirp", 2, "Small birds chirping cheerfully.", ["animal", "bird", "chirp", "tweet", "morning"]],
    ["rooster", 2, "A rooster crowing at dawn.", ["animal", "rooster", "crow", "dawn", "farm"]],
    ["cow", 1.5, "A cow mooing.", ["animal", "cow", "moo", "farm", "cattle"]],
    ["horse", 1.5, "A horse neighing and snorting.", ["animal", "horse", "neigh", "snort", "farm"]],
    ["crickets", 3, "Crickets chirping at night.", ["animal", "crickets", "chirp", "night", "awkward"]],
    ["owl", 1.5, "An owl hooting twice.", ["animal", "owl", "hoot", "night", "forest"]],
    ["lion", 2, "A lion roaring.", ["animal", "lion", "roar", "big cat", "wild"]],
    ["mosquito", 2, "A mosquito buzzing close to the ear.", ["animal", "mosquito", "buzz", "annoying", "insect"]],
    ["bee", 2, "A bee buzzing past.", ["animal", "bee", "buzz", "insect", "fly"]],
    ["elephant", 2, "An elephant trumpeting.", ["animal", "elephant", "trumpet", "wild", "loud"]],
    ["frog", 1.5, "A frog croaking twice.", ["animal", "frog", "croak", "pond", "ribbit"]],
    ["duck", 1.2, "A duck quacking three times.", ["animal", "duck", "quack", "pond", "bird"]],
    ["wolf", 3, "A wolf howling in the distance.", ["animal", "wolf", "howl", "distant", "night"]],
    ["seagull", 2, "Seagulls crying at the beach.", ["animal", "seagull", "cry", "beach", "bird"]],
    ["chicken", 1.5, "A chicken clucking.", ["animal", "chicken", "cluck", "farm", "hen"]],
    ["pig", 1.2, "A pig oinking twice.", ["animal", "pig", "oink", "farm", "snort"]],
    ["goat", 1.2, "A goat bleating loudly.", ["animal", "goat", "bleat", "farm", "scream"]],
    ["monkey", 2, "Monkeys chattering and screeching.", ["animal", "monkey", "chatter", "screech", "jungle"]],
    ["snake", 1.5, "A snake hissing.", ["animal", "snake", "hiss", "reptile", "danger"]],
    ["dog-growl", 1.5, "A dog growling low.", ["animal", "dog", "growl", "low", "warning"]],
    ["cat-purr", 3, "A cat purring softly.", ["animal", "cat", "purr", "soft", "content"]],
    ["eagle", 1.5, "An eagle screeching overhead.", ["animal", "eagle", "screech", "overhead", "bird of prey"]],
  ]),
  ...sfx("Ambience", [
    ["forest", 5, "A forest ambience with birds singing and leaves rustling, seamless.", ["ambience", "forest", "birds", "nature", "calm"]],
    ["ocean", 5, "Ocean waves rolling onto a beach, seamless.", ["ambience", "ocean", "waves", "beach", "calm"]],
    ["rain", 5, "Gentle rain falling steadily, seamless.", ["ambience", "rain", "gentle", "steady", "calm"]],
    ["wind", 5, "Wind blowing steadily across an open field, seamless.", ["ambience", "wind", "field", "steady", "open"]],
    ["night", 5, "A quiet night with crickets and a distant owl, seamless.", ["ambience", "night", "crickets", "quiet", "outdoor"]],
    ["city", 5, "A busy city street with traffic and distant horns, seamless.", ["ambience", "city", "traffic", "street", "urban"]],
    ["cafe", 5, "A cafe with quiet chatter and cups clinking, seamless.", ["ambience", "cafe", "chatter", "cups", "coffee shop"]],
    ["office", 5, "An office with keyboards typing and a quiet hum, seamless.", ["ambience", "office", "typing", "hum", "work"]],
    ["crowd-room", 5, "A room full of people talking, walla, seamless.", ["ambience", "crowd", "talking", "walla", "party"]],
    ["fireplace", 5, "A fireplace crackling softly, seamless.", ["ambience", "fireplace", "crackle", "cozy", "warm"]],
    ["space", 5, "A deep space drone, low and vast, seamless.", ["ambience", "space", "drone", "vast", "low"]],
    ["underwater", 5, "Muffled underwater ambience with slow bubbles, seamless.", ["ambience", "underwater", "muffled", "bubbles", "deep"]],
    ["highway", 5, "Cars passing on a highway at a distance, seamless.", ["ambience", "highway", "cars", "distant", "road"]],
    ["jungle", 5, "A jungle with insects buzzing and exotic birds, seamless.", ["ambience", "jungle", "insects", "birds", "tropical"]],
    ["snowstorm", 5, "A snowstorm with howling wind, seamless.", ["ambience", "snowstorm", "wind", "howl", "winter"]],
    ["stadium", 5, "A stadium crowd murmuring before a game, seamless.", ["ambience", "stadium", "crowd", "murmur", "sports"]],
    ["airport", 5, "An airport terminal with distant announcements and rolling luggage, seamless.", ["ambience", "airport", "terminal", "announcements", "travel"]],
    ["restaurant", 5, "A busy restaurant with chatter and cutlery, seamless.", ["ambience", "restaurant", "chatter", "cutlery", "dinner"]],
    ["server-room", 5, "A server room with fans whirring, seamless.", ["ambience", "server room", "fans", "hum", "tech"]],
    ["gym", 5, "A gym with weights clanking and treadmills, seamless.", ["ambience", "gym", "weights", "treadmill", "workout"]],
  ], loops),
  ...sfx("Musical", [
    ["guitar-strum", 1.5, "A single acoustic guitar strum, a bright open chord.", ["musical", "guitar", "strum", "acoustic", "chord"]],
    ["piano-chord", 2, "A single warm piano chord ringing out.", ["musical", "piano", "chord", "warm", "ring"]],
    ["ukulele", 1.5, "A cheerful ukulele strum, one bright chord.", ["musical", "ukulele", "strum", "cheerful", "chord"]],
    ["violin-sting", 1.5, "A short sharp violin sting, one accented note.", ["musical", "violin", "sting", "accent", "note"]],
    ["orchestral-swell", 3, "An orchestral swell rising and resolving, warm and full.", ["musical", "orchestra", "swell", "rise", "resolve"]],
    ["electric-guitar", 1.5, "A single distorted electric guitar power chord.", ["musical", "electric guitar", "power chord", "distorted", "rock"]],
    ["bass-slide", 1.2, "A bass guitar sliding down a note.", ["musical", "bass", "slide", "down", "groove"]],
    ["piano-glissando", 1.5, "A fast piano glissando sweeping up the keys.", ["musical", "piano", "glissando", "sweep", "up"]],
    ["trumpet", 1.2, "A single bright trumpet note.", ["musical", "trumpet", "note", "bright", "brass"]],
    ["synth-stab", 0.8, "A short punchy synth stab chord.", ["musical", "synth", "stab", "chord", "electronic"]],
    ["music-box", 3, "A music box playing a short gentle melody.", ["musical", "music box", "melody", "gentle", "lullaby"]],
    ["saxophone", 1.5, "A short smooth saxophone lick.", ["musical", "saxophone", "lick", "smooth", "jazz"]],
    ["flute", 1.5, "A short airy flute trill.", ["musical", "flute", "trill", "airy", "light"]],
    ["dj-scratch", 1, "A quick DJ turntable scratch.", ["musical", "dj", "scratch", "turntable", "hip hop"]],
    ["drum-machine-fill", 1.5, "A short electronic drum machine fill.", ["musical", "drum machine", "fill", "electronic", "beat"]],
    ["choir", 3, "A choir singing one sustained heavenly chord, ahh.", ["musical", "choir", "chord", "heavenly", "ahh"]],
  ]),
  ...sfx("Transitions", [
    ["film-roll", 1.5, "A film projector clicking and rolling to a start.", ["transition", "film", "projector", "roll", "vintage"]],
    ["slide", 0.8, "A slide projector advancing with a mechanical clunk.", ["transition", "slide projector", "clunk", "advance", "vintage"]],
    ["page-peel", 0.8, "A quick page peel swipe, a soft paper flick.", ["transition", "page peel", "swipe", "paper", "flick"]],
    ["shutter-roll", 1, "A rolling shutter sweep, a mechanical roll-through.", ["transition", "shutter", "roll", "sweep", "mechanical"]],
    ["swipe-left", 0.6, "A fast swipe transition, a short airy slide to the left.", ["transition", "swipe", "slide", "left", "fast"]],
    ["swipe-right", 0.6, "A fast swipe transition, a short airy slide to the right.", ["transition", "swipe", "slide", "right", "fast"]],
    ["static-cut", 0.6, "A short burst of static as a cut, a TV channel change.", ["transition", "static", "cut", "channel", "tv"]],
    ["tape-rewind", 1.2, "A quick tape rewind squeal as a transition.", ["transition", "rewind", "tape", "squeal", "back"]],
    ["light-sweep", 1.2, "A light sweep transition, a soft shimmering pass.", ["transition", "light", "sweep", "shimmer", "pass"]],
    ["cinematic-boom-whoosh", 1.5, "A cinematic transition, a whoosh into a deep boom impact.", ["transition", "whoosh", "boom", "impact", "cinematic"]],
    ["camera-roll", 1, "A camera rolling transition, a fast mechanical spin.", ["transition", "camera", "roll", "spin", "mechanical"]],
    ["blink", 0.6, "A blink transition, a soft quick shut and open.", ["transition", "blink", "eye", "shut", "open"]],
  ]),
  ...sfx("Retro", [
    ["vinyl-crackle", 4, "Vinyl record crackle and hiss, warm and steady, seamless.", ["retro", "vinyl", "crackle", "hiss", "warm"]],
    ["tape-hiss", 4, "Cassette tape hiss with a soft wow and flutter, seamless.", ["retro", "tape", "hiss", "cassette", "flutter"]],
    ["projector", 4, "A film projector running with a steady flicker, seamless.", ["retro", "projector", "film", "flicker", "run"]],
    ["tv-static", 4, "Old television static, steady, seamless.", ["retro", "tv", "static", "snow", "old"]],
    ["radio-tune", 2.5, "A radio dial tuning through stations with static.", ["retro", "radio", "tune", "dial", "static"]],
    ["cassette-insert", 1.2, "A cassette tape inserting and the deck clunking to play.", ["retro", "cassette", "insert", "clunk", "play"]],
    ["camcorder", 1, "A camcorder beeping and starting to record.", ["retro", "camcorder", "beep", "record", "vhs"]],
    ["polaroid", 1.5, "A polaroid camera clicking and ejecting a photo with a whir.", ["retro", "polaroid", "click", "eject", "photo"]],
    ["typewriter-bell", 0.8, "A typewriter carriage return bell dinging.", ["retro", "typewriter", "bell", "ding", "return"]],
    ["rotary-dial", 2, "A rotary phone dialing one number.", ["retro", "rotary", "phone", "dial", "vintage"]],
    ["film-burn", 1.5, "A film burn, a crackling flare as the film melts.", ["retro", "film burn", "crackle", "flare", "melt"]],
  ], loops),

  // What people download most from the sound library, checked against the
  // families above: cinematic openers and landings, soft whooshes, UI ticks,
  // heartbeats and drones, voices, footsteps, and long ambience beds.
  ...sfx("Cinematic", [
    ["whoosh-boom", 2, "A cinematic whoosh rushing in and landing on a deep boom impact with a short reverb tail.", ["cinematic", "whoosh", "boom", "impact", "transition"]],
    ["boom-whoosh", 2, "A deep cinematic boom that releases into a fast whoosh sweeping away.", ["cinematic", "boom", "whoosh", "release", "transition"]],
    ["high-boom-swoosh", 2, "A bright high-pitched cinematic boom with a swoosh, punchy and clean.", ["cinematic", "boom", "swoosh", "high", "bright"]],
    ["riser-hit", 4, "A tense cinematic riser building for three seconds into a massive boom impact with a long low tail.", ["cinematic", "riser", "hit", "boom", "trailer"]],
    ["hook-opener", 2, "A loud cinematic thump like a hand slamming a table, deep and dramatic, for the opening of a video.", ["cinematic", "thump", "opener", "hook", "intro"]],
    ["intro-metallic", 3, "A cinematic intro: a deep boom, a metallic hit, and a rising whoosh.", ["cinematic", "intro", "boom", "metallic", "whoosh"]],
    ["bass-whoosh-slow", 3, "A slow deep bass whoosh, low and heavy, sweeping past.", ["cinematic", "bass", "whoosh", "slow", "deep"]],
    ["doom", 3, "A single deep bass doom note, ominous and heavy, with a slow decay.", ["cinematic", "doom", "bass", "ominous", "suspense"]],
    ["sub-swell", 3, "A sub-bass swell rising and settling, low and cinematic, no impact.", ["cinematic", "sub", "swell", "bass", "rise"]],
    ["bass-drop-echo", 3, "A cinematic bass drop with a long echoing tail.", ["cinematic", "bass drop", "echo", "deep", "tail"]],
    ["flashback", 3, "A flashback transition: a deep emotional swell with a reversed piano and a soft whoosh.", ["cinematic", "flashback", "swell", "reverse", "memory"]],
    ["text-reveal", 1, "A short cinematic text reveal: a soft airy whoosh into a deep thud as the words land.", ["cinematic", "text", "reveal", "whoosh", "thud"]],
    ["logo-reveal", 3, "An epic cinematic logo reveal: a rising whoosh, a deep impact, and a bright shimmering tail.", ["cinematic", "logo", "reveal", "impact", "shimmer"]],
    ["logo-tech", 1.5, "A clean digital swoosh with a subtle bass thump, a tech logo scaling into place.", ["cinematic", "logo", "tech", "swoosh", "thump"]],
    ["punch-whoosh", 1.2, "A short cinematic punch: a rising reverse whoosh into a heavy hit.", ["cinematic", "punch", "whoosh", "hit", "reverse"]],
    ["emphasis-hit", 1, "A short punchy emphasis hit, clean and dramatic, for stressing a word.", ["cinematic", "emphasis", "hit", "punchy", "dramatic"]],
    ["superhero-landing", 2, "A superhero landing: a fast whoosh down into a heavy ground impact with rumbling debris.", ["cinematic", "landing", "impact", "hero", "ground"]],
    ["timelapse", 4, "A time-lapse acceleration: a wind whoosh building faster and faster, then cutting off.", ["cinematic", "timelapse", "acceleration", "whoosh", "speed"]],
    ["vacuum", 2, "A cinematic vacuum: air sucked inward into sudden silence with a deep bass drop-off.", ["cinematic", "vacuum", "suction", "silence", "drop"]],
    ["time-stop", 2, "A time-stop: an abrupt cutoff with a soft vacuum whoosh as everything freezes.", ["cinematic", "time stop", "freeze", "cutoff", "vacuum"]],
    ["reverse-riser", 2, "A short reverse riser, two seconds, starting high and sweeping down into a soft hit.", ["cinematic", "reverse", "riser", "sweep", "down"]],
    ["earthquake", 4, "A massive earthquake rumble with cracking stone and falling rock, deep sub-bass.", ["cinematic", "earthquake", "rumble", "stone", "sub"]],
    ["rubble", 3, "A stone structure cracking and crumbling, heavy fractures and falling debris, ominous.", ["cinematic", "rubble", "collapse", "stone", "debris"]],
    ["dynamite", 3, "A large booming dynamite explosion with dirt and rocks falling afterward.", ["cinematic", "explosion", "dynamite", "debris", "boom"]],
  ], core),
  ...sfx("Whoosh", [
    ["silk", 2, "A very soft, slow, airy whoosh, minimal, like silk moving through the air, no harsh rise.", ["whoosh", "soft", "silk", "airy", "slow"]],
    ["hand-wave", 0.8, "A quick airy whoosh of a hand waving past, light and clean.", ["whoosh", "hand", "wave", "quick", "light"]],
    ["leaves", 2, "A soft magical wind whoosh carrying dry leaves, a gentle gust with a subtle shimmer.", ["whoosh", "wind", "leaves", "gust", "magical"]],
    ["tonal", 1.5, "A tonal whoosh with a pitched sweep, clean and smooth.", ["whoosh", "tonal", "pitched", "sweep", "smooth"]],
    ["micro", 0.4, "A micro whoosh, a tiny quick air flick for a text pop.", ["whoosh", "micro", "tiny", "text", "flick"]],
    ["doppler", 2, "A dark low-pass whoosh passing from behind to the front with a gentle Doppler shift.", ["whoosh", "doppler", "pass", "dark", "reveal"]],
    ["slide", 1.5, "A soft whoosh like a slide, a gentle transition swipe.", ["whoosh", "slide", "soft", "swipe", "transition"]],
  ], core),
  ...sfx("UI", [
    ["text-pop", 0.4, "A soft subtle text reveal tick: a light pop with a whisper of air, one character landing.", ["ui", "text", "pop", "character", "subtle"]],
    ["bubble-appear", 0.6, "A speech bubble appearing: a soft snappy pop with a tiny rising blip.", ["ui", "bubble", "chat", "pop", "appear"]],
    ["success-sparkle", 1.2, "A short satisfying ding with a subtle magical sparkle glissando, positive.", ["ui", "success", "ding", "sparkle", "positive"]],
    ["correct-chime", 1, "A fast crisp two-note ascending chime for a correct answer, bright and delightful.", ["ui", "correct", "chime", "two-note", "answer"]],
    ["toggle-tactile", 0.4, "A soft plastic toggle switch click, a gentle tactile pop with a muted top end.", ["ui", "toggle", "switch", "tactile", "click"]],
    ["submit-click", 0.5, "A soft happy click of a submit button, rounded and cartoony, no high tones.", ["ui", "submit", "click", "happy", "button"]],
    ["popup", 1, "A clean UI popup: a soft whoosh in and a light settle click.", ["ui", "popup", "window", "whoosh", "settle"]],
    ["checkmark", 0.8, "A clean digital check mark: a short confirmation click with a soft success tone.", ["ui", "check", "confirm", "tick", "done"]],
    ["menu-blip", 0.4, "A clean modern menu select, a soft digital blip.", ["ui", "menu", "select", "blip", "digital"]],
  ], core),
  ...sfx("Riser", [
    ["elegant", 4, "An elegant riser, an airy whoosh with a subtle wine-glass resonance, ending clean and refined.", ["riser", "elegant", "glass", "airy", "refined"]],
    ["eight-second", 8, "A cinematic riser, eight seconds, starting subtle with airy textures and building to a peak.", ["riser", "long", "cinematic", "build", "peak"]],
    ["countdown-build", 5, "A countdown build-up with a constant rising tension and pulsing low hits speeding up.", ["riser", "countdown", "build", "pulse", "tension"]],
    ["sub", 3, "A dark sub-bass riser, ominous low drones rising into tension.", ["riser", "sub", "dark", "drone", "tension"]],
  ], core),
  ...sfx("Tension", [
    ["heartbeat-single", 1, "A single deep heartbeat thump, natural, with a soft chest resonance.", ["tension", "heartbeat", "single", "thump", "deep"]],
    ["heartbeat-echo", 3, "A slow cinematic heartbeat with a long echo, deep and heavy in a dark empty space.", ["tension", "heartbeat", "echo", "slow", "cinematic"]],
    ["heartbeat-racing", 3, "A fast panicking heartbeat, loud and heavy, thumping at a high rate.", ["tension", "heartbeat", "racing", "panic", "fast"]],
    ["heartbeat-808", 3, "A heartbeat crossed with an 808 bass, thumping and stylish.", ["tension", "heartbeat", "808", "bass", "beat"]],
    ["dark-drone", 6, "A deep cinematic bass drone, dark and atmospheric, rumbling with faint distortion.", ["tension", "drone", "dark", "bass", "rumble"]],
    ["mystery-intro", 6, "A dark cinematic mystery intro: a deep drone, a soft pulse, and a faint high shimmer.", ["tension", "mystery", "intro", "drone", "cinematic"]],
    ["whispers", 4, "Distorted whispers surrounding from all directions, faint and unsettling.", ["tension", "whispers", "horror", "creepy", "voices"]],
    ["eerie-wind", 5, "An eerie cold wind whistling through an empty house, hollow and unsettling.", ["tension", "wind", "eerie", "hollow", "horror"]],
    ["clock", 4, "Ticking clock elements over a low tense drone, slow-building suspense.", ["tension", "clock", "ticking", "drone", "suspense"]],
  ]),
  ...sfx("Magic", [
    ["dream", 3, "A soft whimsical transition into a daydream, a dreamy shimmer that floats upward.", ["magic", "dream", "daydream", "shimmer", "transition"]],
    ["particle-burst", 1.5, "A golden particle burst with bright crystal sparkles and a soft rising shimmer, dry.", ["magic", "particles", "burst", "sparkle", "gold"]],
    ["power-up", 2, "A magical energy power-up, sparkly rising tones, a recharge, health restored.", ["magic", "power up", "recharge", "sparkle", "heal"]],
    ["portal-ripple", 3, "A soft magical portal ripple, a soothing mystical aura with a gentle swirl.", ["magic", "portal", "ripple", "aura", "swirl"]],
    ["light-reveal", 2, "A glamorous magic-light reveal, a beam of sparkling stage light switching on.", ["magic", "light", "reveal", "beam", "sparkle"]],
    ["spell-charge", 3, "A magic spell building energy before release, swirling and rising into a punch.", ["magic", "spell", "charge", "build", "release"]],
    ["whoosh", 1.5, "A magic whoosh with sparkle, a swift enchanted sweep.", ["magic", "whoosh", "sparkle", "sweep", "enchanted"]],
    ["lights-on", 4, "A magical sparkle as strings of lights switch on, a soft airy whoosh rising into twinkles.", ["magic", "lights", "sparkle", "christmas", "twinkle"]],
  ]),
  ...sfx("Voices", [
    ["sigh", 1.5, "A man sighing sadly, one long tired exhale.", ["voice", "sigh", "sad", "tired", "exhale"]],
    ["gasp-woman", 1, "A woman gasping sharply in shock, a sudden intake of breath.", ["voice", "gasp", "woman", "shock", "surprise"]],
    ["gasp-man", 1, "A man gasping in surprise, a sharp intake of breath.", ["voice", "gasp", "man", "surprise", "breath"]],
    ["breath-tired", 3, "Male breathing, short controlled breaths with a few deeper tired exhales.", ["voice", "breath", "tired", "man", "exhale"]],
    ["breath-running", 3, "Heavy panicked breathing, a man running at full sprint, rapid gasps.", ["voice", "breath", "running", "panic", "gasp"]],
    ["breath-calm", 3, "A single deep inhale then a slow weighted exhale, grounded and calm.", ["voice", "breath", "calm", "inhale", "exhale"]],
    ["laugh-child", 2, "A young boy laughing, a happy gentle giggle, light and playful.", ["voice", "laugh", "child", "giggle", "boy"]],
    ["laugh-woman", 2, "A young woman laughing loudly and freely, playful and carefree.", ["voice", "laugh", "woman", "playful", "free"]],
    ["laugh-man", 2, "A man laughing naturally, warm and joyful.", ["voice", "laugh", "man", "warm", "joyful"]],
    ["kids-laughing", 3, "A group of children laughing and giggling together, bright and contagious.", ["voice", "laugh", "kids", "children", "giggle"]],
    ["chuckle", 1.5, "A quiet chuckle, a soft amused laugh under the breath.", ["voice", "chuckle", "quiet", "amused", "laugh"]],
    ["cry", 3, "A woman weeping softly with shaky breaths, quiet and heartbroken.", ["voice", "cry", "weep", "sad", "woman"]],
    ["scream-woman", 1.5, "A woman screaming in terror, short and piercing.", ["voice", "scream", "woman", "terror", "horror"]],
    ["scream-man", 1.5, "A man screaming in fear, short and raw.", ["voice", "scream", "man", "fear", "horror"]],
    ["hmm", 1, "A thoughtful hmm, a person considering something.", ["voice", "hmm", "thinking", "consider", "pause"]],
    ["yawn", 2, "A long sleepy yawn.", ["voice", "yawn", "sleepy", "tired", "bored"]],
    ["wake-gasp", 2, "A man suddenly waking with a sharp gasping breath and a frantic rustle.", ["voice", "wake", "gasp", "nightmare", "startle"]],
  ]),
  ...sfx("Buzzers", [
    ["censor-bleep", 0.8, "A censor bleep, a flat steady tone, clean and abrupt.", ["buzzer", "censor", "bleep", "beep", "swear"]],
  ]),
  ...sfx("Footsteps", [
    ["creaky-floor", 3, "Slow calm footsteps on an old creaky parquet floor, each board groaning softly.", ["footsteps", "creaky", "parquet", "floor", "slow"]],
    ["dress-shoes", 3, "Slow echoing footsteps of hard leather dress shoes on polished marble.", ["footsteps", "dress shoes", "marble", "echo", "leather"]],
    ["boots-concrete", 3, "Military boots walking on a concrete floor, firm and heavy.", ["footsteps", "boots", "concrete", "heavy", "military"]],
    ["barefoot", 3, "Heavy barefoot footsteps on dry dirt and gravel, soft slaps and scuffs.", ["footsteps", "barefoot", "dirt", "gravel", "slap"]],
    ["cobblestone", 3, "Rhythmic footsteps walking a narrow cobblestone street with a slight echo.", ["footsteps", "cobblestone", "street", "echo", "walk"]],
    ["puddles", 3, "Footsteps splashing through shallow rain puddles, one person walking slowly.", ["footsteps", "puddles", "splash", "rain", "wet"]],
    ["creaky-stairs", 3, "Slow heavy footsteps climbing an old creaky wooden staircase.", ["footsteps", "stairs", "creaky", "wood", "climb"]],
    ["sidewalk-group", 3, "Three people walking together on a city sidewalk, overlapping steps.", ["footsteps", "group", "sidewalk", "city", "walk"]],
  ]),
  ...sfx("Ambience", [
    ["thunderstorm", 6, "A thunderstorm: steady heavy rain with deep rolling thunder and occasional sharp cracks, seamless.", ["ambience", "thunderstorm", "rain", "thunder", "storm"]],
    ["rain-roof", 6, "Heavy rain falling on a wooden cabin roof at night, constant and close, seamless.", ["ambience", "rain", "roof", "cabin", "night"]],
    ["rain-window", 6, "Gentle rain on a window, soft taps and trickles down the glass, calm, seamless.", ["ambience", "rain", "window", "glass", "calm"]],
    ["rain-windshield", 6, "Rain on a car windshield with a distant rumble of thunder, seamless.", ["ambience", "rain", "car", "windshield", "thunder"]],
    ["beach", 6, "A beach, gentle waves rolling onto sand with seagulls calling in the distance, seamless.", ["ambience", "beach", "waves", "seagulls", "shore"]],
    ["ocean-storm", 6, "An ocean storm, roaring waves crashing with howling wind, seamless.", ["ambience", "ocean", "storm", "waves", "wind"]],
    ["mountain-river", 6, "A mountain valley at dawn, a small river flowing over rocks with sparse distant birds, seamless.", ["ambience", "mountain", "river", "valley", "dawn"]],
    ["mountain-wind", 6, "Strong cold wind blowing across an open rocky mountain landscape, wide, seamless.", ["ambience", "mountain", "wind", "cold", "summit"]],
    ["campfire", 6, "A campfire in a quiet forest at night, crackling and popping with faint crickets, seamless.", ["ambience", "campfire", "crackle", "night", "forest"]],
    ["snowy-forest", 6, "A peaceful snowy forest, light winter wind through tall pines, seamless.", ["ambience", "snow", "forest", "winter", "pines"]],
    ["desert-wind", 6, "Desert wind blowing steadily with occasional stronger gusts over rock, seamless.", ["ambience", "desert", "wind", "gust", "dry"]],
    ["park", 6, "A summer park, birds in the trees, light wind in leaves, distant children, seamless.", ["ambience", "park", "summer", "birds", "children"]],
    ["backyard", 6, "A quiet suburban backyard, light wind in grass, distant birds and a far lawn mower, seamless.", ["ambience", "backyard", "suburban", "quiet", "birds"]],
    ["room-tone", 6, "A quiet indoor room tone, soft air conditioning hum and faint household presence, seamless.", ["ambience", "room tone", "indoor", "quiet", "hum"]],
    ["office-empty", 6, "An empty office, ventilation hiss and a faint fluorescent light buzz, seamless.", ["ambience", "office", "empty", "hvac", "buzz"]],
    ["tavern", 6, "A cozy medieval tavern on a rainy night, murmuring patrons, clinking mugs and a fire, seamless.", ["ambience", "tavern", "medieval", "inn", "fantasy"]],
    ["call-center", 6, "A busy call center, many indistinct voices, constant keyboard clatter and phones, seamless.", ["ambience", "call center", "voices", "keyboard", "phones"]],
    ["city-night", 6, "Distant night-time city traffic heard from an upstairs room, muffled and calm, seamless.", ["ambience", "city", "night", "distant", "traffic"]],
    ["city-in-car", 6, "A busy city street heard from inside a parked car with the windows closed, muffled horns, seamless.", ["ambience", "city", "car", "muffled", "horns"]],
    ["haunted-house", 6, "A haunted house, faint floor creaks, distant wind and subtle whispers, seamless.", ["ambience", "haunted", "horror", "creaks", "whispers"]],
    ["cave", 6, "A deep echoing cave, dripping water and low rumbles of shifting stone, seamless.", ["ambience", "cave", "drip", "echo", "underground"]],
    ["kitchen", 6, "Cooking in a small kitchen, chopping on a wooden board, a pan sizzling, a tap running, seamless.", ["ambience", "kitchen", "cooking", "chop", "sizzle"]],
    ["classroom", 6, "A school classroom, quiet chatter, chairs scraping and pencils on paper, seamless.", ["ambience", "classroom", "school", "chatter", "pencils"]],
    ["hospital", 6, "A hospital corridor, soft monitor beeps, distant voices and a rolling cart, seamless.", ["ambience", "hospital", "corridor", "beeps", "medical"]],
    ["library", 6, "A quiet library, faint page turns, a distant cough and soft footsteps, seamless.", ["ambience", "library", "quiet", "pages", "study"]],
    ["factory", 6, "A factory floor, heavy machinery running with deep mechanical hums and hisses, seamless.", ["ambience", "factory", "industrial", "machinery", "hum"]],
    ["garden", 6, "An English garden, wind through flowers, a trickling stone fountain and morning birds, seamless.", ["ambience", "garden", "fountain", "birds", "flowers"]],
    ["spaceship", 6, "A spaceship interior, a low humming engine with soft ventilation and faint console beeps, seamless.", ["ambience", "spaceship", "engine", "hum", "sci-fi"]],
    ["savanna", 6, "A midday African savanna, faint cicadas, distant birds and dry wind through grass, seamless.", ["ambience", "savanna", "cicadas", "grass", "africa"]],
    ["blizzard-window", 6, "Soft winter wind howling outside a window with snow brushing the glass, cozy, seamless.", ["ambience", "blizzard", "window", "winter", "cozy"]],
  ], loops),
  ...sfx("Sci-Fi", [
    ["portal-jump", 3, "A sci-fi portal jump: a deep rumble growing, then a sudden whoosh through and a bright tail.", ["sci-fi", "portal", "jump", "whoosh", "rumble"]],
    ["hover-button", 0.8, "A premium sci-fi hover sound for a button, a soft glowing rise, short.", ["sci-fi", "hover", "button", "glow", "ui"]],
    ["ship-landing", 4, "A spacecraft rough landing, fluctuating thruster blasts settling to a heavy touchdown.", ["sci-fi", "spaceship", "landing", "thruster", "touchdown"]],
    ["hyperspace", 3, "A hyperspace jump, a rising charge and a stretching whoosh into a hum.", ["sci-fi", "hyperspace", "jump", "warp", "whoosh"]],
    ["energy-pulse", 4, "A pulsing energy atmosphere, a low sub-bass hum with digital streaks.", ["sci-fi", "energy", "pulse", "hum", "ai"]],
    ["glitch-whoosh", 1, "A digital glitch transition, a short cyber whoosh with stutters.", ["sci-fi", "glitch", "whoosh", "cyber", "transition"]],
    ["meteor", 3, "A fiery meteor streaking through the sky, an intense whoosh with a crackling fire trail.", ["sci-fi", "meteor", "whoosh", "fire", "sky"]],
    ["charge", 4, "An electric charge-up starting from silence: a faint static hum swelling over four seconds to a crackling peak, then a sharp cut.", ["sci-fi", "charge", "electric", "hum", "crackle"]],
  ]),
  ...sfx("Doors", [
    ["metal-door", 1.5, "A heavy metal door opening with a clank and a slow hinge groan.", ["door", "metal", "open", "clank", "hinge"]],
  ]),
  ...sfx("Animals", [
    ["dog-whine", 2, "A dog crying and whining, soft whimpers and a high-pitched howl.", ["animal", "dog", "whine", "whimper", "sad"]],
  ]),
  ...sfx("Tech", [
    ["ringback", 3, "A telephone ringback tone heard through the receiver after dialing, analog.", ["tech", "phone", "ringback", "dial", "call"]],
  ]),
  ...sfx("Time", [
    ["timer-5", 5, "A modern countdown timer, five seconds of soft rhythmic digital ticking speeding up into a final beep.", ["time", "countdown", "timer", "ticking", "beep"]],
  ]),
];

function makeClients(): { eleven: ElevenLabsClient; r2: S3Client } {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set (run from site/ so bun loads .env).");
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error("R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not set.");
  return {
    eleven: new ElevenLabsClient({ apiKey }),
    r2: new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

const keyFor = (name: string) => `${KEY_PREFIX}${name}.mp3`;
const cachePath = (name: string) => path.join(CACHE_DIR, `${name}.mp3`);
const fileUrl = (name: string) => `${CUT_MEDIA_ORIGIN}/${keyFor(name)}`;

/** Each sound's file name without its extension: the id for a first render,
 * `<id>.r<n>` once it has been rendered again. The shipped manifest says which
 * file a sound currently has; a redo takes the next free number. */
const names = new Map<string, string>();
const fileName = (c: CatalogItem) => names.get(c.id) ?? c.id;
const shippedName = (id: string): string | undefined => {
  const file = STOCK_SFX.find((s) => s.id === id)?.file;
  return file?.slice(file.lastIndexOf("/") + 1).replace(/\.mp3$/, "");
};
async function inBucket(r2: S3Client, name: string): Promise<boolean> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: keyFor(name) }));
    return true;
  } catch {
    return false;
  }
}
async function nextName(r2: S3Client, id: string): Promise<string> {
  for (let n = 2; ; n++) {
    const name = `${id}.r${n}`;
    if (!existsSync(cachePath(name)) && !(await inBucket(r2, name))) return name;
  }
}

/** Renders one take and resolves to its mp3 bytes plus what it cost. */
async function generateOne(
  eleven: ElevenLabsClient,
  item: CatalogItem
): Promise<{ mp3: Buffer; credits: number }> {
  const { data, rawResponse } = await eleven.textToSoundEffects
    .convert({
      text: item.prompt,
      modelId: MODEL,
      durationSeconds: Math.max(MIN_REQUEST_SECONDS, item.seconds),
      promptInfluence: PROMPT_INFLUENCE,
      loop: item.loop === true,
      outputFormat: "mp3_44100_128",
    })
    .withRawResponse();
  const mp3 = Buffer.from(await new Response(data).arrayBuffer());
  const credits = Number.parseInt(rawResponse.headers.get("character-cost") ?? "", 10);
  return { mp3, credits: Number.isFinite(credits) ? credits : 0 };
}

function run(cmd: string, args: string[]): string {
  const proc = spawnSync(cmd, args, { maxBuffer: 256 * 1024 * 1024 });
  if (proc.status !== 0) throw new Error(`${cmd} failed: ${proc.stderr?.toString().trim()}`);
  return proc.stdout?.toString() ?? "";
}

/** Cut the silence off both ends and bring the loudest sample to PEAK_DB, so a
 * one-shot starts the instant it lands on the timeline and every card plays at
 * the same level. A loop keeps its ends — trimming would break the seam. */
async function finish(item: CatalogItem, raw: Buffer): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const rawPath = path.join(CACHE_DIR, `${fileName(item)}.raw.mp3`);
  await writeFile(rawPath, raw);
  const trim = item.loop
    ? "anull"
    : `silenceremove=start_periods=1:start_threshold=${HEAD_SILENCE_DB}dB:start_silence=0.02,` +
      `areverse,silenceremove=start_periods=1:start_threshold=${TAIL_SILENCE_DB}dB:start_silence=${TAIL_KEEP_S},areverse`;
  const render = (filter: string) => {
    const peak = spawnSync("ffmpeg", ["-v", "info", "-i", rawPath, "-af", `${filter},volumedetect`, "-f", "null", "-"])
      .stderr?.toString()
      .match(/max_volume:\s*(-?[\d.]+) dB/);
    const gain = peak ? PEAK_DB - Number.parseFloat(peak[1]) : 0;
    run("ffmpeg", ["-v", "error", "-y", "-i", rawPath, "-af", `${filter},volume=${gain.toFixed(2)}dB`, "-codec:a", "libmp3lame", "-q:a", "2", cachePath(fileName(item))]);
  };
  render(trim);
  // A take that is one sharp transient can trim down to nothing; it keeps its
  // silence rather than vanishing.
  if (!readable(fileName(item))) render("anull");
  await unlink(rawPath);
  // A one-shot that never drops below half its peak is a wall of noise, a
  // take the model gave up on; throwing sends it back for another attempt.
  if (!item.loop) {
    const peaks = computePeaks(fileName(item));
    const loud = peaks.filter((p) => p > 0.5).length / peaks.length;
    if (loud > NOISE_WALL_SHARE) {
      await unlink(cachePath(fileName(item)));
      throw new Error(`take is a wall of noise (${Math.round(loud * 100)}% of it near peak)`);
    }
  }
}

/** Whether ffprobe can read a finished file as audio with some length. */
function readable(name: string): boolean {
  const proc = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", cachePath(name)]);
  const sec = Number.parseFloat(proc.stdout?.toString().trim() ?? "");
  return proc.status === 0 && Number.isFinite(sec) && sec > 0.05;
}

/** The finished mp3's real length via ffprobe. */
function probeDuration(name: string): number {
  const sec = Number.parseFloat(
    run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", cachePath(name)]).trim()
  );
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(`ffprobe could not read ${name}.mp3's duration`);
  return Math.round(sec * 100) / 100;
}

/** Normalized 0..1 waveform peaks for the card: decode to mono PCM, take the
 * max magnitude per bucket, scale so the loudest bar fills. */
function computePeaks(name: string): number[] {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", cachePath(name), "-f", "s16le", "-ac", "1", "-ar", "8000", "-"],
    { maxBuffer: 256 * 1024 * 1024 }
  );
  const buf = proc.stdout;
  if (proc.status !== 0 || !buf || buf.length < 2) throw new Error(`ffmpeg could not decode ${name}.mp3`);
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const bucket = Math.max(1, Math.floor(samples.length / PEAKS));
  const raw: number[] = [];
  for (let i = 0; i < PEAKS; i++) {
    let m = 0;
    for (let j = i * bucket; j < Math.min(samples.length, (i + 1) * bucket); j++) {
      const a = Math.abs(samples[j]);
      if (a > m) m = a;
    }
    raw.push(m / 32768);
  }
  const max = Math.max(...raw, 0.0001);
  return raw.map((p) => Math.round((p / max) * 100) / 100);
}

async function upload(r2: S3Client, name: string): Promise<void> {
  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: keyFor(name),
      Body: await readFile(cachePath(name)),
      ContentType: "audio/mpeg",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
}

/** True when the bucket already holds this file; pulls it into the cache when
 * the local copy is missing so its peaks can be read. */
async function adopt(r2: S3Client, name: string): Promise<boolean> {
  if (existsSync(cachePath(name))) {
    if (readable(name)) return true;
    // A broken local file (a render cut short) is not a finished sound.
    await unlink(cachePath(name));
  }
  if (!(await inBucket(r2, name))) return false;
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(name) }));
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) return false;
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath(name), Buffer.from(bytes));
  if (readable(name)) return true;
  await unlink(cachePath(name));
  return false;
}

type Result = { duration: number; peaks: number[] };

async function writeManifest(results: Map<string, Result>) {
  const entries = CATALOG.filter((c) => results.has(c.id)).map((c) => ({
    id: c.id,
    category: c.category,
    prompt: c.prompt,
    tags: c.tags,
    file: fileUrl(fileName(c)),
    duration: results.get(c.id)!.duration,
    peaks: results.get(c.id)!.peaks,
    ...(c.loop ? { loop: true } : {}),
  }));
  // One entry per line: hundreds of rows with their peaks spelled out one
  // number per line would be a file nobody can scroll.
  const body = `// Generated by scripts/generate-stock-sfx.ts — do not edit by hand.
import type { StockSfx } from "./stock";

export const STOCK_SFX: StockSfx[] = [
${entries.map((e) => `  ${JSON.stringify(e)},`).join("\n")}
];
`;
  await writeFile(MANIFEST, body);
}

async function main() {
  const ids = new Set<string>();
  for (const c of CATALOG) {
    if (ids.has(c.id)) throw new Error(`duplicate catalog id ${c.id}`);
    ids.add(c.id);
  }
  const redo = new Set(process.argv.slice(2));
  for (const id of redo) if (!ids.has(id)) throw new Error(`${id} is not a catalog id`);
  const { eleven, r2 } = makeClients();
  const results = new Map<string, Result>();
  for (const c of CATALOG) {
    if (redo.has(c.id)) {
      names.set(c.id, await nextName(r2, c.id));
      continue;
    }
    const shipped = shippedName(c.id);
    if (shipped) names.set(c.id, shipped);
    const name = fileName(c);
    if (await adopt(r2, name)) results.set(c.id, { duration: probeDuration(name), peaks: computePeaks(name) });
  }
  const todo = CATALOG.filter((c) => !results.has(c.id));
  console.log(`model=${MODEL} existing=${results.size} generating=${todo.length}`);

  let failed = 0;
  let spent = 0;
  let stopped = false;
  const queue = [...todo];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (stopped) return;
      for (let attempt = 1; ; attempt++) {
        try {
          const { mp3, credits } = await generateOne(eleven, item);
          spent += credits;
          await finish(item, mp3);
          results.set(item.id, { duration: probeDuration(fileName(item)), peaks: computePeaks(fileName(item)) });
          await upload(r2, fileName(item));
          await writeManifest(results);
          console.log(`✓ ${item.id} (${results.get(item.id)!.duration}s, ${credits} credits, ${spent} total)`);
          if (spent >= MAX_CREDITS) {
            stopped = true;
            console.error(`credit cap reached at ${spent}; stopping`);
          }
          break;
        } catch (e) {
          if (attempt >= 3) {
            failed++;
            console.error(`✗ ${item.id}: ${e instanceof Error ? e.message : e}`);
            break;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await writeManifest(results);
  console.log(`done: ${results.size} sounds, ${failed} failed, ${spent} credits spent`);
  if (failed) process.exit(1);
}

await main();
