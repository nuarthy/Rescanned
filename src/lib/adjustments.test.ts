import { describe, expect, it } from "vitest";

import {
	ADJUSTMENT_SLIDERS,
	type Adjustments,
	applyAdjustments,
	isNeutral,
	NEUTRAL_ADJUSTMENTS,
} from "./adjustments";
import type { RgbaImage } from "./pixels";

/** A one pixel image, so a transform can be read back directly. */
function pixel(red: number, green: number, blue: number): RgbaImage {
	return {
		width: 1,
		height: 1,
		data: new Uint8ClampedArray([red, green, blue, 255]),
	};
}

function adjusted(
	red: number,
	green: number,
	blue: number,
	overrides: Partial<Adjustments>,
): number[] {
	const result = applyAdjustments(pixel(red, green, blue), {
		...NEUTRAL_ADJUSTMENTS,
		...overrides,
	});
	return Array.from(result.data.slice(0, 3));
}

describe("isNeutral", () => {
	it("is true only when every slider sits at zero", () => {
		expect(isNeutral(NEUTRAL_ADJUSTMENTS)).toBe(true);
		for (const { id } of ADJUSTMENT_SLIDERS) {
			expect(isNeutral({ ...NEUTRAL_ADJUSTMENTS, [id]: 5 })).toBe(false);
		}
	});
});

describe("applyAdjustments", () => {
	it("hands the image back untouched at zero", () => {
		const image = pixel(10, 120, 240);
		expect(applyAdjustments(image, NEUTRAL_ADJUSTMENTS)).toBe(image);
	});

	it("lifts every channel with brightness", () => {
		const [red, green, blue] = adjusted(100, 100, 100, { brightness: 50 });
		expect(red).toBe(148);
		expect(green).toBe(148);
		expect(blue).toBe(148);
	});

	it("pushes values away from the middle with contrast", () => {
		const light = adjusted(200, 200, 200, { contrast: 50 })[0];
		const dark = adjusted(50, 50, 50, { contrast: 50 })[0];
		expect(light).toBeGreaterThan(200);
		expect(dark).toBeLessThan(50);
	});

	it("removes all colour at full negative saturation", () => {
		const [red, green, blue] = adjusted(200, 80, 40, { saturation: -100 });
		expect(red).toBe(green);
		expect(green).toBe(blue);
	});

	it("leaves luminance alone when saturation is pushed", () => {
		const before = 0.299 * 200 + 0.587 * 80 + 0.114 * 40;
		const [red, green, blue] = adjusted(200, 80, 40, { saturation: 60 });
		const after = 0.299 * red + 0.587 * green + 0.114 * blue;
		expect(after).toBeCloseTo(before, 0);
	});

	it("moves highlights and not shadows", () => {
		const bright = adjusted(220, 220, 220, { highlights: -100 })[0];
		const dark = adjusted(30, 30, 30, { highlights: -100 })[0];
		expect(bright).toBeLessThan(220);
		expect(dark).toBe(30);
	});

	it("moves shadows and not highlights", () => {
		const dark = adjusted(30, 30, 30, { shadows: 100 })[0];
		const bright = adjusted(230, 230, 230, { shadows: 100 })[0];
		expect(dark).toBeGreaterThan(30);
		expect(bright).toBe(230);
	});

	it("keeps every channel inside the byte range", () => {
		const blown = adjusted(250, 250, 250, { brightness: 100, shadows: 100 });
		const crushed = adjusted(5, 5, 5, { brightness: -100, highlights: -100 });
		for (const value of [...blown, ...crushed]) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(255);
		}
	});

	it("keeps the alpha channel", () => {
		const image = pixel(10, 20, 30);
		const result = applyAdjustments(image, {
			...NEUTRAL_ADJUSTMENTS,
			brightness: 30,
		});
		expect(result.data[3]).toBe(255);
	});
});
