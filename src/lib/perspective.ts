/**
 * Perspective correction: map the quad the user sees onto a flat rectangle.
 *
 * The homography is solved destination to source, so the warp is a direct
 * per-pixel evaluation with no matrix inverse and no gaps.
 */

import { type Point, type Quad, quadEdges, quadPoints } from "./geometry";
import type { RgbaImage } from "./pixels";

export interface OutputSize {
	width: number;
	height: number;
}

/**
 * Size of the corrected page: the longer of each pair of opposite edges, so
 * nothing in the quad is cropped away.
 */
export function quadOutputSize(quad: Quad, maxDimension?: number): OutputSize {
	const [top, right, bottom, left] = quadEdges(quad);
	let width = Math.max(1, Math.round(Math.max(top, bottom)));
	let height = Math.max(1, Math.round(Math.max(right, left)));

	if (maxDimension && Math.max(width, height) > maxDimension) {
		const scale = maxDimension / Math.max(width, height);
		width = Math.max(1, Math.round(width * scale));
		height = Math.max(1, Math.round(height * scale));
	}

	return { width, height };
}

/**
 * Solve `matrix * x = rhs` by Gauss-Jordan elimination with partial pivoting.
 *
 * Returns null when the system is singular, which happens when the four source
 * points are collinear or coincident.
 */
function solveLinearSystem(matrix: number[][], rhs: number[]): number[] | null {
	const size = rhs.length;
	const augmented = matrix.map((row, i) => [...row, rhs[i]]);

	for (let column = 0; column < size; column += 1) {
		let pivotRow = column;
		let pivotMagnitude = Math.abs(augmented[column][column]);
		for (let row = column + 1; row < size; row += 1) {
			const magnitude = Math.abs(augmented[row][column]);
			if (magnitude > pivotMagnitude) {
				pivotMagnitude = magnitude;
				pivotRow = row;
			}
		}
		if (pivotMagnitude < 1e-10) return null;

		if (pivotRow !== column) {
			const swap = augmented[column];
			augmented[column] = augmented[pivotRow];
			augmented[pivotRow] = swap;
		}

		const pivot = augmented[column][column];
		for (let i = column; i <= size; i += 1) augmented[column][i] /= pivot;

		for (let row = 0; row < size; row += 1) {
			if (row === column) continue;
			const factor = augmented[row][column];
			if (factor === 0) continue;
			for (let i = column; i <= size; i += 1) {
				augmented[row][i] -= factor * augmented[column][i];
			}
		}
	}

	return augmented.map((row) => row[size]);
}

/**
 * Coefficients mapping a destination point to a source point:
 *
 *   u = (a*x + b*y + c) / (g*x + h*y + 1)
 *   v = (d*x + e*y + f) / (g*x + h*y + 1)
 */
function solveHomography(
	destination: readonly Point[],
	source: readonly Point[],
): number[] | null {
	const matrix: number[][] = [];
	const rhs: number[] = [];

	for (let i = 0; i < 4; i += 1) {
		const { x, y } = destination[i];
		const { x: u, y: v } = source[i];

		matrix.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
		rhs.push(u);
		matrix.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
		rhs.push(v);
	}

	return solveLinearSystem(matrix, rhs);
}

/**
 * Warp the quad region of `image` onto an axis-aligned rectangle.
 *
 * Destination corners sit on pixel centres, so no half-pixel shift creeps into
 * the result. Samples outside the source are clamped to the edge.
 */
export function warpQuadToRgba(
	image: RgbaImage,
	quad: Quad,
	maxDimension?: number,
): RgbaImage {
	const { width, height } = quadOutputSize(quad, maxDimension);
	const output = new Uint8ClampedArray(width * height * 4);

	const [tl, tr, br, bl] = quadPoints(quad);
	const coefficients = solveHomography(
		[
			{ x: -0.5, y: -0.5 },
			{ x: width - 0.5, y: -0.5 },
			{ x: width - 0.5, y: height - 0.5 },
			{ x: -0.5, y: height - 0.5 },
		],
		[tl, tr, br, bl],
	);

	if (!coefficients) return { data: output, width, height };

	const [a, b, c, d, e, f, g, h] = coefficients;
	const sourceWidth = image.width;
	const sourceHeight = image.height;
	const source = image.data;

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const denominator = g * x + h * y + 1;
			const u = denominator === 0 ? 0 : (a * x + b * y + c) / denominator;
			const v = denominator === 0 ? 0 : (d * x + e * y + f) / denominator;

			const clampedU = u < 0 ? 0 : u > sourceWidth - 1 ? sourceWidth - 1 : u;
			const clampedV = v < 0 ? 0 : v > sourceHeight - 1 ? sourceHeight - 1 : v;

			const x0 = Math.floor(clampedU);
			const y0 = Math.floor(clampedV);
			const x1 = Math.min(sourceWidth - 1, x0 + 1);
			const y1 = Math.min(sourceHeight - 1, y0 + 1);
			const fx = clampedU - x0;
			const fy = clampedV - y0;

			const topLeft = (y0 * sourceWidth + x0) * 4;
			const topRight = (y0 * sourceWidth + x1) * 4;
			const bottomLeft = (y1 * sourceWidth + x0) * 4;
			const bottomRight = (y1 * sourceWidth + x1) * 4;

			const weightTopLeft = (1 - fx) * (1 - fy);
			const weightTopRight = fx * (1 - fy);
			const weightBottomLeft = (1 - fx) * fy;
			const weightBottomRight = fx * fy;

			const target = (y * width + x) * 4;
			for (let channel = 0; channel < 4; channel += 1) {
				output[target + channel] = Math.round(
					source[topLeft + channel] * weightTopLeft +
						source[topRight + channel] * weightTopRight +
						source[bottomLeft + channel] * weightBottomLeft +
						source[bottomRight + channel] * weightBottomRight,
				);
			}
		}
	}

	return { data: output, width, height };
}
