import { describe, expect, it } from "vitest";

import { boxBlur, createMask, floodRegions, type Mask, morph } from "./pixels";

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

/**
 * Straightforward window walk: the definition `morph` has to match.
 *
 * Each window sample clamps to the edges, so a border pixel counts once per
 * offset that lands on it.
 */
function referenceMorph(
	mask: Mask,
	radius: number,
	mode: "dilate" | "erode",
): Mask {
	const { width, height } = mask;
	const pick = mode === "dilate" ? Math.max : Math.min;
	const alongX = new Uint8Array(width * height);
	const output = createMask(width, height);

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			let value = mode === "dilate" ? 0 : 1;
			for (let offset = -radius; offset <= radius; offset += 1) {
				const sampleX = Math.min(width - 1, Math.max(0, x + offset));
				value = pick(value, mask.data[y * width + sampleX]);
			}
			alongX[y * width + x] = value;
		}
	}

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			let value = mode === "dilate" ? 0 : 1;
			for (let offset = -radius; offset <= radius; offset += 1) {
				const sampleY = Math.min(height - 1, Math.max(0, y + offset));
				value = pick(value, alongX[sampleY * width + x]);
			}
			output.data[y * width + x] = value;
		}
	}

	return output;
}

function noisyMask(
	width: number,
	height: number,
	density: number,
	seed: number,
): Mask {
	const mask = createMask(width, height);
	const randomValue = random(seed);
	for (let index = 0; index < mask.data.length; index += 1) {
		mask.data[index] = randomValue() < density ? 1 : 0;
	}
	return mask;
}

describe("morph", () => {
	it("matches a straight window walk, borders and all", () => {
		for (const [width, height] of [
			[64, 48],
			[97, 31],
			[16, 16],
		]) {
			for (const density of [0.02, 0.3, 0.97]) {
				const mask = noisyMask(width, height, density, width + height);
				for (const radius of [1, 2, 5, 11]) {
					for (const mode of ["dilate", "erode"] as const) {
						const expected = referenceMorph(mask, radius, mode);
						expect(Array.from(morph(mask, radius, mode).data)).toEqual(
							Array.from(expected.data),
						);
					}
				}
			}
		}
	});

	it("spreads a single set pixel by the radius in every direction", () => {
		const mask = createMask(9, 9);
		mask.data[4 * 9 + 4] = 1;
		const dilated = morph(mask, 2, "dilate");
		const set = Array.from(dilated.data).filter((value) => value === 1).length;

		expect(set).toBe(25);
		expect(dilated.data[4 * 9 + 4]).toBe(1);
		expect(dilated.data[0]).toBe(0);
	});

	it("keeps nothing through an erode of an empty mask", () => {
		const empty = createMask(12, 12);
		const eroded = morph(empty, 3, "erode");
		expect(Array.from(eroded.data).every((value) => value === 0)).toBe(true);
	});
});

/** A grayscale ramp written straight into a GrayImage. */
function grayFrom(
	width: number,
	height: number,
	value: (x: number, y: number) => number,
) {
	const data = new Float32Array(width * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) data[y * width + x] = value(x, y);
	}
	return { data, width, height };
}

describe("floodRegions", () => {
	it("stops at a dark line instead of crossing to a surface beyond it", () => {
		const width = 120;
		const height = 80;
		const lineFrom = 58;
		const lineTo = 61;
		const gray = grayFrom(width, height, (x) => {
			if (x >= lineFrom && x <= lineTo) return 30;
			return x < lineFrom ? 150 : 200;
		});

		const regions = floodRegions(gray, { dropShare: 0.5, maxRegions: 4 });
		const bySide = regions.map((region) => {
			let left = 0;
			let right = 0;
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					if (region.data[y * width + x] === 0) continue;
					if (x < lineFrom) left += 1;
					if (x > lineTo) right += 1;
				}
			}
			return { left, right };
		});

		// The bright side is grown first, from its own brightest pixel, and the
		// dark line stops it before it can reach the dimmer side.
		expect(bySide[0].right).toBeGreaterThan(0);
		expect(bySide[0].left).toBe(0);
		expect(bySide[1].left).toBeGreaterThan(0);
		expect(bySide[1].right).toBe(0);
	});

	it("claims each pixel at most once", () => {
		const gray = grayFrom(60, 40, (x, y) => ((x + y) % 90) + 60);
		const regions = floodRegions(gray, { dropShare: 0.4, maxRegions: 5 });

		let total = 0;
		for (const region of regions) {
			total += Array.from(region.data).filter((value) => value === 1).length;
		}
		const claimed = new Uint8Array(gray.width * gray.height);
		for (const region of regions) {
			for (let index = 0; index < region.data.length; index += 1) {
				if (region.data[index] === 0) continue;
				expect(claimed[index]).toBe(0);
				claimed[index] = 1;
			}
		}

		expect(total).toBeGreaterThan(0);
	});

	it("reaches further down from a seed as the allowed drop grows", () => {
		const gray = grayFrom(80, 60, (x) => 40 + (x / 80) * 180);
		const sizeAt = (dropShare: number) => {
			const [first] = floodRegions(gray, { dropShare, maxRegions: 1 });
			return Array.from(first.data).filter((value) => value === 1).length;
		};

		expect(sizeAt(0.5)).toBeGreaterThan(sizeAt(0.2));
	});

	it("comes back largest first", () => {
		const gray = boxBlur(
			grayFrom(80, 60, (x, y) => (x < 20 && y < 20 ? 250 : 120)),
			3,
			1,
		);
		const regions = floodRegions(gray, { dropShare: 0.5, maxRegions: 4 });
		const sizes = regions.map(
			(region) => Array.from(region.data).filter((value) => value === 1).length,
		);

		expect(sizes.length).toBeGreaterThan(1);
		expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
	});
});
