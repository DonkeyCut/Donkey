<p align="center">
  <img src="site/public/donkey-app-icon.png" alt="Donkey Cut" width="128" height="128" />
</p>

<h1 align="center">Donkey Cut</h1>

<p align="center"><i>A free, open source CapCut alternative. Edit with chat. Generate video, images, voiceovers, and music.</i></p>

<p align="center">
  <a href="https://github.com/DonkeyCut/Donkey/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/DonkeyCut/Donkey?label=release&color=EC7868" /></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" /></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/Platform-macOS-black.svg" />
</p>

Donkey Cut is a free video editor that runs in your browser.

You can save projects in the cloud and open them anywhere. You can also keep projects on your computer so your video files stay local.

---

## Donkey Cut

Donkey Cut is a simple video editor with a multi-track timeline, captions, music, effects, and an AI assistant that can help you edit.

<p align="center">
  <img src=".github/cut-editor-railway.gif" alt="The Donkey Cut editor with The Railway Mystery open: generated shots in the side panel, clips and score on the timeline" width="960" />
  <br />
  <sub><i>The editor with "The Railway Mystery" open. Generated shots in the side panel, with clips and music on the timeline.</i></sub>
</p>

### Your computer or the cloud

You choose where each project lives.

**Cloud projects** work anywhere. You do not need to install anything. Upload your media from the browser and export your video right in the tab. You can also share a project with a read-only link.

**Local projects** keep your files on your computer. Nothing needs to be uploaded.

Both types of projects appear together on the same home screen.

The AI assistant works with both. You can generate images, video, voiceovers, and music. Generated files are added to your project just like any other media.

### For Mac users

Install the [Donkey Cut companion app](https://github.com/DonkeyCut/Donkey/releases/latest) to connect the editor to your Mac.

* Projects are saved in `~/Movies`, so you can see and manage them directly in Finder.
* Captions and transcription run locally on your Mac.
* Connect the AI assistant to your existing Codex or Claude Code login.
* Record your screen directly onto the timeline.

When the app is running, cloud projects can also use your Mac for transcription.

### Generate what you can't shoot

Describe a shot in chat and keep iterating until you get what you want.

These are the two example projects from the [landing page](https://donkeycut.com). The prompts are included below.

**The Railway Mystery** is a 1920s comic-style chase. It uses three generated shots with a brass-and-strings score.

> Franco-Belgian comic style, early-1900s animation with film grain: a steam train races a cliffside railway through a mountain canyon; a cloaked figure rides the carriage roof; a boy on a bicycle gives chase

| Canyon run | On the roof | Bicycle chase |
| --- | --- | --- |
| ![Steam train threading a mountain canyon](site/public/cut/landing/chase-1.jpg) | ![Cloaked figure on the carriage roof](site/public/cut/landing/chase-2.jpg) | ![Boy on a bicycle chasing the train](site/public/cut/landing/chase-3.jpg) |

**City poster series** uses matching hand-painted travel posters. The posters are animated into 4-second clips and edited together with captions and a waltz.

> Hand-painted travel poster, PARIS — woman in a trench coat crossing the street, Eiffel Tower behind, café awnings, 'Live the romance' in red script

| Paris — Live the romance | New York — Rise above the city |
| --- | --- |
| ![Paris travel poster](site/public/cut/landing/poster-paris.jpg) | ![New York travel poster](site/public/cut/landing/poster-newyork.jpg) |

<p align="center">
  <img src=".github/cut-editor-travel-posters.gif" alt="The Donkey Cut editor with the City poster series open: both posters generated in the side panel, animated clips with captions and a waltz on the timeline" width="960" />
  <br />
  <sub><i>The poster series in the editor. Both posters are animated into clips with captions and a waltz.</i></sub>
</p>

### How it works

The editor looks and works the same everywhere. Each project decides where its files are stored and where processing happens.

```text
browser (the editor)
  ├─ local project ───▶ the browser's own storage, on your computer
  │
  ├─ cloud project ───▶ hosted APIs · Postgres · R2 storage
  │
  └─ with the Mac app ▶ Cut engine on 127.0.0.1
                        local disk (~/Movies) · bundled ffmpeg
                        · on-device speech · your claude/codex logins
```

The local engine only runs on your Mac. On a hosted deployment, these routes return 404 before any handler runs.

For the full architecture, see [`docs/guides/cut/README.md`](docs/guides/cut/README.md).

### Pricing

The editor is free.

We only charge for cloud storage and AI content generation.

---

## Repository layout

| Path | What's there |
| --- | --- |
| [`apps/Donkey`](apps/Donkey) | The macOS companion app. It runs the Cut engine and handles screen recording. |
| [`site`](site) | The Next.js site, Cut editor, engine, cloud backend, and hosted API routes. |
| [`docs`](docs/README.md) | Product documentation and engineering guides. |

## Build and run

Run the editor locally:

```sh
cd site
npm install
npm run db:generate
npm run dev
```

Then open `http://localhost:3000/cut`.

Run the macOS app in development:

```sh
cd apps/Donkey
swift run Donkey
```

Build the packaged app and installer disk image:

```sh
./scripts/package-donkey-app.sh
open dist/Donkey.app
```

The site uses Supabase Postgres through Prisma. Keep local credentials in `.env`. Never commit them.

## Documentation

[`docs/README.md`](docs/README.md) is the source of truth for supported behavior.

Good places to start:

* [Cut](docs/guides/cut/README.md) for the editor, local engine, and cloud projects.
* [Install Donkey Locally](docs/guides/install-donkey.md) for building the app bundle.

## License

Apache 2.0. See [LICENSE](LICENSE).
