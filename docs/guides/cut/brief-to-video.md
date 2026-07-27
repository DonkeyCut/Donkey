# Brief to Video

The brief-to-video pipeline is Cut's director: one request ("make me a video
about…") becomes a finished cut — script, narration, reference images, shots —
assembled on the timeline, with subtitles and any other post step one
assistant tool call away. The target: one prompt becomes a coherent short
film with a consistent cast — harness capability first, model quality
improves on its own schedule.

**The one rule: the plan is the product.** Every generation call executes a
persisted, user-approved plan — never a fresh improvisation. If a shot renders
wrong, fix the plan (its description, its references, its framing) and
regenerate that shot; if you're tempted to slip an extra instruction into one
render call, that knowledge belongs in the plan so every later regeneration
keeps it. Revisions scale with their scope: a bad take regenerates one shot, a
section that needs a different cut replans just that span (same audio, same
bible — the span can become more shots or fewer, and only those render), and a
look change rebuilds the bible and re-renders everything. A finished scene is
never replanned from scratch to change part of it.

## How it works

```
brief
  │  script — beats with arc, camera framing, dialogue
  ▼
shot plan — the script cut into shots (user approves before money is spent)
  ▼
style bible — one look + a sheet per character and location
  │  (reference images minted once, from the user's references)
  ▼
keyframes — each shot's opening frame, rendered from the sheets
  ▼
shots — video seeded from the keyframe, laddered down on failure; the
  │      model speaks the shot's line, so its audio is the narration
  ▼
timeline — each clip trimmed to its slice, playing its own narration, a
            music bed underneath
```

The written plan decides *what* every shot is; the render steps decide only
*how well* it lands.

## Story planning

The script role writes cinema, not a list of captions. Its beats carry a story
arc (establish, turn, payoff), real camera language varied shot to shot (wide
establishing, close-up, insert of a telling detail, POV, follow shot), and the
wardrobe and props the story repeats — named in every beat they appear in, so
shots rendered independently still match. A character can be introduced late
(the reveal) but holds one stable id from its first beat.

The grammar is genre-neutral: the same planner writes a travel vlog, a product
ad, a nature documentary, a stop-motion short, or an explainer that turns the
model's own knowledge into narrated teaching beats. Text the viewer must read
is the one exception — video models garble lettering, so the plan keeps
on-screen text to a word or two and the information rides the narration;
exact wording belongs in title and subtitle overlays after assembly.

## Visual consistency

Identity lives in images first. Text describes what happens in a shot; what
people and places *look like* rides as reference media, and any render an
image can't ride carries that sheet's written description in its prompt
instead — the same fixed words every shot:

1. **Sheets first.** Each character and location gets one canonical reference
   image, designed once from the style bible and the user's references. The
   sheet fixes face, wardrobe, and carried props.
2. **Keyframes from sheets.** Each shot's opening frame is rendered as an
   image with the sheets as identity anchors — image models hold identity far
   better than video models.
3. **The identity ladder.** Each shot renders from its strongest available
   anchor and falls one rung on failure: keyframe as the literal first frame →
   reference-conditioned video from the sheets → text-only, where the cast's
   full written descriptions ride the prompt and identity drifts the most.

The project's frame is the user's setting. A run reads it when the plan is
approved and never changes it — a reference in another shape or a platform the
brief names is something to mention, not a reason to reframe someone's project.

## Where it's going

Audio follows the same principles later: wall-to-wall narration generalizes to
a music-driven cut with sparse on-screen caption beats instead, and pacing cut
to the beat. Longer arcs (multi-scene episodes) are
the same plan data at larger scale — the sheets are what make a cast hold for
thirty minutes, so they, not the shots, are the durable asset. The assistant
already controls the whole editor and the bundled ffmpeg, so every post step —
trims, transitions, titles, subtitles, export — is available to the same agent
that planned the story.

## Where it lives

The orchestrator, plan types, and coverage invariant live in the site's Cut
genvideo area; its planning and media roles are the hosted-model adapters
beside it, and the chat tool that drives it is generate_scene. The assistant's
steering for scene runs — references and look, aspect, the from-audio flow —
is the chat skills library's scene-productions doc.
