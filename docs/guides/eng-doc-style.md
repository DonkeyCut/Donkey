# Engineering Doc Style Guide

How to write the docs in this repo: architecture notes, runtime specs,
contributor guides — anything a teammate or a coding agent reads once and then
has to follow. Lead with the point, keep it short, and write like a person.

## Principles

**Lead with the point.** The first paragraph says what the thing is and why it
exists, in plain words — no throat-clearing, no history. If it has a job, sum it
up in one sentence before any mechanism. If it has one governing rule, state it
right after and label it (`**The one rule:**`). A reader who stops after the
intro should still get the important things right.

**Say each thing once.** One explanation per idea, where people will look for
it. Everywhere else, point back ("see the loop above"). If the same idea shows
up twice, pick its home and cut the other.

**Let diagrams carry the flow.** A loop, pipeline, or lifecycle gets one ASCII
diagram. Keep a linear flow as a single vertical column — one step per line, an
arrow down to the next — and only branch when the flow really branches. The
prose says *why*; it doesn't re-narrate the steps.

**Name the division of labor in one line.** When two parts share the work,
contrast them: "the model decides *what*; the runtime decides *whether and
how*." If that's the only sentence a reader remembers, they should still make
the right call.

**Facts go in tables, reasoning stays in prose.** Anything you look up — states
and outcomes, risk tiers, file types — belongs in a table. Save prose for the
why.

**Pull invariants out as named rules.** Don't bury a constraint in a paragraph.
Give it a bold name and a consequence:

> 1. **Every input is guarded.** …
> 2. **Done means evidence.** …

The name becomes the words people use in review.

**Show the violation.** One bad example teaches faster than a paragraph: "if
you're tempted to write `if command.contains(\"music\")`, that logic belongs in
a skill."

**Be concrete, in plain words.** "The model proposes a name and a guarded
command applies it" beats "the generator emits a candidate the executor
commits." Say what happens — don't reach for internal tool names, types, or
file paths, which read as jargon and go stale.

**Give ideas room to breathe.** One point per paragraph. Break a dense block
into short ones with space between, so a reader can scan.

## Sentences

- **State what a thing is, then stop.** Never frame it against what it is not.
  Cut every "X, not Y", "X rather than Y", "X instead of Z", and "*not* the
  other thing" aside. If a reader would not have assumed Y, naming Y teaches
  them a wrong idea on the way to the right one. This holds everywhere prose
  goes: guides, code comments, commit messages, tooltips, and UI copy.
  - Write: the safety class decides whether the action stops.
  - Cut: the class, *not the tool's name*, decides.
  - Write: the preset plays on top of any keyframes.
  - Cut: the preset plays on top of keyframes rather than replacing them.
- Say it straight, with the strong verb.
  - Write: adapters never hold task state.
  - Cut: adapters should generally avoid holding task state.
- Short sentences for rules, longer ones for the why. A rule over ~20 words is
  probably two.
- Active voice, named actor.
  - Write: the planner picks the tool.
  - Cut: the tool is selected.
- Bold only for rule names. If half the paragraph is bold, none of it is.
- Italics only for word-level contrast (*what* vs *whether*).
- Code font only for what someone will actually type — a real command or flag.
  Tool names, types, and paths get described in prose.

## Shape of a Doc

```text
# Title

What it is + why it exists (2–4 sentences).
**The one rule:** the governing constraint, with a bad example.

## How it works   — the diagram + the division-of-labor line
## [The nouns]    — one section per concept (state, boundaries, tools)
## [Constraints]  — invariants as named rules, lookups as tables
## Where it lives — one sentence pointing at the code
```

Name sections after nouns ("Task State"), not gerunds ("Managing Task State").
Order them by what a new reader needs first. End by pointing at the code in one
sentence — name the area, skip the paths and class names; they churn and people
can grep.

## Cut

- Restatements ("as mentioned above," "in other words")
- Adjectives that change nothing ("robust," "powerful," "seamless")
- Caveats for situations no reader is in
- Talk about the doc itself ("this section describes…")
- Anything the table header already says
- Jargon when plain English works — internal names, paths, and coined terms go
  stale; describe what the thing does
- Churning catalogs — no source-map tables, file lists, or line numbers; one
  sentence pointing at the area is enough

## Before You Ship It

1. Could a reader stop after the intro and still avoid the worst mistakes?
2. Is anything explained twice?
3. Could someone follow this without asking you a question?

If any answer is no, the rule is buried, doubled, or hedged — fix that.
