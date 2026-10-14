/**
 * Page filters, applied to the corrected page.
 *
 * Each filter is a pure transform of an `RgbaImage`, so the same code feeds the
 * live preview and the downloaded file. Nothing here touches the DOM, which
 * keeps it testable and worker-friendly.
 */

import {
	boxBlur,
	type GrayImage,
	LUMA_WEIGHTS,
	otsuThreshold,
	type RgbaImage,
	toGray,
} from "./pixels";

export type DocumentFilter =
	| "original"
	| "lighten"
	| "no-shadow"
	| "black-white"
	| "high-contrast";

export interface FilterOption {
	id: DocumentFilter;
	label: string;
}

export const DOCUMENT_FILTERS: readonly FilterOption[] = [
	{ id: "original", label: "Original" },
	{ id: "lighten", label: "Lighten" },
	{ id: "no-shadow", label: "No shadow" },
	{ id: "black-white", label: "Black & white" },
	{ id: "high-contrast", label: "High contrast B&W" },
];

/**
 * White point for lighten, as a share of 255.
 *
 * A gamma lift would also wash out the ink, and on a scan the ink has to stay
 * black. Stretching the top of the range instead drives the paper to pure
 * white, adds apparent brightness, and leaves dark text where it is.
 */
const LIGHTEN_WHITE_POINT = 0.84;

/** Level the paper is pushed toward when the lighting is flattened. */
const PAPER_TARGET = 240;
/**
 * Limits on the per-channel white balance. Real colour casts are mild, so a
 * wider gain than this means the estimate caught something that is not paper.
 */
const MIN_WHITE_BALANCE = 0.6;
const MAX_WHITE_BALANCE = 1.8;
/**
 * Tonal ends of the contrast stretch applied after flattening, as shares of
 * 255.
 *
 * The black point drives the ink to near black. The white point sits well below
 * the paper level on purpose: everything at or above it clips to pure white, so
 * paper, light smudges and any leftover shading all come out white instead of
 * holding a grey cast.
 */
const CONTRAST_BLACK_POINT = 0.16;
const CONTRAST_WHITE_POINT = 0.78;
/** How far chroma is pushed away from the neutral axis, to liven up colour. */
const SATURATION_BOOST = 1.45;
/** Gain limits, so a dark or noisy patch cannot be blown up into noise. */
const MIN_GAIN = 0.25;
const MAX_GAIN = 5;
/** Blur radius that smooths past text and only sees the local paper level. */
function backgroundRadius(image: RgbaImage): number {
	return Math.max(2, Math.round(Math.max(image.width, image.height) / 16));
}

export function applyFilter(
	image: RgbaImage,
	filter: DocumentFilter,
): RgbaImage {
	switch (filter) {
		case "original":
			return image;
		case "lighten":
			return applyLighten(image);
		case "no-shadow":
			return applyNoShadow(image);
		case "black-white":
			return applyBlackAndWhite(image);
		case "high-contrast":
			return applyHighContrast(image);
	}
}

/**
 * Per-pixel gain that flattens uneven lighting.
 *
 * The background is the local paper level, estimated by blurring well past the
 * size of a stroke of text. Dividing by it removes shadows and gradients; the
 * clamp keeps a dark patch from being multiplied into noise.
 */
function illuminationGain(image: RgbaImage): Float32Array {
	const gray = toGray(image);
	// One box pass is plenty: the radius is wide enough that the result is a
	// smooth estimate of the local paper level, and a second pass would double
	// the cost of every download.
	const background = boxBlur(gray, backgroundRadius(image), 1);
	const gain = new Float32Array(gray.data.length);

	for (let i = 0; i < gain.length; i += 1) {
		const level = Math.max(4, background.data[i]);
		gain[i] = Math.min(MAX_GAIN, Math.max(MIN_GAIN, PAPER_TARGET / level));
	}

	return gain;
}

function applyLighten(image: RgbaImage): RgbaImage {
	const data = new Uint8ClampedArray(image.data.length);
	const scale = 1 / LIGHTEN_WHITE_POINT;

	for (let i = 0; i < data.length; i += 4) {
		data[i] = image.data[i] * scale;
		data[i + 1] = image.data[i + 1] * scale;
		data[i + 2] = image.data[i + 2] * scale;
		data[i + 3] = image.data[i + 3];
	}

	return { data, width: image.width, height: image.height };
}

/**
 * Flatten the lighting one channel at a time, then add contrast and colour.
 *
 * Dividing each channel by its own local background does two jobs at once. It
 * removes shadows and gradients, and it neutralises the colour cast of the
 * paper, so a board photographed under warm light comes out white rather than
 * beige. A single luminance gain cannot do the second, which is why the page
 * used to keep its tint.
 */
function applyNoShadow(image: RgbaImage): RgbaImage {
	return enhance(flattenLighting(image), image.width, image.height);
}

/**
 * The paper level of each channel, taken from the bright end of the histogram.
 *
 * A white sheet under a warm lamp is brighter in red than in blue, and those
 * levels are what the balance below divides out.
 */
function paperLevels(image: RgbaImage): [number, number, number] {
	const { data } = image;
	const pixels = data.length / 4;
	const stride = Math.max(1, Math.floor(pixels / 20000));
	const levels: [number, number, number] = [0, 0, 0];

	for (let channel = 0; channel < 3; channel += 1) {
		const samples: number[] = [];
		for (let i = 0, p = channel; i < pixels; i += stride, p += stride * 4) {
			samples.push(data[p]);
		}
		samples.sort((a, b) => a - b);
		levels[channel] = samples[Math.round(0.95 * (samples.length - 1))];
	}

	return levels;
}

/**
 * Neutralise the colour of the paper, then flatten the lighting.
 *
 * The balance per channel is what turns a sheet photographed warm into white,
 * and it scales colours rather than removing them, so a large coloured area
 * keeps its saturation. The luminance gain that follows is what removes
 * shadows and gradients.
 */
function flattenLighting(image: RgbaImage): Uint8ClampedArray {
	const { width, height, data } = image;
	const pixels = width * height;
	const radius = backgroundRadius(image);
	const levels = paperLevels(image);

	const data0 = data;
	const balance: [number, number, number] = [1, 1, 1];
	for (let channel = 0; channel < 3; channel += 1) {
		const level = Math.max(4, levels[channel]);
		balance[channel] = Math.min(
			MAX_WHITE_BALANCE,
			Math.max(MIN_WHITE_BALANCE, PAPER_TARGET / level),
		);
	}

	const balanced = new Uint8ClampedArray(data0.length);
	for (let p = 0; p < balanced.length; p += 4) {
		balanced[p] = data0[p] * balance[0];
		balanced[p + 1] = data0[p + 1] * balance[1];
		balanced[p + 2] = data0[p + 2] * balance[2];
		balanced[p + 3] = data0[p + 3];
	}

	const gray = toGray({ data: balanced, width, height });
	const background = boxBlur(gray, radius, 1);

	for (let i = 0, p = 0; i < pixels; i += 1, p += 4) {
		const level = Math.max(4, background.data[i]);
		const gain = Math.min(MAX_GAIN, Math.max(MIN_GAIN, PAPER_TARGET / level));
		balanced[p] = balanced[p] * gain;
		balanced[p + 1] = balanced[p + 1] * gain;
		balanced[p + 2] = balanced[p + 2] * gain;
	}

	return balanced;
}

/**
 * One tonal curve for lightness, with chroma scaled around it.
 *
 * Keeping lightness and colour apart means the ink deepens and colours gain
 * vividness without either dragging the other along.
 */
function enhance(
	data: Uint8ClampedArray,
	width: number,
	height: number,
): RgbaImage {
	const output = new Uint8ClampedArray(data.length);
	const blackPoint = CONTRAST_BLACK_POINT * 255;
	const whiteSpan = (CONTRAST_WHITE_POINT - CONTRAST_BLACK_POINT) * 255;

	for (let p = 0; p < data.length; p += 4) {
		const red = data[p];
		const green = data[p + 1];
		const blue = data[p + 2];

		const lightness =
			LUMA_WEIGHTS.red * red +
			LUMA_WEIGHTS.green * green +
			LUMA_WEIGHTS.blue * blue;
		const stretched = ((lightness - blackPoint) / whiteSpan) * 255;

		output[p] = stretched + (red - lightness) * SATURATION_BOOST;
		output[p + 1] = stretched + (green - lightness) * SATURATION_BOOST;
		output[p + 2] = stretched + (blue - lightness) * SATURATION_BOOST;
		output[p + 3] = data[p + 3];
	}

	return { data: output, width, height };
}

/** Plain grayscale, on the luma weights. */
function applyBlackAndWhite(image: RgbaImage): RgbaImage {
	const gray = toGray(image);
	const data = new Uint8ClampedArray(image.data.length);

	for (let i = 0, p = 0; i < gray.data.length; i += 1, p += 4) {
		const value = gray.data[i];
		data[p] = value;
		data[p + 1] = value;
		data[p + 2] = value;
		data[p + 3] = image.data[p + 3];
	}

	return { data, width: image.width, height: image.height };
}

/**
 * Two levels of black and white.
 *
 * The lighting is flattened first, otherwise a shadow becomes a black blob and
 * carries the threshold with it. Then Otsu splits the flattened page into pure
 * black and pure white, which is the look of a photocopied document.
 */
function applyHighContrast(image: RgbaImage): RgbaImage {
	const gray = toGray(image);
	const gain = illuminationGain(image);
	const flattened: GrayImage = {
		data: new Float32Array(gray.data.length),
		width: gray.width,
		height: gray.height,
	};

	for (let i = 0; i < flattened.data.length; i += 1) {
		flattened.data[i] = Math.min(255, gray.data[i] * gain[i]);
	}

	const threshold = otsuThreshold(flattened);
	const data = new Uint8ClampedArray(image.data.length);

	for (let i = 0, p = 0; i < flattened.data.length; i += 1, p += 4) {
		const value = flattened.data[i] >= threshold ? 255 : 0;
		data[p] = value;
		data[p + 1] = value;
		data[p + 2] = value;
		data[p + 3] = image.data[p + 3];
	}

	return { data, width: image.width, height: image.height };
}
