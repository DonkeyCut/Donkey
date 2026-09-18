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

The user sees two places, Local and Cloud. Local is the Mac's engine once the app has connected and the browser's own storage otherwise, so a fully local project needs nothing installed. A project lives in exactly one home and the surfaces never proxy to each other. Copy and paste crosses homes: a selection or a media card copied in one project pastes into another with its media brought across, and a second paste of the same source finds the copy already there.

AI is hosted whatever the home: image, video, and voiceover generation and the assistant's Gemini models run through Donkey's authenticated inference routes against the user's credits, and the results land in the project like any other file. The cloud's routes are the engine's hosted twin, same shapes with session auth and credit metering.

## The preview

The preview scrubs and plays from per-clip decoders held in memory. It shows a frame the moment it arrives and refines behind it, so the timeline always answers and a jump lands on a picture. Every cache is bounded by one memory budget sized to the machine. The performance guide holds the frame budget and how a change is measured.

Background previews capture a project operation and a render document before asynchronous work starts. The operation carries the project, residency, document version, capabilities, and transport. The preview queue coalesces edits and drains the final edit when the editor closes. Cloud exports requested from a document store that document in the queued job, so a later edit cannot change the export's input.

```
Project operation + captured document
                ↓
       Render preparation
                ↓
         Residency renderer
                ↓
        Preview artifact
                ↓
         ArtifactVideo
```

Browser previews use the browser compositor and replace one cached proxy in OPFS. A browser without the required encoders borrows the cloud worker and brings the result back to OPFS. Automatic browser renders run while the page is hidden and stop when editing resumes or the editor closes; the shelf uses the last completed proxy or its source thumbnail. Mac previews use the engine, retain a file per live job, and publish the project card atomically. Cloud preview jobs have immutable object keys; only the newest requested job can publish the project's preview pointer. A job ID resolves to a fresh delivery URL. Retired cloud previews expire after a day, while the current project preview stays available. The shared viewer plays MP4 or HLS with its own media element and releases its resources on source changes and unmount.

Cloud source media, generated media, and retained exports count toward storage. Derived previews, share cards, and HLS ladders are quota-exempt; staging inputs are temporary. An export is weighed twice — the size it is heading for before a frame is drawn, and what actually landed before the account is charged — so one render cannot carry an account past its cap. Transports expose structured storage, credit, and authentication failures. Each host chooses their presentation; the website mounts its storage dialog separately.

Timeline and preview share selection: ⌘/Ctrl-click or Shift-click toggles items, and dragging moves them together with one undo step. Items move independently until grouped, and groups save with the project. On the preview the selection wears one frame whose grips scale the set and whose button turns it, while a drag on any member moves them all. Selecting two or more items opens the group panel: it shows the fields every selected item has, reads a field as Mixed where they differ, and writes each edit to all of them in one undo step. A selection of one kind keeps that kind's own rows and its Color and Animation views, and an effect brings only its amount and Hidden.

Guides draw over the preview from the button beside the timeline zoom: thirds, center, safe margins, the short-form keep-out zone where TikTok, Reels and Shorts draw their own UI or crop the sides of a 9:16 frame, and custom lines dragged into place on the preview. They save with the project, snap a dragged element to their edges, never export, and the assistant reads the safe area they leave when it places graphics.

## The export

An export is the preview drawn again frame by frame into an MP4 by the same compositor and mixer, so the file matches what the person saw. The dialog names the file, runs at the footage's own frame rate unless told otherwise, can deliver just the span the selection covers, offers a marked 4K upscale because the platforms transcode a 4K upload at a higher bitrate, and can save the captions as an SRT to the browser's Downloads folder. The Master preset is ProRes 4444, composited at 4:4:4 end to end, so titles and captions land in the file with the color the preview drew. One thing the export draws better: a clip in smooth slow motion has its in-between frames estimated from the motion around them, where the preview blends the neighbors; a browser without WebGPU blends too. The finished file goes to the project's home: the app's project folder for a Mac project, storage for a cloud one, the page's store for a browser one. A browser that cannot carry the render hands it to the machine behind the project, and the ffmpeg pipeline stays for ProRes, headless renders, share cards, and streaming ladders. The local-compute guide covers where each kind of work runs.

## Sharing

A cloud project can be shared read-only by link, with the owner choosing which surfaces a viewer can open. The server filters the doc and its media to that set before anything leaves; the rail still shows every tab, and a withheld one sits locked with a hover note saying the view is read-only. A viewer can copy the shared project into their own account.

Folders and assets use the project Share dialog for read-only public links or verified-email access; local items first become independent cloud copies. Folder access follows current contents; revocation blocks new requests immediately, while issued media URLs expire within two hours.

## The assistant

The chat drives everything the editor can do through typed tools, and every tool's schema and prompt text derive from the same constants the UI uses, so the catalog stays true. The assistant guide covers the harness, the tools, and the evals that hold the line.

## Where it lives

The editor, its stores, and the backend seam live under the site's `cut` folder; the engine and worker share its server code; the Mac app is a menu bar shell that ships the engine and screen recording. Every kind of item the timeline can select is one entry in the item-kind table beside the store, and copy, paste, templates and the media collector read that table, so a new kind is copyable and pasteable by construction.
