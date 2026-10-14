import { describe, expect, it } from "vitest";

import {
	detectDocumentQuad,
	detectDocumentQuadOrFallback,
	findCandidates,
} from "./detect";
import {
	orderQuad,
	type Point,
	type Quad,
	quadBorderInset,
	quadPoints,
} from "./geometry";
import type { RgbaImage } from "./pixels";

/** Deterministic pseudo-random source, so a failing case always repeats. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pointInPolygon(
	x: number,
	y: number,
	polygon: readonly Point[],
): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
		const a = polygon[i];
		const b = polygon[j];
		const crosses =
			a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
		if (crosses) inside = !inside;
	}
	return inside;
}

interface SceneOptions {
	width: number;
	height: number;
	page: readonly Point[];
	background?: number;
	paper?: number;
	ink?: number;
	seed?: number;
}

/**
 * A synthetic photo of a printed page: noisy surface, brighter page, dark text.
 *
 * Values are chosen so the page separates cleanly from the surface, which is
 * the case the detector is expected to handle.
 */
function photoOfDocument({
	width,
	height,
	page,
	background = 70,
	paper = 235,
	ink = 45,
	seed = 7,
}: SceneOptions): RgbaImage {
	const data = new Uint8ClampedArray(width * height * 4);
	const randomValue = random(seed);

	const write = (index: number, value: number) => {
		const p = index * 4;
		data[p] = value;
		data[p + 1] = value;
		data[p + 2] = value;
		data[p + 3] = 255;
	};

	const minX = Math.min(...page.map((point) => point.x));
	const maxX = Math.max(...page.map((point) => point.x));
	const minY = Math.min(...page.map((point) => point.y));
	const maxY = Math.max(...page.map((point) => point.y));
	const lineHeight = (maxY - minY) / 55;

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const index = y * width + x;
			const centreX = x + 0.5;
			const centreY = y + 0.5;

			if (!pointInPolygon(centreX, centreY, page)) {
				write(index, background + (randomValue() - 0.5) * 26);
				continue;
			}

			const lines = 8;
			const band = (maxY - minY) / (lines + 1);
			const offsetInBand = centreY - (minY + band);
			const positionInBand = offsetInBand % band;
			const onText =
				positionInBand >= 0 &&
				positionInBand < lineHeight &&
				centreX > minX + (maxX - minX) * 0.12 &&
				centreX < maxX - (maxX - minX) * 0.12;

			write(
				index,
				onText
					? ink + (randomValue() - 0.5) * 20
					: paper + (randomValue() - 0.5) * 14,
			);
		}
	}

	return { data, width, height };
}

/**
 * A whiteboard on a wall: a bright board carrying dark writing, framed by a thin
 * dark line, hung on a wall only a shade darker, with a dark poster covering its
 * top edge and a dark desk across the bottom.
 *
 * This is the pattern that used to produce a confident crop hugging the frame:
 * brightness cannot separate the board from the wall, the wall reaches the
 * frame's borders, and the strongest ridges belong to the writing and the
 * poster. Nothing here is enough to place four corners with confidence.
 */
function brightBoardOnBrightWall(): RgbaImage {
	const width = 640;
	const height = 480;
	const data = new Uint8ClampedArray(width * height * 4);
	const randomValue = random(31);

	const board = { left: 100, right: 560, top: 45, bottom: 415 };
	const poster = { left: 140, right: 542, top: 0, bottom: 150 };
	const desk = 430;

	const inside = (
		x: number,
		y: number,
		box: { left: number; right: number; top: number; bottom: number },
	) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			let value: number;

			if (y >= desk) {
				value = 70;
			} else if (inside(x, y, poster)) {
				value = 78;
			} else if (inside(x, y, board)) {
				const onFrame =
					x < board.left + 4 ||
					x > board.right - 4 ||
					y < board.top + 4 ||
					y > board.bottom - 4;
				// Writing: thin dark bars, dense enough to cover most of the board.
				const onWriting = !onFrame && y % 14 < 4 && x % 23 > 2 && x % 23 < 19;
				value = onFrame ? 66 : onWriting ? 92 : 205;
			} else {
				value = 196;
			}

			const p = (y * width + x) * 4;
			const noisy = value + (randomValue() - 0.5) * 8;
			data[p] = noisy;
			data[p + 1] = noisy;
			data[p + 2] = noisy;
			data[p + 3] = 255;
		}
	}

	return { data, width, height };
}

function cornerDistance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function expectQuadCloseTo(actual: Quad, expected: Quad, tolerance: number) {
	const actualPoints = quadPoints(actual);
	const expectedPoints = quadPoints(expected);
	for (let i = 0; i < 4; i += 1) {
		const distance = cornerDistance(actualPoints[i], expectedPoints[i]);
		expect(
			distance,
			`corner ${i}: ${JSON.stringify(actualPoints[i])} vs ${JSON.stringify(expectedPoints[i])}`,
		).toBeLessThanOrEqual(tolerance);
	}
}

const PAGE: Point[] = [
	{ x: 100, y: 70 },
	{ x: 560, y: 60 },
	{ x: 580, y: 420 },
	{ x: 90, y: 430 },
];

describe("detectDocumentQuad", () => {
	it("finds the page corners of a photo", () => {
		const image = photoOfDocument({ width: 640, height: 480, page: PAGE });
		const result = detectDocumentQuad(image);

		expect(result.method).not.toBe("none");
		expect(result.quad).not.toBeNull();
		expect(result.score).toBeGreaterThanOrEqual(0.5);
		if (!result.quad) throw new Error("expected a quad");
		expectQuadCloseTo(result.quad, orderQuad(PAGE), 8);
	});

	it("reports corners in the pixel space of the image it was given", () => {
		const small = detectDocumentQuad(
			photoOfDocument({ width: 640, height: 480, page: PAGE }),
		);
		const doubled = detectDocumentQuad(
			photoOfDocument({
				width: 1280,
				height: 960,
				page: PAGE.map((point) => ({ x: point.x * 2, y: point.y * 2 })),
			}),
		);

		expect(small.quad).not.toBeNull();
		expect(doubled.quad).not.toBeNull();
		if (!small.quad || !doubled.quad) throw new Error("expected quads");

		const scaled = {
			tl: { x: small.quad.tl.x * 2, y: small.quad.tl.y * 2 },
			tr: { x: small.quad.tr.x * 2, y: small.quad.tr.y * 2 },
			br: { x: small.quad.br.x * 2, y: small.quad.br.y * 2 },
			bl: { x: small.quad.bl.x * 2, y: small.quad.bl.y * 2 },
		};
		// Two candidates trace the page within a couple of working pixels of each
		// other, and which one wins can differ between the two downsamples, so the
		// corner tolerance allows for that tie.
		expectQuadCloseTo(doubled.quad, scaled, 6);
	});

	it("handles a page turned well away from upright", () => {
		const rotated: Point[] = [
			{ x: 320, y: 40 },
			{ x: 600, y: 250 },
			{ x: 320, y: 450 },
			{ x: 60, y: 240 },
		];
		const result = detectDocumentQuad(
			photoOfDocument({ width: 640, height: 480, page: rotated }),
		);

		expect(result.method).not.toBe("none");
		if (!result.quad) throw new Error("expected a quad");
		expectQuadCloseTo(result.quad, orderQuad(rotated), 12);
	});

	it("reports nothing when the page fills the frame", () => {
		const full: Point[] = [
			{ x: 0, y: 0 },
			{ x: 640, y: 0 },
			{ x: 640, y: 480 },
			{ x: 0, y: 480 },
		];
		const result = detectDocumentQuad(
			photoOfDocument({ width: 640, height: 480, page: full, background: 235 }),
		);
		expect(result.method).toBe("none");
		expect(result.quad).toBeNull();
	});

	it("reports nothing for a flat surface with no page on it", () => {
		const image = photoOfDocument({
			width: 640,
			height: 480,
			page: [{ x: 0, y: 0 }],
			background: 120,
		});
		expect(detectDocumentQuad(image).method).toBe("none");
	});
});

describe("detectDocumentQuad: a page that is hard to tell from its background", () => {
	it("never reports a crop whose corners sit on the frame", () => {
		const result = detectDocumentQuad(brightBoardOnBrightWall());

		// The board is only a shade brighter than the wall it hangs on, its top
		// edge is covered by a poster, and the wall runs into every border, so
		// there is no confident answer to give. What must never come back is a
		// confident quad hugging the frame: that reads as "the page fills the
		// photo" and leaves the user nothing to drag.
		if (!result.quad) return;
		expect(quadBorderInset(result.quad, 640, 480)).toBeGreaterThan(0.02);
	});

	it("reports the winning candidate as brighter than its surroundings", () => {
		const image = photoOfDocument({ width: 640, height: 480, page: PAGE });
		const best = findCandidates(image).sort(
			(a, b) => b.metrics.score - a.metrics.score,
		)[0];

		expect(best).toBeDefined();
		expect(best.metrics.contrast).toBeGreaterThan(0);
	});
});

describe("detectDocumentQuadOrFallback", () => {
	it("falls back to the full frame when nothing is found", () => {
		const image = photoOfDocument({
			width: 640,
			height: 480,
			page: [{ x: 0, y: 0 }],
			background: 120,
		});
		const result = detectDocumentQuadOrFallback(image, { insetFraction: 0.05 });

		expect(result.method).toBe("none");
		expect(result.quad.tl.x).toBeCloseTo(32, 6);
		expect(result.quad.br.x).toBeCloseTo(608, 6);
		expect(result.quad.br.y).toBeCloseTo(456, 6);
	});
});

/**
 * A page carrying the same brightness as the surface it lies on, under a
 * single smooth light gradient, marked only by a thin dark outline.
 *
 * No brightness threshold can separate the page here: the only usable signal
 * is the gradient ridge along the outline, so this exercises the border-ridge
 * fallback in `detectFromEdges`.
 */
function outlinedSheetOnGradient(options: {
	width: number;
	height: number;
	page: readonly Point[];
	top?: number;
	bottom?: number;
	outline?: number;
	seed?: number;
}): RgbaImage {
	const {
		width,
		height,
		page,
		top = 205,
		bottom = 115,
		outline = 60,
		seed = 21,
	} = options;

	const data = new Uint8ClampedArray(width * height * 4);
	const randomValue = random(seed);
	const edges = page.map(
		(point, index) => [point, page[(index + 1) % page.length]] as const,
	);

	const distanceToOutline = (x: number, y: number): number => {
		let nearest = Number.POSITIVE_INFINITY;
		for (const [startPoint, endPoint] of edges) {
			const dx = endPoint.x - startPoint.x;
			const dy = endPoint.y - startPoint.y;
			const lengthSquared = dx * dx + dy * dy;
			const t = Math.max(
				0,
				Math.min(
					1,
					((x - startPoint.x) * dx + (y - startPoint.y) * dy) / lengthSquared,
				),
			);
			nearest = Math.min(
				nearest,
				Math.hypot(x - (startPoint.x + t * dx), y - (startPoint.y + t * dy)),
			);
		}
		return nearest;
	};

	for (let y = 0; y < height; y += 1) {
		const level = top + ((bottom - top) * y) / (height - 1);
		for (let x = 0; x < width; x += 1) {
			const centreX = x + 0.5;
			const centreY = y + 0.5;
			const onOutline =
				pointInPolygon(centreX, centreY, page) &&
				distanceToOutline(centreX, centreY) < 3;
			const value = (onOutline ? outline : level) + (randomValue() - 0.5) * 8;
			const p = (y * width + x) * 4;
			data[p] = value;
			data[p + 1] = value;
			data[p + 2] = value;
			data[p + 3] = 255;
		}
	}

	return { data, width, height };
}

describe("detectDocumentQuad: outline fallback", () => {
	it("finds the page from the border ridge when brightness cannot separate it", () => {
		const result = detectDocumentQuad(
			outlinedSheetOnGradient({ width: 640, height: 480, page: PAGE }),
		);

		expect(result.method).toBe("edges");
		if (!result.quad) throw new Error("expected a quad");
		expectQuadCloseTo(result.quad, orderQuad(PAGE), 8);
	});
});
