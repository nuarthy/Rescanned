/**
 * Manual adjustments, the sliders under the result.
 *
 * Pure transforms over an `RgbaImage`, like the filters, so the live preview and
 * the download run the same math.
 */

import { LUMA_WEIGHTS, type RgbaImage } from "./pixels";

export interface Adjustments {
	/** All five run from -100 to 100, with 0 meaning "leave it alone". */
	brightness: number;
	contrast: number;
	saturation: number;
	highlights: number;
	shadows: number;
}

export type AdjustmentId = keyof Adjustments;

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
	brightness: 0,
	contrast: 0,
	saturation: 0,
	highlights: 0,
	shadows: 0,
};

export const ADJUSTMENT_SLIDERS: readonly {
	id: AdjustmentId;
	label: string;
}[] = [
	{ id: "brightness", label: "Brightness" },
	{ id: "contrast", label: "Contrast" },
	{ id: "saturation", label: "Saturation" },
	{ id: "highlights", label: "Highlights" },
	{ id: "shadows", label: "Shadows" },
];

export function isNeutral(adjustments: Adjustments): boolean {
	return ADJUSTMENT_SLIDERS.every(({ id }) => adjustments[id] === 0);
}

/** Levels of lift at the end of the brightness slider. */
const BRIGHTNESS_RANGE = 96;
/** Gaussian-free contrast: the multiplier runs from 0 to 2 across the slider. */
const CONTRAST_RANGE = 1;
const SATURATION_RANGE = 1;
/** Levels the tonal sliders move a pixel at their strongest. */
const TONE_RANGE = 80;
/** Luma the tonal sliders leave alone, and where their influence starts. */
const TONE_PIVOT = 110;

/**
 * Apply every adjustment in one pass.
 *
 * The order is the one a photo editor uses: exposure, then contrast, then
 * colour, then the tonal ends. Highlights and shadows keep their weight from the
 * luma after contrast, so they act on the picture the user is already looking
 * at.
 *
 * Handing the image straight back when every slider sits at zero means the
 * common case costs nothing.
 */
export function applyAdjustments(
	image: RgbaImage,
	adjustments: Adjustments,
): RgbaImage {
	if (isNeutral(adjustments)) return image;

	const brightness = (adjustments.brightness / 100) * BRIGHTNESS_RANGE;
	const contrast = 1 + (adjustments.contrast / 100) * CONTRAST_RANGE;
	const saturation = 1 + (adjustments.saturation / 100) * SATURATION_RANGE;
	const highlights = (adjustments.highlights / 100) * TONE_RANGE;
	const shadows = (adjustments.shadows / 100) * TONE_RANGE;

	const source = image.data;
	const data = new Uint8ClampedArray(source.length);

	for (let i = 0; i < source.length; i += 4) {
		let red = source[i] + brightness;
		let green = source[i + 1] + brightness;
		let blue = source[i + 2] + brightness;

		red = (red - 128) * contrast + 128;
		green = (green - 128) * contrast + 128;
		blue = (blue - 128) * contrast + 128;

		const luma =
			LUMA_WEIGHTS.red * red +
			LUMA_WEIGHTS.green * green +
			LUMA_WEIGHTS.blue * blue;

		red = luma + (red - luma) * saturation;
		green = luma + (green - luma) * saturation;
		blue = luma + (blue - luma) * saturation;

		const highlightWeight = clamp01((luma - TONE_PIVOT) / (255 - TONE_PIVOT));
		const shadowWeight = clamp01((TONE_PIVOT - luma) / TONE_PIVOT);
		const lift = highlights * highlightWeight + shadows * shadowWeight;

		data[i] = red + lift;
		data[i + 1] = green + lift;
		data[i + 2] = blue + lift;
		data[i + 3] = source[i + 3];
	}

	return { data, width: image.width, height: image.height };
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}
