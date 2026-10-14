import { describe, expect, it } from "vitest";

import {
	convexHull,
	insetFullQuad,
	isConvex,
	maxAreaQuadFromPolygon,
	orderQuad,
	polygonArea,
	type Quad,
	quadAngles,
	quadArea,
	quadContainsPoint,
	quadFromHull,
	quadPoints,
	rotateQuad,
	translateQuad,
	withQuadCorner,
} from "./geometry";
import { quadOutputSize } from "./perspective";

describe("orderQuad", () => {
	it("names the corners by position whatever order they arrive in", () => {
		const tl = { x: 10, y: 20 };
		const tr = { x: 190, y: 30 };
		const br = { x: 210, y: 160 };
		const bl = { x: 15, y: 150 };

		const shuffled = [br, tl, bl, tr];
		expect(orderQuad(shuffled)).toEqual({ tl, tr, br, bl });
	});

	it("rejects anything that is not four points", () => {
		expect(() => orderQuad([{ x: 0, y: 0 }])).toThrow();
	});
});

describe("polygon maths", () => {
	it("measures a unit square", () => {
		const square = [
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 1, y: 1 },
			{ x: 0, y: 1 },
		];
		expect(polygonArea(square)).toBeCloseTo(1, 10);
	});

	it("detects a bow tie as not convex", () => {
		expect(
			isConvex([
				{ x: 0, y: 0 },
				{ x: 10, y: 10 },
				{ x: 10, y: 0 },
				{ x: 0, y: 10 },
			]),
		).toBe(false);
	});

	it("measures right angles of a rectangle", () => {
		const quad = {
			tl: { x: 0, y: 0 },
			tr: { x: 100, y: 0 },
			br: { x: 100, y: 50 },
			bl: { x: 0, y: 50 },
		};
		for (const angle of quadAngles(quad)) {
			expect(angle).toBeCloseTo(Math.PI / 2, 6);
		}
		expect(quadArea(quad)).toBeCloseTo(5000, 6);
	});
});

describe("convexHull", () => {
	it("drops interior points", () => {
		const hull = convexHull([
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
			{ x: 5, y: 5 },
			{ x: 2, y: 8 },
		]);
		expect(hull).toHaveLength(4);
	});
});

describe("maxAreaQuadFromPolygon", () => {
	/**
	 * Hull of a detected page region. The page corners sit about three pixels
	 * inside it and the top edge slopes gently up to the right, so the true
	 * top-left corner is a shallow turn that costs almost no area to remove.
	 */
	const hull = [
		{ x: 90.5, y: 411.5 },
		{ x: 99.5, y: 87.5 },
		{ x: 100.5, y: 73.5 },
		{ x: 103.5, y: 70.5 },
		{ x: 122.5, y: 69.5 },
		{ x: 490.5, y: 61.5 },
		{ x: 537.5, y: 60.5 },
		{ x: 556.5, y: 60.5 },
		{ x: 559.5, y: 63.5 },
		{ x: 560.5, y: 68.5 },
		{ x: 579.5, y: 410.5 },
		{ x: 579.5, y: 416.5 },
		{ x: 576.5, y: 419.5 },
		{ x: 554.5, y: 420.5 },
		{ x: 457.5, y: 422.5 },
		{ x: 114.5, y: 429.5 },
		{ x: 93.5, y: 429.5 },
		{ x: 90.5, y: 426.5 },
	];

	it("keeps the shallow top-left corner instead of rounding it off", () => {
		const quad = quadFromHull(hull);
		expect(quad).not.toBeNull();
		if (!quad) return;
		expect(quad.tl.x).toBeCloseTo(103.5, 6);
		expect(quad.tl.y).toBeCloseTo(70.5, 6);
	});

	it("stays within a few pixels of all four page corners", () => {
		const quad = quadFromHull(hull);
		if (!quad) throw new Error("expected a quad");
		const trueCorners = [
			{ x: 100, y: 70 },
			{ x: 560, y: 60 },
			{ x: 580, y: 420 },
			{ x: 90, y: 430 },
		];
		quadPoints(quad).forEach((corner, index) => {
			const expected = trueCorners[index];
			expect(
				Math.hypot(corner.x - expected.x, corner.y - expected.y),
			).toBeLessThanOrEqual(5);
		});
	});

	it("passes small polygons through unchanged", () => {
		const triangle = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 5, y: 10 },
		];
		expect(maxAreaQuadFromPolygon(triangle)).toHaveLength(3);

		const square = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
		];
		expect(maxAreaQuadFromPolygon(square)).toEqual(square);
	});

	it("finds the outer corners of a polygon padded with extra vertices", () => {
		const square = [
			{ x: 0, y: 0 },
			{ x: 50, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 50 },
			{ x: 100, y: 100 },
			{ x: 50, y: 100 },
			{ x: 0, y: 100 },
			{ x: 0, y: 50 },
		];
		expect(polygonArea(maxAreaQuadFromPolygon(square))).toBeCloseTo(10000, 6);
	});
});

describe("quadFromHull", () => {
	it("refuses a hull with too few corners", () => {
		expect(
			quadFromHull([
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
				{ x: 5, y: 10 },
			]),
		).toBeNull();
	});
});

describe("insetFullQuad", () => {
	it("insets every side by the given fraction", () => {
		expect(insetFullQuad(1000, 500, 0.1)).toEqual({
			tl: { x: 100, y: 50 },
			tr: { x: 900, y: 50 },
			br: { x: 900, y: 450 },
			bl: { x: 100, y: 450 },
		});
	});
});

describe("withQuadCorner", () => {
	it("replaces one corner and leaves the rest alone", () => {
		const quad = insetFullQuad(100, 100, 0.1);
		const moved = withQuadCorner(quad, 2, { x: 95, y: 95 });
		expect(moved.br).toEqual({ x: 95, y: 95 });
		expect(moved.tl).toEqual(quad.tl);
		expect(quad.br).toEqual({ x: 90, y: 90 });
	});
});

describe("rotateQuad", () => {
	const quad: Quad = {
		tl: { x: 10, y: 20 },
		tr: { x: 190, y: 30 },
		br: { x: 210, y: 160 },
		bl: { x: 15, y: 150 },
	};

	it("sends the bottom-left corner to the top-left on a clockwise turn", () => {
		const turned = rotateQuad(quad, 1);
		expect(turned.tl).toEqual(quad.bl);
		expect(turned.tr).toEqual(quad.tl);
		expect(turned.br).toEqual(quad.tr);
		expect(turned.bl).toEqual(quad.br);
	});

	it("returns the same quad after four turns", () => {
		expect(rotateQuad(quad, 4)).toEqual(quad);
		expect(rotateQuad(quad, 0)).toBe(quad);
	});

	it("treats a negative turn as three turns forward", () => {
		expect(rotateQuad(quad, -1)).toEqual(rotateQuad(quad, 3));
	});

	it("swaps the output size of a rectangle after one turn", () => {
		const rectangle: Quad = {
			tl: { x: 0, y: 0 },
			tr: { x: 100, y: 0 },
			br: { x: 100, y: 60 },
			bl: { x: 0, y: 60 },
		};
		const upright = quadOutputSize(rectangle);
		const turned = quadOutputSize(rotateQuad(rectangle, 1));
		expect(turned.width).toBe(upright.height);
		expect(turned.height).toBe(upright.width);
	});
});

describe("quadContainsPoint", () => {
	const quad: Quad = {
		tl: { x: 10, y: 10 },
		tr: { x: 110, y: 20 },
		br: { x: 100, y: 120 },
		bl: { x: 20, y: 110 },
	};

	it("accepts a point inside and rejects points outside", () => {
		expect(quadContainsPoint(quad, { x: 60, y: 60 })).toBe(true);
		expect(quadContainsPoint(quad, { x: 5, y: 5 })).toBe(false);
		expect(quadContainsPoint(quad, { x: 60, y: 130 })).toBe(false);
		expect(quadContainsPoint(quad, { x: 108, y: 60 })).toBe(false);
	});
});

describe("translateQuad", () => {
	const quad: Quad = {
		tl: { x: 10, y: 20 },
		tr: { x: 110, y: 30 },
		br: { x: 100, y: 130 },
		bl: { x: 20, y: 120 },
	};

	it("moves every corner by the same delta", () => {
		const moved = translateQuad(quad, 25, -5, 400, 400);
		expect(moved.tl).toEqual({ x: 35, y: 15 });
		expect(moved.br).toEqual({ x: 125, y: 125 });
	});

	it("stops at the image edge instead of leaving the frame", () => {
		const moved = translateQuad(quad, -100, -100, 400, 400);
		expect(moved.tl).toEqual({ x: 0, y: 0 });
		expect(moved.br).toEqual({ x: 90, y: 110 });

		// Overshooting right and down parks the far corner on the border.
		const far = translateQuad(quad, 400, 400, 200, 200);
		const farPoints = quadPoints(far);
		expect(Math.max(...farPoints.map((p) => p.x))).toBe(200);
		expect(Math.max(...farPoints.map((p) => p.y))).toBe(200);
	});
});
