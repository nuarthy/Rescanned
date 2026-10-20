import { describe, expect, it } from "vitest";

import { UPRIGHT } from "./orientation";
import {
	ASPECT_RATIOS,
	applyShape,
	aspectRatio,
	exportSize,
	MAX_OUTPUT_PIXELS,
	orientPaper,
	PAPER_DPI,
	PAPER_SIZES,
	paperSize,
	paperTarget,
	ratioTarget,
	shapeFromValue,
	shapeValue,
	stretchToSize,
} from "./paper";
import type { RgbaImage } from "./pixels";

/** A solid page, so a resample can be checked by its colour. */
function solid(
	width: number,
	height: number,
	rgba: [number, number, number, number],
): RgbaImage {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = rgba[0];
		data[i + 1] = rgba[1];
		data[i + 2] = rgba[2];
		data[i + 3] = rgba[3];
	}
	return { data, width, height };
}

function pixelAt(image: RgbaImage, x: number, y: number): number[] {
	const offset = (y * image.width + x) * 4;
	return Array.from(image.data.slice(offset, offset + 4));
}

describe("orientPaper", () => {
	it("keeps a tall page on an upright sheet", () => {
		const turned = orientPaper(paperSize("a4"), { width: 1000, height: 1414 });
		expect([turned.widthMm, turned.heightMm]).toEqual([210, 297]);
	});

	it("turns the sheet for a page that lies down", () => {
		const turned = orientPaper(paperSize("a4"), { width: 1414, height: 1000 });
		expect([turned.widthMm, turned.heightMm]).toEqual([297, 210]);
	});

	it("turns a nearly square page toward the closer sheet", () => {
		// 1.1 is closer to 297/210 than to 210/297.
		const turned = orientPaper(paperSize("a4"), { width: 1100, height: 1000 });
		expect(turned.widthMm).toBe(297);
	});
});

describe("paperTarget", () => {
	it("sizes A4 at the print resolution", () => {
		const target = paperTarget(paperSize("a4"), { width: 1000, height: 1414 });
		const inch = 25.4;
		expect(target.width).toBe(Math.round((210 / inch) * PAPER_DPI));
		expect(target.height).toBe(Math.round((297 / inch) * PAPER_DPI));
	});

	it("caps the long side for a preview without changing the shape", () => {
		const target = paperTarget(
			paperSize("a4"),
			{ width: 1000, height: 1414 },
			1000,
		);
		expect(Math.max(target.width, target.height)).toBe(1000);
		expect(target.width / target.height).toBeCloseTo(210 / 297, 2);
	});

	it("keeps the sheet under the pixel ceiling", () => {
		// A3 at 300 DPI would be 4961 x 3508, past what iOS will canvas.
		const target = paperTarget(paperSize("a3"), { width: 1000, height: 1414 });
		expect(target.width * target.height).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS);
		expect(target.width / target.height).toBeCloseTo(297 / 420, 2);
	});

	it("applies the preview cap after the pixel ceiling", () => {
		const target = paperTarget(
			paperSize("a3"),
			{ width: 1000, height: 1414 },
			600,
		);
		expect(Math.max(target.width, target.height)).toBe(600);
	});
});

describe("ratioTarget", () => {
	it("keeps the page's long side and sets the short one", () => {
		const target = ratioTarget(aspectRatio("16:9"), {
			width: 1000,
			height: 600,
		});
		expect(target.width).toBe(1000);
		expect(target.height).toBe(563);
	});

	it("follows a tall page", () => {
		const target = ratioTarget(aspectRatio("4:3"), {
			width: 600,
			height: 1000,
		});
		expect(target.height).toBe(1000);
		expect(target.width).toBe(750);
	});

	it("makes a square out of a wide page", () => {
		const target = ratioTarget(aspectRatio("1:1"), {
			width: 1000,
			height: 600,
		});
		expect(target).toEqual({ width: 1000, height: 1000 });
	});

	it("stays under the pixel ceiling", () => {
		// A square from a 3500 pixel page would be 12 million pixels.
		const target = ratioTarget(aspectRatio("1:1"), {
			width: 3500,
			height: 2600,
		});
		expect(target.width * target.height).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS);
		expect(target.width).toBe(target.height);
	});

	it("respects the preview cap", () => {
		const target = ratioTarget(
			aspectRatio("3:2"),
			{ width: 1400, height: 1000 },
			700,
		);
		expect(Math.max(target.width, target.height)).toBe(700);
	});
});

describe("stretchToSize", () => {
	it("fills the whole sheet, with no margin left over", () => {
		// A red strip two pixels tall stretched onto a square sheet: every
		// pixel is page, so no white survives anywhere.
		const page = solid(2, 1, [255, 0, 0, 255]);
		const stretched = stretchToSize(page, { width: 4, height: 4 });

		expect(stretched.width).toBe(4);
		expect(stretched.height).toBe(4);
		for (let y = 0; y < 4; y += 1) {
			for (let x = 0; x < 4; x += 1) {
				expect(pixelAt(stretched, x, y)).toEqual([255, 0, 0, 255]);
			}
		}
	});

	it("stretches each axis on its own", () => {
		// A page with a left half and a right half, widened past its shape: the
		// halves stay halves and the seam lands in the middle of the sheet.
		const page: RgbaImage = {
			width: 2,
			height: 1,
			data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]),
		};
		const stretched = stretchToSize(page, { width: 6, height: 1 });
		expect(pixelAt(stretched, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(pixelAt(stretched, 5, 0)).toEqual([255, 255, 255, 255]);
	});

	it("keeps the page's own pixels when it already has the sheet's size", () => {
		const page = solid(4, 2, [12, 34, 56, 255]);
		expect(stretchToSize(page, { width: 4, height: 2 }).data).toEqual(
			page.data,
		);
	});
});

describe("applyShape", () => {
	it("hands the page back untouched for the crop's own shape", () => {
		const page = solid(10, 10, [1, 2, 3, 255]);
		expect(applyShape(page, { kind: "original" })).toBe(page);
	});

	it("stretches the page out to the chosen sheet", () => {
		const page = solid(600, 800, [1, 2, 3, 255]);
		const stretched = applyShape(page, { kind: "paper", id: "a4" }, 700);

		// A4 on its side would be the wrong way round for a tall page.
		expect(Math.max(stretched.width, stretched.height)).toBe(700);
		expect(stretched.width / stretched.height).toBeCloseTo(210 / 297, 2);

		// Every corner is page, not paper.
		const corners = [
			pixelAt(stretched, 0, 0),
			pixelAt(stretched, stretched.width - 1, 0),
			pixelAt(stretched, 0, stretched.height - 1),
			pixelAt(stretched, stretched.width - 1, stretched.height - 1),
		];
		for (const corner of corners) expect(corner).toEqual([1, 2, 3, 255]);
	});

	it("stretches the page out to the chosen ratio", () => {
		const page = solid(600, 800, [1, 2, 3, 255]);
		const stretched = applyShape(page, { kind: "ratio", id: "16:9" }, 900);

		// The page's own long side is the budget, so 800 stays 800.
		expect(stretched.height).toBe(800);
		expect(stretched.width).toBe(450);
		expect(stretched.width / stretched.height).toBeCloseTo(9 / 16, 2);
		expect(pixelAt(stretched, 0, 0)).toEqual([1, 2, 3, 255]);
		expect(
			pixelAt(stretched, stretched.width - 1, stretched.height - 1),
		).toEqual([1, 2, 3, 255]);
	});
});

describe("shape values", () => {
	it("round trips every paper", () => {
		for (const size of PAPER_SIZES) {
			const shape = { kind: "paper", id: size.id } as const;
			expect(shapeFromValue(shapeValue(shape))).toEqual(shape);
		}
	});

	it("round trips every ratio", () => {
		for (const ratio of ASPECT_RATIOS) {
			const shape = { kind: "ratio", id: ratio.id } as const;
			expect(shapeFromValue(shapeValue(shape))).toEqual(shape);
		}
	});

	it("keeps the crop's own shape", () => {
		expect(shapeValue({ kind: "original" })).toBe("original");
		expect(shapeFromValue("original")).toEqual({ kind: "original" });
	});

	it("falls back to the crop's own shape for a value it does not know", () => {
		expect(shapeFromValue("paper:nope")).toEqual({ kind: "original" });
		expect(shapeFromValue("ratio:7:3")).toEqual({ kind: "original" });
		expect(shapeFromValue("")).toEqual({ kind: "original" });
	});
});

describe("exportSize", () => {
	const upright = UPRIGHT;

	it("keeps the crop's own pixels when nothing is chosen", () => {
		expect(
			exportSize(
				{ width: 3245, height: 1788 },
				{ kind: "original" },
				upright,
				3500,
			),
		).toEqual({
			width: 3245,
			height: 1788,
		});
	});

	it("caps a crop larger than the source limit", () => {
		const size = exportSize(
			{ width: 7000, height: 4000 },
			{ kind: "original" },
			upright,
			3500,
		);
		expect(size).toEqual({ width: 3500, height: 2000 });
	});

	it("swaps the sides for a quarter turn", () => {
		const size = exportSize(
			{ width: 3245, height: 1788 },
			{ kind: "original" },
			{ ...upright, turns: 1 },
			3500,
		);
		expect(size).toEqual({ width: 1788, height: 3245 });
	});

	it("reports the paper's own size", () => {
		const size = exportSize(
			{ width: 3000, height: 4000 },
			{ kind: "paper", id: "a4" },
			upright,
			3500,
		);
		expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(3500);
		expect(size.width / size.height).toBeCloseTo(210 / 297, 2);
	});

	it("reports the ratio frame's size", () => {
		const size = exportSize(
			{ width: 3000, height: 2000 },
			{ kind: "ratio", id: "16:9" },
			upright,
			3500,
		);
		expect(size.width / size.height).toBeCloseTo(16 / 9, 2);
	});
});
