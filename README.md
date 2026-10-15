# Rescanned

A browser-based document scanner. Upload a photo of a document. The app finds
the page corners, corrects the perspective, and then copies or downloads a flat
scan. You can move the corners by hand when the automatic detection is not
exact.

The app runs entirely in the browser. No image leaves the device.

## Requirements

- [Bun](https://bun.sh/) 1.4 or later
- A browser that supports `canvas`, `File`, and pointer events

## Run the app

```bash
bun install
bun --bun run dev
```

The app serves on <http://localhost:3000>.

## Other commands

| Command | Purpose |
| --- | --- |
| `bun --bun run build` | Build the client and server bundles into `dist/` |
| `bun --bun run preview` | Serve the built app in the Workers runtime on port 4173 |
| `bun --bun run deploy` | Build, then publish to Cloudflare |
| `bun run test` | Run the unit tests |
| `bun run typecheck` | Run the TypeScript compiler with no output |
| `bun run check` | Lint and format with Biome |

## Deployment

The app deploys to Cloudflare Workers through `@cloudflare/vite-plugin`, which
runs for `vite build` and `vite preview`: it produces the Worker bundle and
serves that bundle inside `workerd`, so a preview behaves like production.
`vite dev` stays on the plain Vite server, and `wrangler dev --config
dist/server/wrangler.json` runs the real Worker locally instead.

`wrangler.jsonc` holds the Worker name, its `main` entry (the TanStack Start
server entry), the `nodejs_compat` flag, and the custom domain. On the first
deploy, Cloudflare creates the DNS record and the certificate for
`rescanned.nuarthy.my.id` itself.

```bash
bun --bun run deploy
```

## How it works

```
upload ──► decode to canvas ──► detect page quad ──► review ──► warp ──► copy / download
                                      │                  │
                                      │                  └── Edit corners: drag the nodes
                                      └── full-frame inset when detection is unsure
```

| Module | Responsibility |
| --- | --- |
| `src/lib/pixels.ts` | Grayscale, box blur, Sobel gradient, Otsu threshold, morphology, connected components |
| `src/lib/geometry.ts` | Quad ordering, convex hull, polygon simplification, largest inscribed quad, quad metrics |
| `src/lib/detect.ts` | The detection pipeline and the candidate ranking |
| `src/lib/perspective.ts` | Output size and the homography warp |
| `src/lib/filters.ts` | Page filters: lighten, no shadow, black and white, high contrast |
| `src/lib/imageFile.ts` | File, canvas, and download helpers |
| `src/lib/scanRenderer.ts` | Runs detection and rendering on a worker, with a main-thread fallback |
| `src/lib/scanWorker.ts` | The worker side: page detection, warp, and filtering |
| `src/components/DocumentScanner.tsx` | The upload, review, and download flow |
| `src/components/CropEditor.tsx` | The photo with draggable corner nodes and a magnifier while a corner moves |
| `src/components/ResultPreview.tsx` | The corrected page |

### Detection

Detection runs in the worker, on a copy of the photo that is at most 640 px on
the long side, so the main thread stays free. Three views of the photo propose
candidate quads, and the best one wins:

- **flood** — the page is a surface that a brightness frontier fills before a
  dark boundary stops it. Each region starts at the brightest pixel its surface
  still has, so no single threshold has to hold across the whole photo.
- **region** — the page is the largest bright (or dark) region that does not
  reach all four borders of the frame. The backdrop is rejected this way.
- **edges** — the page border is the strongest connected ridge of image
  gradient, closed with a generous radius to bridge gaps, then eroded back so
  the outline keeps its true size.

Each candidate becomes a convex hull that is simplified and reduced to the
largest inscribed quadrilateral. The candidates are then ranked on five
measures:

- how well the quad edges sit on real image gradients,
- how close the corners are to right angles,
- how much of the frame the quad covers,
- how far the quad stands inside the frame, so a crop that leaves nothing
  outside it cannot read as a page,
- how much brighter the quad is than the surface around it, on all four sides,
  so a bright patch of wall loses to the page in front of it.

A ranking below the confidence floor returns no quad, and the app shows the full
frame instead. A confident wrong corner is worse than no corner: the user drags
the nodes either way, and a wrong guess also hides that the crop is a guess.
Detection is a convenience: the corners are always adjustable.

### Filters

Filters run after the warp, so the preview and the download always match.

| Filter | What it does |
| --- | --- |
| Lighten | Stretches the top of the range so paper reaches white while ink stays dark |
| No shadow | Balances each channel against its paper level to remove the colour cast, flattens the lighting, then deepens the ink and lifts colour |
| Black & white | Luma grayscale |
| High contrast B&W | Flattens the lighting, then splits the page into pure black and pure white with Otsu |

Three constants in `src/lib/filters.ts` set the strength of **No shadow**:
`CONTRAST_WHITE_POINT` (everything above this clips to white, which is what
clears faint dirt), `CONTRAST_BLACK_POINT` (how deep the ink goes), and
`SATURATION_BOOST` (colour vividness). Lowering the white point cleans the page
further at the cost of faint, pale strokes.

### Placing a corner

While a corner node moves, a square magnifier follows it with a crosshair in the
middle. It is drawn from the full-resolution source, so the magnified detail goes
beyond what the display canvas keeps, and it sits clear of the node so a finger
does not cover the corner being placed. It is painted into the overlay canvas
that a pointer move already repaints, so it adds no element and no extra pass.
`LOUPE_SIZE`, `LOUPE_ZOOM`, and `LOUPE_GAP` in `src/components/CropEditor.tsx`
set its size, its magnification, and its clearance from the node.

### Copy or save the preview

The corrected page is an `<img>`, not a canvas, so the device's own menu works on
it: right-click and **Copy image** on a desktop, press and hold and **Copy** or
**Save to Photos** on a phone. The browser's own menu puts every representation
on the system clipboard that other apps look for. A page's own clipboard call
does not reach that far: on iOS the write lands in an app-scoped pasteboard, and
WebKit still resolves the promise, so a paste elsewhere comes up empty.

The image is the preview, up to 1000 px on the long side, encoded as JPEG. The
worker does the encoding, so a new preview costs the main thread nothing but a
new object URL; without a worker the same encode runs on the main thread. Both
paths produce the same bytes.

**Download** renders the page again at full source resolution and encodes a JPEG
at quality 0.92, which takes longer and gives a bigger file.

## Limits and known gaps

- Detection expects a page that does not fill the whole frame and that has some
  visible border. A page that fills the frame, or a page with no visible edge,
  falls back to the full frame.
- A surface that is only a little brighter than the one behind it, and whose top
  edge is hidden, comes back as not detected rather than as a guess. A
  whiteboard on a bright wall is the usual case.
- The photo is decoded and copied to a canvas on the main thread, which is still
  a few hundred milliseconds for a full-resolution phone photo.
- The output is a JPEG at quality 0.92. There is no format choice yet.
- The layout is responsive and the corner nodes use pointer events, but mobile
  ergonomics are not finished.
- Scans are not stored. A refresh loses the current image.
