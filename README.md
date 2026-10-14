# Document scanner

A browser-based document scanner. Upload a photo of a document. The app finds
the page corners, corrects the perspective, and downloads a flat scan. You can
move the corners by hand when the automatic detection is not exact.

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
| `bun --bun run preview` | Serve the built client bundle on port 4173 |
| `bun run test` | Run the unit tests |
| `bun run typecheck` | Run the TypeScript compiler with no output |
| `bun run check` | Lint and format with Biome |

## How it works

```
upload ──► decode to canvas ──► detect page quad ──► review ──► warp ──► download
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
| `src/lib/imageFile.ts` | File, canvas, and download helpers |
| `src/components/DocumentScanner.tsx` | The upload, review, and download flow |
| `src/components/CropEditor.tsx` | The photo with draggable corner nodes |
| `src/components/ResultPreview.tsx` | The corrected page |

### Detection

Detection runs on a copy of the photo that is at most 640 px on the long side,
so it stays fast on a phone. The pipeline builds two candidate quads and keeps
the better one:

- **region** — the page is the largest bright region that does not reach all
  four borders of the frame. The backdrop is rejected this way.
- **edges** — the page border is the strongest connected ridge of image
  gradient, closed with a generous radius to bridge gaps, then eroded back so
  the outline keeps its true size.

Each candidate becomes a convex hull that is simplified and reduced to the
largest inscribed quadrilateral. The two are then ranked on three measures:

- how well the quad edges sit on real image gradients,
- how close the corners are to right angles,
- how much of the frame the quad covers.

A ranking below the confidence floor returns no quad, and the app shows the
full frame instead. Detection is a convenience: the corners are always
adjustable.

## Limits and known gaps

- Detection expects a page that does not fill the whole frame and that has some
  visible border. A page that fills the frame, or a page with no visible edge,
  falls back to the full frame.
- The corrected output keeps the lighting of the original photo. There is no
  contrast, brightness, or color enhancement yet.
- The output is a JPEG at quality 0.92. There is no format choice yet.
- The layout is responsive and the corner nodes use pointer events, but mobile
  ergonomics are not finished.
- Scans are not stored. A refresh loses the current image.
