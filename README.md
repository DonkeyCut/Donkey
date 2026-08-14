<p align="center">
  <img src="site/public/donkey-app-icon.png" alt="Donkey" width="128" height="128" />
</p>

<h1 align="center">Donkey</h1>

<p align="center"><i>The video editor iMovie should have been — free, open source, and local-first, with AI generation when you want it.</i></p>

<p align="center">
  <a href="https://github.com/DonkeyUseCorp/Donkey/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/DonkeyUseCorp/Donkey?label=release&color=EC7868" /></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" /></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/Platform-macOS-black.svg" />
</p>

Donkey is **Donkey Cut** — a free browser video editor at [donkeycut.com](https://donkeycut.com), powered by a local engine that ships inside the companion Mac app.

---

## Donkey Cut

Open [donkeycut.com](https://donkeycut.com) and you're in a full editor: multi-track timeline, captions, music and effects tracks, and an AI assistant that edits alongside you. The page is only the client — every real operation runs on a local engine the Donkey Mac app ships and supervises, so your footage stays on your Mac. No uploads, no cloud storage fees.

<p align="center">
  <img src=".github/cut-editor-railway.gif" alt="The Donkey Cut editor with The Railway Mystery open: generated shots in the side panel, clips and score on the timeline, and the AI chat that assembled them" width="960" />
  <br />
  <sub><i>The editor with "The Railway Mystery" open — generated shots in the side panel, clips and score on the timeline, and the AI chat that assembled them.</i></sub>
</p>

### Free and local

Editing needs no account. Projects and media live on your own disk, transcription and subtitles run on-device, and exports render through the bundled ffmpeg. The assistant uses the Claude or Codex app already signed in on your Mac — if you have a subscription, you're done. No setup, no API keys.

The one hosted piece is AI generation: images, video, voiceovers, and music are rendered through your Donkey account and credits, then land back in your project like any other file.

### Generate what you can't shoot

Describe a shot in chat and iterate until it's right. These are the two example projects from the [donkeycut.com](https://donkeycut.com) landing page, prompts included.

**The Railway Mystery** — a 1920s comic-style chase, three generated shots cut together with a brass-and-strings score:

> Franco-Belgian comic style, early-1900s animation with film grain: a steam train races a cliffside railway through a mountain canyon; a cloaked figure rides the carriage roof; a boy on a bicycle gives chase

| Canyon run | On the roof | Bicycle chase |
| --- | --- | --- |
| ![Steam train threading a mountain canyon](site/public/cut/landing/chase-1.jpg) | ![Cloaked figure on the carriage roof](site/public/cut/landing/chase-2.jpg) | ![Boy on a bicycle chasing the train](site/public/cut/landing/chase-3.jpg) |

**City poster series** — matched hand-painted travel posters, animated into 4-second clips and cut with captions and a waltz:

> Hand-painted travel poster, PARIS — woman in a trench coat crossing the street, Eiffel Tower behind, café awnings, 'Live the romance' in red script

| Paris — Live the romance | New York — Rise above the city |
| --- | --- |
| ![Paris travel poster](site/public/cut/landing/poster-paris.jpg) | ![New York travel poster](site/public/cut/landing/poster-newyork.jpg) |

<p align="center">
  <img src=".github/cut-editor-travel-posters.gif" alt="The Donkey Cut editor with the City poster series open: both posters generated in the side panel, animated clips with captions and a waltz on the timeline" width="960" />
  <br />
  <sub><i>The poster series in the editor — both posters animated into clips, cut with captions and a waltz.</i></sub>
</p>

### How it works

The hosted page and the local engine split the work: the page comes from wherever is convenient, the work always happens on your Mac.

```text
browser (donkeycut.com or localhost)
        │  API calls
        ▼
Cut engine on 127.0.0.1 — shipped and supervised by the Donkey Mac app
        │
        ▼
local disk · bundled ffmpeg · on-device speech · your claude/codex logins
```

On a hosted deploy every Cut API answers 404 before any handler runs — the server side of Cut exists only on your machine. The full architecture lives in [`docs/guides/cut/README.md`](docs/guides/cut/README.md).

### Pricing

The editor is free. Pay only for AI-generated media: the Pro plan ($20/month) adds monthly credits for image, video, voiceover, and music generation.

---

## Repository layout

| Path | What's there |
| --- | --- |
| [`apps/Donkey`](apps/Donkey) | The macOS companion app; it ships and supervises the Cut engine. |
| [`site`](site) | The Next.js site, the Cut editor and engine, and hosted API routes. |
| [`docs`](docs/README.md) | Supported product behavior and engineering guides. |

## Build and run

Run the editor locally:

```sh
cd site
npm install
npm run db:generate
npm run dev
```

The editor is at `http://localhost:3000/cut`.

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

The site uses Supabase Postgres through Prisma. Keep local credentials in `.env` and never commit them.

## Documentation

[`docs/README.md`](docs/README.md) is the source of truth for supported behavior. Good starting points:

- [Cut](docs/guides/cut/README.md) — the editor, its local engine, and the boundary between them.
- [Install Donkey Locally](docs/guides/install-donkey.md) — building the app bundle.

## License

Apache 2.0 — see [LICENSE](LICENSE).
