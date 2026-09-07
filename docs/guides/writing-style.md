# Writing Style

How everything from Donkey reads: docs, guides, blog posts and articles, landing
page and marketing copy, release notes, emails, UI copy, commit messages, and
what the assistant says in chat. One voice everywhere.

**The one rule:** write like a thoughtful engineer explaining something they
learned while building real software, to a peer, out loud. Calm, curious,
precise, and simple without being dumbed down.

## The Voice

The reader is a smart person who was not in the room. The writing brings them
into the room. It walks them from the problem to the model to the answer, so
that by the end they understand *why* the system behaves the way it does, and
could rederive the answer themselves.

That shape holds whether the piece is a two-thousand-word article or a
one-line tooltip. The article walks the whole path. The tooltip says the one
true thing the path ends at.

- **Conversational and calm.** Plain words, first person where it fits, no
  drama. The tone of someone who has already solved it and is now thinking it
  through for you.
- **Technically precise.** Every claim is one you could check. Name the actual
  mechanism. If the number matters, give the number.
- **Curious over authoritative.** "Here is what I noticed, here is why I think
  it happens, here is what that implies." Reasoning in the open. The reader
  gets to disagree with a step.
- **Why before what.** A rule without its reason gets misapplied the first time
  the situation shifts. Explain the reason and the rule follows.
- **Concrete.** A real problem, a real example, a small piece of code where it
  helps. One specific case beats three general statements.

## The Shape of a Piece

Start with a real problem or observation. Something that happened, something
that was surprising, a question a colleague asked. The first sentence already
has content in it.

Build a mental model from first principles. What are the parts, what does each
one know, what constraint is each one under. Keep it small. A model with three
moving pieces that the reader can hold in their head beats a complete one they
cannot.

Use the model to explain the solution. The fix should feel inevitable once the
model is in place. If it does not, the model is missing a piece.

Say what the tradeoffs are. What the solution gives up, when it stops being the
right call, what you would watch for. This is where the reader learns to trust
you.

Stop when the content stops. No wrap-up paragraph, no restated conclusion, no
offer of more.

```text
observation  →  model  →  solution  →  tradeoffs  →  stop
```

## Sentences

- Short sentences carry rules. Longer ones carry the why. A sentence past
  twenty words is usually two.
- Active voice with a named actor. "The engine watches the parent process"
  beats "the parent process is watched."
- State what a thing is, then stop. Never frame it against what it is not. Cut
  every "X, not Y", "X rather than Y", "X instead of Z". If the reader would
  not have assumed Y, naming Y teaches them a wrong idea on the way to the
  right one.
- Say it straight, with the strong verb. "Adapters never hold task state"
  beats "adapters should generally avoid holding task state."
- Prose is the default. Headings and bullets appear when the content really is
  a list or really does change subject. A run of three bullets that could be
  one paragraph is one paragraph.
- Code font only for what someone will type or read in a file. Describe tools,
  types, and paths in words.

## Cut

- Marketing language. "Powerful", "seamless", "blazing fast", "effortless",
  "delightful". If the thing is fast, say how fast and why.
- Generic openings. "In this article we will", "in today's world", "have you
  ever wondered". The first sentence has content in it.
- Announcements of what the writing is about to do. "Let's dive in", "let's
  break this down", "now let's look at".
- Filler that signals insight. "Worth noting", "it's important to understand",
  "the key takeaway is", "at the end of the day". If it matters, say it. If it
  does not, cut it.
- Repetitive summaries. A closing paragraph that restates the piece. A
  "conclusion" heading. A "TL;DR" for something the intro already led with.
- Jargon that plain words cover. Coined names, internal acronyms, and file
  paths go stale and read as noise.
- Hedges on things you know. "Might", "could potentially", "in some cases" when
  it is simply true.
- Corporate polish. Every sentence the same length, every paragraph three
  sentences, every idea in a bullet. Let it breathe unevenly, like a person.
- Rhetorical questions the next sentence answers. Ask the question because you
  do not know, or state the answer.

## Where It Applies

| Surface | What it looks like |
| --- | --- |
| Articles and blog posts | The full path: observation, model, solution, tradeoffs. Small code where it helps. |
| Engineering docs and guides | Same voice, with the structure in the [Engineering Doc Style Guide](eng-doc-style.md): lead with the point, name the invariants, facts in tables. |
| Landing page and marketing | The problem in the reader's words, then what Donkey does about it, in the same calm voice. No superlatives. The proof is the specific. |
| Release notes and emails | What changed and why someone would care, in one or two plain sentences each. |
| UI copy and tooltips | The one true thing, in the fewest plain words. |
| Commit messages and code comments | What the change does and why, as a peer would explain it in review. |
| The assistant in chat | Recommendation first, then the why. Same calm, same precision. |

## Before You Ship It

1. Does the first sentence have something in it?
2. Could the reader explain *why* it works, without you there?
3. Is there a sentence a marketing team would have written? Cut it.
4. Does it stop when the content stops?
