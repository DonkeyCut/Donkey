# Performance

Donkey Cut has to feel instant on the laptops people edit on. The editor lives in one
browser tab, and that tab has one main thread: it runs our scripts, lays out the page, and
paints every frame. When that thread is busy, the picture freezes, the playhead sticks,
and a click waits. Every feature we ship is judged first by what it costs that thread and
the machine's memory, and only then by what it adds.

**The one rule:** work scales with what is on screen and what the person is doing, never
with the size of the project. If you are tempted to loop over every clip on every frame,
or decode a file nobody is looking at, that work belongs behind the visible part or
nowhere at all.

## Local first, upload behind

Files stay local first. The editor works from the local copy while uploads happen in
the background. On Mac, heavy jobs run on the machine. The network never gets between
an action and its result.

## The frame budget

The browser draws a frame only between our tasks. At 60Hz a frame has about 10ms for our
code; at 120Hz, about 5ms. A task that runs longer than that skips frames, and one that
runs past 50ms is a long task the browser reports as a stall.

The code that stalls is rarely slow on its own. It is whatever happens to be holding the
thread when a frame was due. So the questions to ask of any change are the same two: how
long does this hold the thread at once, and how often.

The model for this section, and for the split, batch, defer and move techniques below, is
[The Expensive Main Thread](https://kciter.so/posts/the-expensive-main-thread/en/).

## Techniques

We keep the thread clear four ways, in the order to reach for them.

| Technique | What it means | Where Cut does it |
| --- | --- | --- |
| Remove | Do not do the work at all: cache the answer, draw only what shows, skip what nothing reads | The preview answers every frame from a ring of already-decoded frames; the timeline draws the visible span; a background tab lets its decoders go |
| Move | Take it off the main thread: the compositor for motion, the GPU for pixels, a hidden or headless surface for whole jobs | The skim line moves by a transform on its own compositor layer; grades and masks run as GPU passes; rendering and transcription go to the engine or the cloud worker |
| Defer | Do it later, when the thread is quiet | Waveforms, filmstrips and scene probes wait for play to stop; the perf log reaches storage at idle |
| Split and batch | Break a long job into steps that yield between frames, and fold bursts of events into one run | Cutout bakes run in bounded chunks; drag and scroll handlers coalesce into the next animation frame; saves and search debounce |

**Remove first.** A cache that answers in memory beats any amount of scheduling. The
preview is the model: playing walks each file forward and keeps frames ahead of the
playhead, so drawing is a lookup and never a wait. If the exact frame is not there yet,
the nearest decoded one goes up. A held frame is worth more than a stall.

**Then move.** Anything that animates every frame moves by CSS transform so the
compositor carries it while the thread is busy. Anything that touches many pixels runs on
the GPU. Anything that is a whole job, like an export, leaves the tab.

**Then defer.** A play is the urgent read. Everything that opens the same file for
another reason takes what the picture needs, so it waits until the play stops and picks up
where it was.

**Split last.** Yielding has a cost of its own, and some work cannot be cut, so split
only what remains after the three above. Yield by time against the frame budget, and
never so finely that the switching costs more than the work.

## A preview is the thing itself

The drag preview uses the same renderer and caches as the clip itself. It updates
instantly, once per frame, without recalculating the layout. Moving it just transforms
the box—the preview stays in sync with the source.

## Rules

1. **One animation frame per tick.** The frame loop books exactly one request per tick
   and everything that draws hangs off it. A second loop doubles the work and fights the
   first for the same frame.
2. **Nothing synchronous in a hot path.** No decode, no layout read, no storage call
   inside the frame loop, a pointer handler, or a scroll handler. Read layout once, before
   the loop starts.
3. **No allocation per frame.** Rings, buffers and canvases are made once and reused. A
   fresh canvas per reopen floods the GPU process until frames stop arriving.
4. **Every cache is bounded in bytes.** A cache registers what it holds with the memory
   budget and asks what it may hold. The answer is the smaller of its tuned size and its
   share of a quarter of the machine's memory, so on a small machine every cache sheds
   together and no one subsystem eats the room the others needed.
5. **Whoever opens it closes it.** A reader, a decoder, or a canvas is released by the
   code that created it. Leaving the pool is suspension before closure: an idle source
   drops its decoder but keeps its parsed file and canvases, so waking it costs one
   keyframe seek.
6. **Read the file once.** Forty segments of one recording share one parsed file and one
   reader cache. Sound, filmstrip and preview all join that same open file.
7. **Measure before you ship.** A change to the preview, the timeline, or the frame loop
   runs the perf evals, and the summary says what moved.

## Memory

The memory that runs a machine out is memory the page cannot see: decoded frames inside
the platform decoder, canvas backing in the GPU process. The browser reports the size of
neither. So the accounting happens at the allocation sites, where the sizes are known
exactly, and one place adds them up.

| Bucket | Holds |
| --- | --- |
| decoders | Frames inside the platform decoder |
| canvases | Frame rings and the warm shelf of stood-down sources |
| reads | File bytes held by open readers |
| audio | Decoded sound waiting to be scheduled |
| pictures | Element bitmaps, thumbnails, mattes |

The ceiling is a quarter of what the browser reports the machine has. Past that the
machine swaps, and a swapping machine previews worse than one decoding at half the size.

## Measuring

Nothing about a stutter can be settled by watching. Two things settle it with numbers.

**The frame trace** records when a time was asked for and when a frame for it reached
the screen. It is off until armed. On a machine we cannot reproduce, a person opens the
console and runs:

```js
__cutPerf.start()   // play the part that stutters
__cutPerf.report()  // a summary small enough to paste into a bug report
```

**The perf evals** open a real browser on a fixture project, drive it, and read that
trace. They count in frames, so a report reads the same on a 60Hz and a 120Hz display,
and they run under machine profiles that throttle the CPU and the network.

```sh
npm run eval:cut-perf            # every case, this machine
npm run eval:cut-perf-lowend     # playback cases, throttled to a cheap laptop
```

A nightly run gates the scrub cases on a CI machine profile.

Every editor session also meters its own main thread. A frame over a second, or a half
minute mostly blocked, marks the session as trouble and the frames leading up to it are
sent to analytics with the script that held the thread and the control that was pressed.
A small random share of sessions send regardless, as the baseline trouble is measured
against.

## Where it lives

The frame loop and decoders live in the preview's frame source and playback hook, the
memory budget in its own module beside them, the trace and meter in the perf trace and
perf log modules, and the evals in the site's scripts folder.
