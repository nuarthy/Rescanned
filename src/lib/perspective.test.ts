import { describe, expect, it } from "vitest";
import type { Quad } from "./geometry";
import { quadOutputSize, warpQuadToRgba } from "./perspective";
import type { RgbaImage } from "./pixels";

/** A horizontal ramp, so a sampling error shows up as an off-by-one. */
function rampImage(width: number, height: number): RgbaImage {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const p = (y * width + x) * 4;
			data[p] = x;
			data[p + 1] = 40 + y;
			data[p + 2] = 7;
			data[p + 3] = 255;
		}
	}
	return { data, width, height };
}

function pixelAt(image: RgbaImage, x: number, y: number) {
	const p = (y * image.width + x) * 4;
	return [
		image.data[p],
		image.data[p + 1],
		image.data[p + 2],
		image.data[p + 3],
	];
}

describe("quadOutputSize", () => {
	it("takes the longer of each pair of opposite edges", () => {
		const quad: Quad = {
			tl: { x: 0, y: 0 },
			tr: { x: 100, y: 0 },
			br: { x: 120, y: 60 },
			bl: { x: 0, y: 60 },
		};
		// Width comes from the longer bottom edge (120) and height from the
		// longer right edge, sqrt(20^2 + 60^2) = 63.2.
		expect(quadOutputSize(quad)).toEqual({ width: 120, height: 63 });
	});
});

describe("warpQuadToRgba", () => {
	it("leaves the image untouched when the quad is the whole frame", () => {
		const source = rampImage(64, 48);
		const quad: Quad = {
			tl: { x: -0.5, y: -0.5 },
			tr: { x: 63.5, y: -0.5 },
			br: { x: 63.5, y: 47.5 },
			bl: { x: -0.5, y: 47.5 },
		};

		const warped = warpQuadToRgba(source, quad);
		expect(warped.width).toBe(64);
		expect(warped.height).toBe(48);
		expect(Array.from(warped.data)).toEqual(Array.from(source.data));
	});

	it("maps a sub-rectangle to its own smaller frame", () => {
		const source = rampImage(64, 48);
		const quad: Quad = {
			tl: { x: 10, y: 8 },
			tr: { x: 50, y: 8 },
			br: { x: 50, y: 38 },
			bl: { x: 10, y: 38 },
		};

		const warped = warpQuadToRgba(source, quad);
		expect(warped.width).toBe(40);
		expect(warped.height).toBe(30);

		// The mapping lands within one pixel of the source region, so the ramp
		// value may differ by one where bilinear sampling blends neighbours.
		for (const [x, y] of [
			[0, 0],
			[39, 0],
			[0, 29],
			[39, 29],
			[20, 15],
		]) {
			const expected = pixelAt(source, x + 10, y + 8);
			const actual = pixelAt(warped, x, y);
			expect(Math.abs(actual[0] - expected[0])).toBeLessThanOrEqual(2);
			expect(Math.abs(actual[1] - expected[1])).toBeLessThanOrEqual(2);
		}
	});

	it("scales the output down to the size cap", () => {
		const source = rampImage(200, 200);
		const quad: Quad = {
			tl: { x: 0, y: 0 },
			tr: { x: 200, y: 0 },
			br: { x: 200, y: 200 },
			bl: { x: 0, y: 200 },
		};
		const warped = warpQuadToRgba(source, quad, 50);
		expect(Math.max(warped.width, warped.height)).toBe(50);
	});

	it("returns a blank image rather than throwing on a degenerate quad", () => {
		const source = rampImage(32, 32);
		const quad: Quad = {
			tl: { x: 5, y: 5 },
			tr: { x: 5, y: 5 },
			br: { x: 5, y: 5 },
			bl: { x: 5, y: 5 },
		};
		const warped = warpQuadToRgba(source, quad);
		expect(warped.width).toBe(1);
		expect(warped.height).toBe(1);
		expect(warped.data.length).toBe(4);
	});
});
