/**
 * Output shapes for the corrected page: a printed paper size, or a plain ratio
 * such as 4:3, and the stretch that fills the page out to one.
 *
 * Numbers and pixels only, like `filters.ts`, so the worker, the page, and the
 * tests all run the same code.
 */

import { normalizeTurns, type Orientation } from "./orientation";
import type { RgbaImage } from "./pixels";

export type PaperId =
	| "a3"
	| "a4"
	| "a5"
	| "a6"
	| "b4"
	| "b5"
	| "letter"
	| "legal"
	| "tabloid";

/** A plain ratio the result can take, wide side first. */
export type RatioId = "1:1" | "5:4" | "4:3" | "3:2" | "16:10" | "16:9" | "21:9";

/**
 * What the result is sized to: the crop's own shape, a paper, or a ratio.
 *
 * One value rather than two settings, so a paper and a ratio can never both be
 * chosen and leave the render guessing.
 */
export type OutputShape =
	| { kind: "original" }
	| { kind: "paper"; id: PaperId }
	| { kind: "ratio"; id: RatioId };

export interface PaperSize {
	id: PaperId;
	label: string;
	/** Long side up. `orientPaper` turns it when the page lies down. */
	widthMm: number;
	heightMm: number;
}

/**
 * Sizes worth a button: the two ISO series people print on, and the North
 * American set. Deliberately no B6 or Executive; nobody scans onto them.
 */
export const PAPER_SIZES: readonly PaperSize[] = [
	{ id: "a3", label: "A3", widthMm: 297, heightMm: 420 },
	{ id: "a4", label: "A4", widthMm: 210, heightMm: 297 },
	{ id: "a5", label: "A5", widthMm: 148, heightMm: 210 },
	{ id: "a6", label: "A6", widthMm: 105, heightMm: 148 },
	{ id: "b4", label: "B4", widthMm: 250, heightMm: 353 },
	{ id: "b5", label: "B5", widthMm: 176, heightMm: 250 },
	{ id: "letter", label: "Letter", widthMm: 215.9, heightMm: 279.4 },
	{ id: "legal", label: "Legal", widthMm: 215.9, heightMm: 355.6 },
	{ id: "tabloid", label: "Tabloid", widthMm: 279.4, heightMm: 431.8 },
];

/** Print resolution a paper is sized at, before any cap applies. */
export const PAPER_DPI = 300;

/**
 * Ceiling on the pixels one resized render may hold.
 *
 * A3 at 300 DPI is 4961 by 3508, about 17 million pixels, and iOS refuses a
 * canvas past roughly that area. Capping the count rather than the sides keeps
 * every shape inside the limit and still keeps the aspect ratio exact.
 */
export const MAX_OUTPUT_PIXELS = 10_000_000;

const MM_PER_INCH = 25.4;

export interface AspectRatio {
	id: RatioId;
	label: string;
	/** Wide side first. */
	width: number;
	height: number;
}

/**
 * Ratios worth a button, narrowest first.
 *
 * The order is a ramp from square to ultrawide, so the row reads as a scale.
 * Every ratio follows the page's own orientation, so 16:9 on a portrait page
 * comes out 9:16; the chip keeps the familiar name.
 */
export const ASPECT_RATIOS: readonly AspectRatio[] = [
	{ id: "1:1", label: "1:1", width: 1, height: 1 },
	{ id: "5:4", label: "5:4", width: 5, height: 4 },
	{ id: "4:3", label: "4:3", width: 4, height: 3 },
	{ id: "3:2", label: "3:2", width: 3, height: 2 },
	{ id: "16:10", label: "16:10", width: 16, height: 10 },
	{ id: "16:9", label: "16:9", width: 16, height: 9 },
	{ id: "21:9", label: "21:9", width: 21, height: 9 },
];

export interface Size {
	width: number;
	height: number;
}

export function paperSize(id: PaperId): PaperSize {
	const size = PAPER_SIZES.find((candidate) => candidate.id === id);
	if (!size) throw new Error(`Unknown paper size: ${id}`);
	return size;
}

export function aspectRatio(id: RatioId): AspectRatio {
	const ratio = ASPECT_RATIOS.find((candidate) => candidate.id === id);
	if (!ratio) throw new Error(`Unknown aspect ratio: ${id}`);
	return ratio;
}

/**
 * The paper turned the way the page lies.
 *
 * A page wider than it is tall wants the paper on its side. The two aspect
 * ratios are compared in log space so a paper that is too tall is penalised as
 * much as one that is too wide. Picking the nearer orientation keeps the
 * stretch that follows as small as it can be.
 */
export function orientPaper(paper: PaperSize, page: Size): PaperSize {
	const pageAspect = Math.log(page.width / Math.max(1, page.height));
	const upright = Math.log(paper.widthMm / paper.heightMm);
	const sideways = Math.log(paper.heightMm / paper.widthMm);

	if (Math.abs(pageAspect - upright) <= Math.abs(pageAspect - sideways)) {
		return paper;
	}
	return {
		...paper,
		widthMm: paper.heightMm,
		heightMm: paper.widthMm,
	};
}

/**
 * Pixel size of the paper for this page.
 *
 * `maxDimension` caps the long side so a preview can ask for a paper-shaped
 * image at preview resolution instead of at print resolution. The aspect ratio
 * survives every cap.
 */
export function paperTarget(
	paper: PaperSize,
	page: Size,
	maxDimension?: number,
): Size {
	const turned = orientPaper(paper, page);
	let width = Math.max(
		1,
		Math.round((turned.widthMm / MM_PER_INCH) * PAPER_DPI),
	);
	let height = Math.max(
		1,
		Math.round((turned.heightMm / MM_PER_INCH) * PAPER_DPI),
	);

	const pixels = width * height;
	if (pixels > MAX_OUTPUT_PIXELS) {
		const scale = Math.sqrt(MAX_OUTPUT_PIXELS / pixels);
		// Floor, not round: rounding one side up can push the count back past
		// the ceiling the scale was chosen to hit.
		width = Math.max(1, Math.floor(width * scale));
		height = Math.max(1, Math.floor(height * scale));
	}

	const longest = Math.max(width, height);
	if (maxDimension !== undefined && longest > maxDimension) {
		const scale = maxDimension / longest;
		width = Math.max(1, Math.round(width * scale));
		height = Math.max(1, Math.round(height * scale));
	}

	return { width, height };
}

/**
 * Pixel size of a ratio for this page.
 *
 * The page's long side keeps its pixels, so choosing a ratio never adds
 * resolution; only the short side follows the ratio. The result takes the
 * page's own orientation, so a tall page gets the tall form of the same ratio.
 */
export function ratioTarget(
	ratio: AspectRatio,
	page: Size,
	maxDimension?: number,
): Size {
	const pageLong = Math.max(1, page.width, page.height);
	const cap =
		maxDimension === undefined ? pageLong : Math.min(pageLong, maxDimension);
	const long = Math.max(ratio.width, ratio.height);
	const short = Math.min(ratio.width, ratio.height);
	const shortSide = Math.max(1, Math.round((cap * short) / long));
	const portrait = page.height > page.width;

	let width = portrait ? shortSide : cap;
	let height = portrait ? cap : shortSide;

	const pixels = width * height;
	if (pixels > MAX_OUTPUT_PIXELS) {
		const scale = Math.sqrt(MAX_OUTPUT_PIXELS / pixels);
		width = Math.max(1, Math.floor(width * scale));
		height = Math.max(1, Math.floor(height * scale));
	}

	return { width, height };
}

/**
 * Stretch the page to the sheet.
 *
 * Each axis scales on its own, so the page ends up exactly the size of the
 * paper. A page whose shape differs from the paper is pulled onto it instead of
 * being framed with margins, and a nearly square one comes out square.
 *
 * Bilinear sampling, done by hand, so the worker, the page, and a test all get
 * the same bytes.
 */
export function stretchToSize(page: RgbaImage, target: Size): RgbaImage {
	const { width, height } = target;
	const data = new Uint8ClampedArray(width * height * 4);
	const source = page.data;
	const sourceWidth = page.width;
	const sourceHeight = page.height;
	const scaleX = sourceWidth / width;
	const scaleY = sourceHeight / height;

	for (let y = 0; y < height; y += 1) {
		// The sample point can fall outside the page when the sheet is larger
		// than it. Clamping the point itself, rather than its fraction, holds
		// the edge colour instead of fading it to white.
		const v = clamp((y + 0.5) * scaleY - 0.5, 0, sourceHeight - 1);
		const v0 = Math.floor(v);
		const v1 = Math.min(sourceHeight - 1, v0 + 1);
		const fy = v - v0;

		for (let x = 0; x < width; x += 1) {
			const u = clamp((x + 0.5) * scaleX - 0.5, 0, sourceWidth - 1);
			const u0 = Math.floor(u);
			const u1 = Math.min(sourceWidth - 1, u0 + 1);
			const fx = u - u0;

			const topLeft = (v0 * sourceWidth + u0) * 4;
			const topRight = (v0 * sourceWidth + u1) * 4;
			const bottomLeft = (v1 * sourceWidth + u0) * 4;
			const bottomRight = (v1 * sourceWidth + u1) * 4;
			const targetIndex = (y * width + x) * 4;

			for (let channel = 0; channel < 4; channel += 1) {
				const top =
					source[topLeft + channel] * (1 - fx) +
					source[topRight + channel] * fx;
				const bottom =
					source[bottomLeft + channel] * (1 - fx) +
					source[bottomRight + channel] * fx;
				data[targetIndex + channel] = top * (1 - fy) + bottom * fy;
			}
		}
	}

	return { data, width, height };
}

/**
 * Stretch the page to the chosen shape, or hand it back untouched for
 * `original`.
 *
 * Both render paths call this after the filter, so the screen and the download
 * come out the same size.
 */
export function applyShape(
	image: RgbaImage,
	shape: OutputShape,
	maxDimension?: number,
): RgbaImage {
	switch (shape.kind) {
		case "original":
			return image;
		case "paper":
			return stretchToSize(
				image,
				paperTarget(paperSize(shape.id), image, maxDimension),
			);
		case "ratio":
			return stretchToSize(
				image,
				ratioTarget(aspectRatio(shape.id), image, maxDimension),
			);
	}
}

/**
 * Pixel size of the file a download produces.
 *
 * The warp is capped, the turn is applied, and only then does the shape stretch
 * the page, so this mirrors the renderer step for step. The preview is a
 * separate, smaller render; this is the number the user actually saves.
 */
export function exportSize(
	crop: Size,
	shape: OutputShape,
	orientation: Orientation,
	maxDimension: number,
): Size {
	const longest = Math.max(crop.width, crop.height);
	const scale = longest > maxDimension ? maxDimension / longest : 1;
	const warped = {
		width: Math.max(1, Math.round(crop.width * scale)),
		height: Math.max(1, Math.round(crop.height * scale)),
	};
	// A quarter turn swaps the sides before the shape is applied.
	const page =
		normalizeTurns(orientation.turns) % 2 === 0
			? warped
			: { width: warped.height, height: warped.width };

	switch (shape.kind) {
		case "original":
			return page;
		case "paper":
			return paperTarget(paperSize(shape.id), page, maxDimension);
		case "ratio":
			return ratioTarget(aspectRatio(shape.id), page, maxDimension);
	}
}

/** The name of a shape, for the caption under the result. */
export function shapeLabel(shape: OutputShape): string {
	switch (shape.kind) {
		case "original":
			return "Original size";
		case "paper":
			return paperSize(shape.id).label;
		case "ratio":
			return `${aspectRatio(shape.id).label} ratio`;
	}
}

/**
 * The value a select uses for a shape, and the shape that value stands for.
 *
 * A select carries one string, so the two kinds of shape need a prefix. The
 * round trip is the contract the dropdown relies on.
 */
export function shapeValue(shape: OutputShape): string {
	switch (shape.kind) {
		case "original":
			return "original";
		case "paper":
			return `paper:${shape.id}`;
		case "ratio":
			return `ratio:${shape.id}`;
	}
}

export function shapeFromValue(value: string): OutputShape {
	// Ratio names hold a colon of their own, so split only on the first one.
	const separator = value.indexOf(":");
	const kind = separator === -1 ? value : value.slice(0, separator);
	const id = separator === -1 ? "" : value.slice(separator + 1);

	if (kind === "paper" && isPaperId(id)) return { kind: "paper", id };
	if (kind === "ratio" && isRatioId(id)) return { kind: "ratio", id };
	return { kind: "original" };
}

function isPaperId(value: string | undefined): value is PaperId {
	return PAPER_SIZES.some((size) => size.id === value);
}

function isRatioId(value: string | undefined): value is RatioId {
	return ASPECT_RATIOS.some((ratio) => ratio.id === value);
}

function clamp(value: number, low: number, high: number): number {
	return value < low ? low : value > high ? high : value;
}
