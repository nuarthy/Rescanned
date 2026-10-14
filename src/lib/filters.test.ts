import { describe, expect, it } from "vitest";

import { applyFilter, DOCUMENT_FILTERS, type DocumentFilter } from "./filters";
import { LUMA_WEIGHTS, type RgbaImage } from "./pixels";

function makeImage(
	width: number,
	height: number,
	shade: (x: number, y: number) => number,
): RgbaImage {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const value = shade(x, y);
			const p = (y * width + x) * 4;
			data[p] = value;
			data[p + 1] = value;
			data[p + 2] = value;
			data[p + 3] = 255;
		}
	}
	return { data, width, height };
}

const luma = (image: RgbaImage, x: number, y: number): number =>
	image.data[(y * image.width + x) * 4];

/** Mean and standard deviation of the luminance over a rectangle. */
function stats(
	image: RgbaImage,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): { mean: number; deviation: number } {
	let sum = 0;
	let sumSquares = 0;
	let count = 0;
	for (let y = y0; y < y1; y += 1) {
		for (let x = x0; x < x1; x += 1) {
			const value = luma(image, x, y);
			sum += value;
			sumSquares += value * value;
			count += 1;
		}
	}
	const mean = sum / count;
	return { mean, deviation: Math.sqrt(sumSquares / count - mean * mean) };
}

/**
 * A page photographed under a shadow: the paper runs from 140 on the left to
 * 220 on the right, with dark text across the middle rows.
 */
const TEXT_ROWS = [50, 60];
function shadowedPage(): RgbaImage {
	return makeImage(200, 120, (x, y) => {
		const inTextRow = TEXT_ROWS.some((row) => y >= row && y < row + 8);
		const inTextSpan = x >= 30 && x < 170;
		if (inTextRow && inTextSpan) return 40;
		return 140 + (80 * x) / 199;
	});
}

describe("DOCUMENT_FILTERS", () => {
	it("offers every filter, starting with the untouched image", () => {
		expect(DOCUMENT_FILTERS.map((option) => option.id)).toEqual([
			"original",
			"lighten",
			"no-shadow",
			"black-white",
			"high-contrast",
		]);
		expect(DOCUMENT_FILTERS[0].label).toBe("Original");
	});
});

describe("applyFilter", () => {
	const ids: DocumentFilter[] = [
		"original",
		"lighten",
		"no-shadow",
		"black-white",
		"high-contrast",
	];

	it("keeps the size and the alpha channel for every filter", () => {
		const source = shadowedPage();
		for (const id of ids) {
			const result = applyFilter(source, id);
			expect(result.width, id).toBe(source.width);
			expect(result.height, id).toBe(source.height);
			expect(result.data.length, id).toBe(source.data.length);
			for (let p = 3; p < result.data.length; p += 4) {
				expect(result.data[p], id).toBe(255);
			}
		}
	});

	it("returns the image untouched for original", () => {
		const source = shadowedPage();
		expect(applyFilter(source, "original")).toBe(source);
	});

	it("does not modify the image it was given", () => {
		const source = shadowedPage();
		const before = Array.from(source.data);
		for (const id of ids) applyFilter(source, id);
		expect(Array.from(source.data)).toEqual(before);
	});
});

describe("lighten", () => {
	it("drives paper to white and leaves black at black", () => {
		const source = makeImage(4, 1, (x) => [0, 120, 214, 240][x]);
		const result = applyFilter(source, "lighten");
		expect(luma(result, 0, 0)).toBe(0);
		expect(luma(result, 1, 0)).toBeGreaterThan(120);
		expect(luma(result, 2, 0)).toBe(255);
		expect(luma(result, 3, 0)).toBe(255);
	});

	it("raises the average brightness of a page", () => {
		const source = shadowedPage();
		const result = applyFilter(source, "lighten");
		expect(stats(result, 0, 0, 200, 40).mean).toBeGreaterThan(
			stats(source, 0, 0, 200, 40).mean,
		);
	});
});

describe("black-white", () => {
	it("writes the same value to all three channels", () => {
		const source = shadowedPage();
		// Give one pixel a strong colour cast to prove it is desaturated.
		source.data[0] = 200;
		source.data[1] = 40;
		source.data[2] = 90;

		const result = applyFilter(source, "black-white");
		for (let p = 0; p < result.data.length; p += 4) {
			expect(result.data[p]).toBe(result.data[p + 1]);
			expect(result.data[p]).toBe(result.data[p + 2]);
		}
		expect(luma(result, 0, 0)).toBeCloseTo(
			0.299 * 200 + 0.587 * 40 + 0.114 * 90,
			0,
		);
	});
});

/**
 * Distance between the strongest and weakest channel of one pixel.
 *
 * The usual HSV saturation ratio is misleading here: once the boost pushes the
 * brightest channel into the 255 limit, the ratio can fall while the colour is
 * visibly stronger. The spread keeps growing, so it is the honest measure.
 */
function chromaSpread(image: RgbaImage, x: number, y: number): number {
	const p = (y * image.width + x) * 4;
	return (
		Math.max(image.data[p], image.data[p + 1], image.data[p + 2]) -
		Math.min(image.data[p], image.data[p + 1], image.data[p + 2])
	);
}

/** White paper under a warm lamp: red runs brighter than blue. */
function warmPage(): RgbaImage {
	const width = 200;
	const height = 240;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const onInk = y >= 110 && y < 118 && x >= 30 && x < 170;
			const p = (y * width + x) * 4;
			data[p] = onInk ? 40 : 250;
			data[p + 1] = onInk ? 32 : 235;
			data[p + 2] = onInk ? 28 : 205;
			data[p + 3] = 255;
		}
	}
	return { data, width, height };
}

/** White paper with a faint smudge, the print a thumb leaves behind. */
function smudgedPage(): RgbaImage {
	const width = 200;
	const height = 240;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const onSmudge = y >= 40 && y < 70 && x >= 40 && x < 160;
			const p = (y * width + x) * 4;
			const value = onSmudge ? 200 : 235;
			data[p] = value;
			data[p + 1] = value;
			data[p + 2] = value;
			data[p + 3] = 255;
		}
	}
	return { data, width, height };
}

/** Percentile spread of the luminance, as a simple measure of contrast. */
function tonalRange(image: RgbaImage): number {
	const values: number[] = [];
	for (let i = 0; i < image.data.length; i += 4) {
		values.push(
			LUMA_WEIGHTS.red * image.data[i] +
				LUMA_WEIGHTS.green * image.data[i + 1] +
				LUMA_WEIGHTS.blue * image.data[i + 2],
		);
	}
	values.sort((a, b) => a - b);
	const at = (share: number) => values[Math.round(share * (values.length - 1))];
	// Wide percentiles, because the ink in these fixtures is a small share of
	// the pixels and must still fall inside the measured span.
	return at(0.99) - at(0.01);
}

/**
 * Evenly lit white paper with a single ink band.
 *
 * One band, spaced well apart, keeps the background blur from mixing ink into
 * the paper level, which is what a page with ordinary line spacing looks like.
 */
function flatPage(ink: number): RgbaImage {
	const width = 200;
	const height = 240;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const onInk = y >= 110 && y < 118 && x >= 30 && x < 170;
			const p = (y * width + x) * 4;
			data[p] = onInk ? ink : 240;
			data[p + 1] = onInk ? ink : 240;
			data[p + 2] = onInk ? ink : 240;
			data[p + 3] = 255;
		}
	}
	return { data, width, height };
}

/** The ink band in `flatPage`, as a row and a column to sample. */
const FLAT_INK_Y = 114;
const FLAT_INK_X = 100;

/** White paper with a saturated colour band across the text rows. */
function colouredPage(): RgbaImage {
	const data = new Uint8ClampedArray(200 * 120 * 4);
	for (let y = 0; y < 120; y += 1) {
		for (let x = 0; x < 200; x += 1) {
			const inBand = TEXT_ROWS.some((row) => y >= row && y < row + 8);
			const inSpan = x >= 30 && x < 170;
			const p = (y * 200 + x) * 4;
			const coloured = inBand && inSpan;
			data[p] = coloured ? 210 : 240;
			data[p + 1] = coloured ? 60 : 240;
			data[p + 2] = coloured ? 60 : 240;
			data[p + 3] = 255;
		}
	}
	return { data, width: 200, height: 120 };
}

describe("no-shadow", () => {
	it("flattens a lighting gradient while keeping the ink dark", () => {
		const source = shadowedPage();
		const result = applyFilter(source, "no-shadow");

		const before = stats(source, 0, 0, 200, 40);
		const after = stats(result, 0, 0, 200, 40);
		expect(before.deviation).toBeGreaterThan(20);
		expect(after.deviation).toBeLessThan(10);
		expect(after.mean).toBeGreaterThan(200);

		const ink = stats(result, 30, TEXT_ROWS[0], 170, TEXT_ROWS[0] + 8);
		expect(ink.mean).toBeLessThan(after.mean - 60);
	});

	it("adds contrast, so the ink deepens instead of washing out", () => {
		// A page of ordinary printed ink: flattening alone would lift this to
		// about 42, and the tonal stretch has to take it back below the source.
		const page = flatPage(30);
		const result = applyFilter(page, "no-shadow");

		expect(luma(result, FLAT_INK_X, FLAT_INK_Y)).toBeLessThan(30);
		expect(tonalRange(result)).toBeGreaterThan(tonalRange(page));
		// The lit paper is pinned to white.
		expect(luma(result, 5, 5)).toBe(255);
	});

	it("boosts saturation without turning hue", () => {
		const page = colouredPage();
		const result = applyFilter(page, "no-shadow");
		const row = TEXT_ROWS[0] + 2;

		expect(chromaSpread(result, 100, row)).toBeGreaterThan(
			chromaSpread(page, 100, row),
		);

		const p = (row * result.width + 100) * 4;
		expect(result.data[p]).toBeGreaterThan(result.data[p + 1]);
		// Green and blue stay equal, so the hue is untouched.
		expect(result.data[p + 1]).toBe(result.data[p + 2]);
	});

	it("turns paper white whatever colour the light was", () => {
		const page = warmPage();
		const result = applyFilter(page, "no-shadow");
		// Sample lit paper, away from the ink band.
		const p = (20 * result.width + 100) * 4;
		expect(result.data[p]).toBe(result.data[p + 1]);
		expect(result.data[p + 1]).toBe(result.data[p + 2]);
		expect(result.data[p]).toBeGreaterThanOrEqual(250);
	});

	it("clears a faint smudge instead of darkening it", () => {
		const page = smudgedPage();
		const result = applyFilter(page, "no-shadow");
		expect(luma(result, 100, 55)).toBe(255);
		expect(luma(result, 100, 20)).toBe(255);
	});
});

describe("high-contrast", () => {
	it("produces nothing but black and white", () => {
		const source = shadowedPage();
		const result = applyFilter(source, "high-contrast");
		for (let p = 0; p < result.data.length; p += 4) {
			expect([0, 255]).toContain(result.data[p]);
		}
	});

	it("does not turn a shadow into a black blob", () => {
		const source = shadowedPage();
		const result = applyFilter(source, "high-contrast");

		// The darkest corner of the page is shadow, not ink, so it must be white.
		expect(luma(result, 2, 2)).toBe(255);
		expect(luma(result, 2, 110)).toBe(255);
		expect(luma(result, 197, 2)).toBe(255);
		// The text rows must come out black.
		expect(luma(result, 100, TEXT_ROWS[0] + 2)).toBe(0);
	});
});
