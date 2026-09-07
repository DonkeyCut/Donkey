# Donkey Cut

Donkey Cut is a free video editor that runs in the browser at `donkeycut.com`. The page is the whole editor: it decodes, draws, and mixes the cut, runs the assistant, and renders the export. Code and paths use the shorter name `cut`.

**The one rule:** the engine's routes run only on the user's Mac. On a hosted deploy every one of them answers 404 before a handler runs, so nothing the engine does can execute off-Mac and the engine never reaches Donkey's production models. Never wrap an engine route in the Donkey auth helper, read Prisma from it, or bill it against credits.

## How it works

A project lives in one of three homes, chosen when it is created.

```text
                    the page (the editor)
                             |
        +--------------------+--------------------+
        |                    |                    |
   browser project      Mac project         cloud project
   origin-private      engine in the        Postgres doc,
   storage in the      Donkey Mac app       media in R2
   page                (local disk, ffmpeg,
                       on-device speech)
```

The user sees two places, Local and Cloud. Local is the Mac's engine once the app has connected and the browser's own storage otherwise, so a fully local project needs nothing installed. A project lives in exactly one home and the surfaces never proxy to each other.

AI is hosted whatever the home: image, video, and voiceover generation and the assistant's Gemini models run through Donkey's authenticated inference routes against the user's credits, and the results land in the project like any other file. The cloud's routes are the engine's hosted twin, same shapes with session auth and credit metering.

## The preview

The preview scrubs and plays from per-clip decoders held in memory. It shows a frame the moment it arrives and refines behind it, so the timeline always answers and a jump lands on a picture. Every cache is bounded by one memory budget sized to the machine. The performance guide holds the frame budget and how a change is measured.

## The export

An export is the preview drawn again frame by frame into an MP4 by the same compositor and mixer, so the file matches what the person saw. The finished file goes to the project's home: the app's project folder for a Mac project, storage for a cloud one, the page's store for a browser one. A browser that cannot carry the render hands it to the machine behind the project, and the ffmpeg pipeline stays for ProRes, headless renders, share cards, and streaming ladders. The local-compute guide covers where each kind of work runs.

## Sharing

A cloud project can be shared read-only by link, with the owner choosing which surfaces a viewer sees. The server filters the doc and its media to that set before anything leaves, and a viewer can copy the shared project into their own account.

## The assistant

The chat drives everything the editor can do through typed tools, and every tool's schema and prompt text derive from the same constants the UI uses, so the catalog stays true. The assistant guide covers the harness, the tools, and the evals that hold the line.

## Where it lives

The editor, its stores, and the backend seam live under the site's `cut` folder; the engine and worker share its server code; the Mac app is a menu bar shell that ships the engine and screen recording.
