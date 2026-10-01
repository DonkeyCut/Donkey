# Color

A clip's color is one recipe: what its code values mean (the source profile), the grade on top, and the space the project delivers in. The kit bakes the recipe into one 3D LUT, and the preview, the thumbnails and the export all draw through that lattice, so the picture is the same number everywhere.

**The one rule:** the project's color space decides the target of every recipe. SDR projects deliver Rec.709; an HDR project composites in HLG, and everything drawn into the frame — footage, titles, stickers, captions, the frame color — is mapped into that space before it is blended.

## Source color

Every video carries a source profile, read from its header at import: Apple Log and Log 2 by Apple's metadata identifier, HLG and PQ by the transfer tag beside a BT.2020 matrix, sRGB by its transfer, Rec.709 otherwise. The Color panel shows the detection and takes a per-asset override.

Rec.709 and sRGB sources draw as they are. Log goes through the ACES 2.0 output transform, HLG and PQ through the BT.2100 OOTF on a 100-nit display, so the grade and any creative LUT see a Rec.709 picture. A technical Log→Rec.709 LUT is a conversion of its own: it goes on a clip whose source is set to "Rec.709 (no conversion)".

That needs the code values untouched, and a browser converts a decoded frame by its bitstream tags, so the parameter set's tags are rewritten to neutral Rec.709 / sRGB before the decoder sees them. The matrix a decoder draws with differs by browser, so each route is measured once per session and the clip's LUT undoes it before applying the file's own. ffmpeg and headless renders read the file's matrix and need no fix. ProRes masters and their preview proxies are in [Local Compute](local-compute.md).

## LUTs

A `.cube` or `.3dl` file is a Library file keyed by its content, so the same file dropped twice is one LUT and it travels with a project. The built-in film LUTs are `.cube` files the site serves, keyed the same way. A grade names either by `lut:<key>`; the recipe bakes it between the source conversion and the grade, and an export stages its bytes beside the job, so every renderer applies the same numbers.

## HDR delivery

An HDR project keeps what the footage has. Log sources convert into the HLG container through the ACES output transform; HLG and PQ cross straight over the BT.2100 transfer, so their range survives. Rec.709 footage and every graphic take the BT.2408 mapping, SDR white at 75% HLG signal (203 nits), so a title sits at reference white beside the footage. The grade works inside the container at 10 bits.

```
clip ─ source profile ─▶ recipe LUT (output: hlg) ─┐
title / sticker / caption ─▶ sRGB→HLG LUT ─────────┼─▶ HLG composite, 10-bit, Rec.2020
frame color ─▶ hex mapped to HLG ──────────────────┘          │
                                                    PQ project: HLG→PQ lattice at 1000 nits
                                                              │
                                              HEVC Main 10 or ProRes, tagged bt2020 + HLG or PQ
```

PQ is one fixed pass at the end: every recipe targets HLG, and the PQ file is that composite through the OOTF and the ST 2084 curve. H.264 is 8-bit and greys out. The worker's HEVC writes HDR10 static metadata for PQ; the Mac's hardware encoder writes none, and players take the 1000-nit reference. A file already in the project's space with no grade copies its streams as is.

## HDR preview

On an HDR display in a browser with WebGPU, the stage composites in HLG and one extra pass per frame on a float16 canvas decodes the signal to display light, reference white at 1.0 with the headroom above it. When the display, the browser or the GPU cannot carry it, the stage renders the same grade as SDR and says "Previewing SDR". That is the one fallback.
