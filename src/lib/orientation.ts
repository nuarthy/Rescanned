/**
 * Turning and mirroring the page.
 *
 * The crop editor draws the photo turned and mirrored, so the buttons show what
 * they did, while the stored corners stay in the photo's own coordinates. The
 * renderer applies the same turn to the corrected page, so the preview, the
 * download, and the crop overlay always agree.
 *
 * Numbers and pixels only, like the filters, so the worker, the page, and the
 * tests run the same code.
 */

import type { RgbaImage } from "./pixels";

export interface Orientation {
	/** Quarter turns clockwise: 0, 1, 2, or 3. */
	turns: number;
	flipHorizontal: boolean;
	flipVertical: boolean;
}

export const UPRIGHT: Orientation = {
	turns: 0,
	flipHorizontal: false,
	flipVertical: false,
};

export function isUpright(orientation: Orientation): boolean {
	return (
		normalizeTurns(orientation.turns) === 0 &&
		!orientation.flipHorizontal &&
		!orientation.flipVertical
	);
}

export function normalizeTurns(turns: number): number {
	return ((turns % 4) + 4) % 4;
}

export interface Size {
	width: number;
	height: number;
}

/** Size of the photo once the turn is applied. */
export function orientedSize(size: Size, orientation: Orientation): Size {
	return normalizeTurns(orientation.turns) % 2 === 0
		? { width: size.width, height: size.height }
		: { width: size.height, height: size.width };
}

export interface Point {
	x: number;
	y: number;
}

/**
 * A point in the photo's coordinates, as the turned photo shows it.
 *
 * Turn first, then mirror, which is the order the buttons apply them in.
 */
export function toDisplayPoint(
	point: Point,
	size: Size,
	orientation: Orientation,
): Point {
	const turns = normalizeTurns(orientation.turns);
	let { x, y } = point;
	if (turns === 1) [x, y] = [size.height - y, x];
	if (turns === 2) [x, y] = [size.width - x, size.height - y];
	if (turns === 3) [x, y] = [y, size.width - x];

	const display = orientedSize(size, orientation);
	return {
		x: orientation.flipHorizontal ? display.width - x : x,
		y: orientation.flipVertical ? display.height - y : y,
	};
}

/** The inverse of `toDisplayPoint`, for turning a finger position back. */
export function toPhotoPoint(
	point: Point,
	size: Size,
	orientation: Orientation,
): Point {
	const display = orientedSize(size, orientation);
	let { x, y } = point;
	if (orientation.flipHorizontal) x = display.width - x;
	if (orientation.flipVertical) y = display.height - y;

	const turns = normalizeTurns(orientation.turns);
	if (turns === 1) [x, y] = [y, size.height - x];
	if (turns === 2) [x, y] = [size.width - x, size.height - y];
	if (turns === 3) [x, y] = [size.width - y, x];
	return { x, y };
}

/** The same turn and mirror, applied to the corrected page's pixels. */
export function orientRgba(
	image: RgbaImage,
	orientation: Orientation,
): RgbaImage {
	if (isUpright(orientation)) return image;

	const turns = normalizeTurns(orientation.turns);
	// Turn first, then mirror, which is the order `toDisplayPoint` uses.
	const turned = turns === 0 ? image : rotateRgba(image, turns);
	return mirrorRgba(
		turned,
		orientation.flipHorizontal,
		orientation.flipVertical,
	);
}

function mirrorRgba(
	image: RgbaImage,
	horizontal: boolean,
	vertical: boolean,
): RgbaImage {
	if (!horizontal && !vertical) return image;

	const { width, height } = image;
	const data = new Uint8ClampedArray(image.data.length);
	for (let y = 0; y < height; y += 1) {
		const sourceY = vertical ? height - 1 - y : y;
		for (let x = 0; x < width; x += 1) {
			const sourceX = horizontal ? width - 1 - x : x;
			const from = (sourceY * width + sourceX) * 4;
			const to = (y * width + x) * 4;
			data[to] = image.data[from];
			data[to + 1] = image.data[from + 1];
			data[to + 2] = image.data[from + 2];
			data[to + 3] = image.data[from + 3];
		}
	}
	return { data, width, height };
}

/** Quarter turns clockwise. */
function rotateRgba(image: RgbaImage, turns: number): RgbaImage {
	const { width, height, data } = image;
	const quarter = normalizeTurns(turns);

	if (quarter === 2) {
		const flipped = new Uint8ClampedArray(data.length);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const from = (y * width + x) * 4;
				const to = ((height - 1 - y) * width + (width - 1 - x)) * 4;
				flipped[to] = data[from];
				flipped[to + 1] = data[from + 1];
				flipped[to + 2] = data[from + 2];
				flipped[to + 3] = data[from + 3];
			}
		}
		return { data: flipped, width, height };
	}

	const output = new Uint8ClampedArray(data.length);
	const outWidth = height;
	const outHeight = width;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const from = (y * width + x) * 4;
			// Clockwise sends (x, y) to (height - 1 - y, x); a quarter turn
			// anticlockwise sends it to (y, width - 1 - x).
			const toX = quarter === 1 ? height - 1 - y : y;
			const toY = quarter === 1 ? x : width - 1 - x;
			const to = (toY * outWidth + toX) * 4;
			output[to] = data[from];
			output[to + 1] = data[from + 1];
			output[to + 2] = data[from + 2];
			output[to + 3] = data[from + 3];
		}
	}
	return { data: output, width: outWidth, height: outHeight };
}
