import { describe, expect, it } from "vitest";

import {
	normalizeTurns,
	type Orientation,
	orientedSize,
	orientRgba,
	toDisplayPoint,
	toPhotoPoint,
	UPRIGHT,
} from "./orientation";
import type { RgbaImage } from "./pixels";

const SIZE = { width: 4, height: 2 };

/** A two pixel wide image: one red pixel, one blue. */
function strip(): RgbaImage {
	return {
		width: 2,
		height: 1,
		data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]),
	};
}

function pixelAt(image: RgbaImage, x: number, y: number): number[] {
	const offset = (y * image.width + x) * 4;
	return Array.from(image.data.slice(offset, offset + 4));
}

const ORIENTATIONS: Orientation[] = [];
for (let turns = 0; turns < 4; turns += 1) {
	for (const flipHorizontal of [false, true]) {
		for (const flipVertical of [false, true]) {
			ORIENTATIONS.push({ turns, flipHorizontal, flipVertical });
		}
	}
}

describe("normalizeTurns", () => {
	it("wraps negatives and overflow", () => {
		expect(normalizeTurns(-1)).toBe(3);
		expect(normalizeTurns(5)).toBe(1);
		expect(normalizeTurns(0)).toBe(0);
	});
});

describe("orientedSize", () => {
	it("swaps the sides on a quarter turn", () => {
		expect(orientedSize(SIZE, { ...UPRIGHT, turns: 1 })).toEqual({
			width: 2,
			height: 4,
		});
		expect(orientedSize(SIZE, { ...UPRIGHT, turns: 2 })).toEqual(SIZE);
	});
});

describe("point mapping", () => {
	it("round trips every turn and mirror", () => {
		for (const orientation of ORIENTATIONS) {
			for (const point of [
				{ x: 0, y: 0 },
				{ x: 4, y: 2 },
				{ x: 1, y: 1.5 },
			]) {
				const displayed = toDisplayPoint(point, SIZE, orientation);
				const back = toPhotoPoint(displayed, SIZE, orientation);
				expect(back.x).toBeCloseTo(point.x, 6);
				expect(back.y).toBeCloseTo(point.y, 6);
			}
		}
	});

	it("sends the top left corner round with the photo", () => {
		const turned = toDisplayPoint({ x: 0, y: 0 }, SIZE, {
			...UPRIGHT,
			turns: 1,
		});
		expect(turned).toEqual({ x: 2, y: 0 });
	});
});

describe("orientRgba", () => {
	it("hands the page back untouched when upright", () => {
		const image = strip();
		expect(orientRgba(image, UPRIGHT)).toBe(image);
	});

	it("turns clockwise, so the left edge becomes the top", () => {
		const turned = orientRgba(strip(), { ...UPRIGHT, turns: 1 });
		expect(turned.width).toBe(1);
		expect(turned.height).toBe(2);
		// The red pixel was on the left; after a clockwise turn it is on top.
		expect(pixelAt(turned, 0, 0)).toEqual([255, 0, 0, 255]);
		expect(pixelAt(turned, 0, 1)).toEqual([0, 0, 255, 255]);
	});

	it("turns anticlockwise", () => {
		const turned = orientRgba(strip(), { ...UPRIGHT, turns: 3 });
		expect(turned.width).toBe(1);
		expect(turned.height).toBe(2);
		expect(pixelAt(turned, 0, 0)).toEqual([0, 0, 255, 255]);
		expect(pixelAt(turned, 0, 1)).toEqual([255, 0, 0, 255]);
	});

	it("mirrors horizontally", () => {
		const flipped = orientRgba(strip(), {
			...UPRIGHT,
			flipHorizontal: true,
		});
		expect(pixelAt(flipped, 0, 0)).toEqual([0, 0, 255, 255]);
		expect(pixelAt(flipped, 1, 0)).toEqual([255, 0, 0, 255]);
	});

	it("mirrors vertically", () => {
		const image: RgbaImage = {
			width: 1,
			height: 2,
			data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]),
		};
		const flipped = orientRgba(image, { ...UPRIGHT, flipVertical: true });
		expect(pixelAt(flipped, 0, 0)).toEqual([0, 0, 255, 255]);
		expect(pixelAt(flipped, 0, 1)).toEqual([255, 0, 0, 255]);
	});

	it("returns to the original after four quarter turns", () => {
		const image: RgbaImage = {
			width: 3,
			height: 2,
			data: new Uint8ClampedArray(
				Array.from({ length: 3 * 2 * 4 }, (_, index) => (index * 37) % 256),
			),
		};
		let turned = image;
		for (let i = 0; i < 4; i += 1) {
			turned = orientRgba(turned, { ...UPRIGHT, turns: 1 });
		}
		expect(turned.width).toBe(image.width);
		expect(turned.height).toBe(image.height);
		expect(Array.from(turned.data)).toEqual(Array.from(image.data));
	});
});
