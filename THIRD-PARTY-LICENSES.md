# Third-Party Tools Bundled in Donkey

Bundled in `donkey-tools/` (built by `scripts/fetch-bundled-tools.sh`).

| Tool | License | Notes |
|---|---|---|
| ffmpeg | LGPL-2.1 | built `--disable-gpl`, no x264/x265; H.264/HEVC encode via VideoToolbox; subtitle burn-in links libass (ISC), freetype (FTL), fribidi (LGPL-2.1+) |
| liteparse (`lit`) | Apache-2.0 | PDF extraction; bundles Tesseract (Apache-2.0) for OCR |
| yt-dlp | Unlicense | |
| qpdf | Apache-2.0 | |
| exiftool | Perl Artistic / GPL-1.0+ | runs via system `/usr/bin/perl` |
| pdf-fill | first-party | native PDFKit form-fill/overlay (`tools/pdf-fill/`); Apple system frameworks only, no third-party deps |

Not bundled — used only if the user already has them installed:
- **pandoc** (GPL-3.0): macOS `textutil` covers the common office conversions.
- **ImageMagick** (`magick`): `sips` covers the common image operations.

## Content served by the site

| Content | License | Notes |
|---|---|---|
| Built-in LUTs (`site/public/cut/luts/`) | CC BY-SA 4.0 | resampled from the RawTherapee Film Simulation Collection by Pat David, Pavlov Dmitry and Michael Ezra (`scripts/build-builtin-luts.ts`) |
