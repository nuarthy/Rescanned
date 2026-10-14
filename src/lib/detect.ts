/**
 * Automatic document detection.
 *
 * The pipeline looks for the page in two independent ways and keeps the better
 * answer:
 *
 *   region  the page is the largest bright blob that does not bleed into all
 *           four borders of the frame
 *   edges   the page border is the strongest connected ridge of image gradient
 *
 * Both results are convex hulls reduced to four corners, then ranked by how
 * well their edges sit on real image edges, how close their corners are to
 * right angles, and how much of the frame they cover. A ranking below the
 * confidence floor returns no quad, and the caller falls back to the full
 * frame so the user can drag the corners instead.
 */

import {
	convexHull,
	insetFullQuad,
	isConvexQuad,
	type Point,
	polygonPerimeter,
	type Quad,
	quadAngles,
	quadArea,
	quadEdges,
	quadFromHull,
	quadPoints,
	scaleQuad,
} from "./geometry";
import {
	boxBlur,
	countMask,
	createMask,
	downscaleRgba,
	type GrayImage,
	largestComponent,
	maskToPoints,
	morph,
	otsuThreshold,
	percentileValue,
	type RgbaImage,
	sampleGray,
	sobelMagnitude,
	toGray,
	touchedBorderSides,
} from "./pixels";

export interface DetectOptions {
	/** Longest side of the working copy. Detection cost is quadratic in this. */
	maxDimension?: number;
	/** Ranking below which no quad is reported, on a 0..1 scale. */
	minScore?: number;
}

export interface DetectionResult {
	/** Detected document corners, or null when nothing convincing was found. */
	quad: Quad | null;
	/** Ranking of the winning candidate, on a 0..1 scale. */
	score: number;
	method: "region" | "edges" | "none";
}

interface Candidate {
	quad: Quad;
	method: "region" | "edges";
}

const DEFAULT_MAX_DIMENSION = 640;
const DEFAULT_MIN_SCORE = 0.42;
/** A document far smaller than this is almost certainly noise. */
const MIN_AREA_FRACTION = 0.05;
/** A quad covering essentially the whole frame carries no cropping value. */
const MAX_AREA_FRACTION = 0.985;
/** Reference gradient level for edge support, as a high percentile of the map. */
const GRADIENT_REFERENCE_PERCENTILE = 0.98;

export function detectDocumentQuad(
	image: RgbaImage,
	options: DetectOptions = {},
): DetectionResult {
	const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
	const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

	const working = downscaleRgba(image, maxDimension);
	const { width, height } = working;

	const gray = toGray(working);
	const blurRadius = Math.max(1, Math.round(Math.max(width, height) / 240));
	const smoothed = boxBlur(gray, blurRadius, 2);
	const magnitude = sobelMagnitude(smoothed);
	const gradientReference = Math.max(
		1e-3,
		percentileValue(magnitude.data, GRADIENT_REFERENCE_PERCENTILE),
	);

	const candidates: Candidate[] = [];

	const regionQuad = detectFromRegion(smoothed);
	if (regionQuad) candidates.push({ quad: regionQuad, method: "region" });

	const edgeQuad = detectFromEdges(magnitude);
	if (edgeQuad) candidates.push({ quad: edgeQuad, method: "edges" });

	let best: Candidate | null = null;
	let bestScore = Number.NEGATIVE_INFINITY;

	for (const candidate of candidates) {
		const score = rankQuad(
			candidate,
			magnitude,
			gradientReference,
			width,
			height,
		);
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}

	if (!best || bestScore < minScore) {
		return { quad: null, score: Math.max(0, bestScore), method: "none" };
	}

	// Detection runs on a reduced copy; report corners in the caller's pixels.
	return {
		quad: scaleQuad(best.quad, image.width / width, image.height / height),
		score: bestScore,
		method: best.method,
	};
}

/**
 * Convenience wrapper: the detected quad, or a slightly inset full frame when
 * detection is not confident, so the user always has something to adjust.
 */
export function detectDocumentQuadOrFallback(
	image: RgbaImage,
	options: DetectOptions & { insetFraction?: number } = {},
): DetectionResult & { quad: Quad } {
	const result = detectDocumentQuad(image, options);
	if (result.quad) return { ...result, quad: result.quad };

	return {
		...result,
		quad: insetFullQuad(
			image.width,
			image.height,
			options.insetFraction ?? 0.04,
		),
	};
}

/**
 * The page as the largest bright region.
 *
 * Both polarities are tried, because a document can be the dark object on a
 * bright surface. A region that runs into all four borders is treated as the
 * backdrop and discarded.
 */
function detectFromRegion(gray: GrayImage): Quad | null {
	const { width, height } = gray;
	const threshold = otsuThreshold(gray);
	const closeRadius = Math.max(1, Math.round(Math.max(width, height) / 160));

	let best: Quad | null = null;
	let bestArea = 0;

	for (const polarity of ["bright", "dark"] as const) {
		const mask = createMask(width, height);
		for (let i = 0; i < gray.data.length; i += 1) {
			const isBright = gray.data[i] >= threshold;
			mask.data[i] = (polarity === "bright" ? isBright : !isBright) ? 1 : 0;
		}

		const closed = morph(mask, closeRadius, "dilate");
		const component = largestComponent(closed);
		if (!component) continue;

		const filled = morph(component, closeRadius, "erode");
		const pixelCount = countMask(filled);
		if (pixelCount / (width * height) < MIN_AREA_FRACTION) continue;

		if (touchedBorderSides(filled).size >= 4) continue;

		const quad = quadFromHull(convexHull(maskToPoints(filled)));
		if (!quad) continue;

		const area = quadArea(quad);
		if (area > bestArea) {
			bestArea = area;
			best = quad;
		}
	}

	return best;
}

/**
 * The page border as the strongest connected ridge of image gradient.
 *
 * Closing with a generous radius bridges the gaps that broken border lines
 * leave behind. The component is then eroded by the same radius, so the hull
 * measures the true outline instead of sitting a dilation-width outside it.
 */
function detectFromEdges(magnitude: GrayImage): Quad | null {
	const { width, height } = magnitude;
	const threshold = Math.max(
		otsuThreshold(magnitude),
		0.2 * percentileValue(magnitude.data, GRADIENT_REFERENCE_PERCENTILE),
	);

	const mask = createMask(width, height);
	let set = 0;
	for (let i = 0; i < magnitude.data.length; i += 1) {
		if (magnitude.data[i] >= threshold) {
			mask.data[i] = 1;
			set += 1;
		}
	}
	if (set === 0) return null;

	const closeRadius = Math.max(2, Math.round(Math.max(width, height) / 100));
	const component = largestComponent(morph(mask, closeRadius, "dilate"));
	if (!component) return null;

	const outline = morph(component, closeRadius, "erode");
	return quadFromHull(convexHull(maskToPoints(outline)));
}

/**
 * Rank a candidate on a 0..1 scale. Values below the confidence floor mean
 * "do not trust this".
 */
function rankQuad(
	candidate: Candidate,
	magnitude: GrayImage,
	gradientReference: number,
	width: number,
	height: number,
): number {
	const { quad } = candidate;
	const areaFraction = quadArea(quad) / (width * height);
	if (areaFraction < MIN_AREA_FRACTION || areaFraction > MAX_AREA_FRACTION) {
		return Number.NEGATIVE_INFINITY;
	}
	if (!isConvexQuad(quad)) return Number.NEGATIVE_INFINITY;

	const angles = quadAngles(quad);
	const shortestEdge = Math.min(...quadEdges(quad));
	if (shortestEdge < Math.hypot(width, height) * 0.04) {
		return Number.NEGATIVE_INFINITY;
	}

	const halfPi = Math.PI / 2;
	const angleDeviation =
		angles.reduce((total, angle) => total + Math.abs(angle - halfPi), 0) /
		angles.length /
		halfPi;
	const angleQuality = Math.max(0, 1 - angleDeviation);

	const support = edgeSupport(quad, magnitude, gradientReference);
	const areaQuality = Math.min(1, areaFraction / 0.7);

	// A region candidate describes a filled area and is the more trustworthy of
	// the two, so it wins close calls.
	const methodBias = candidate.method === "region" ? 0.02 : 0;

	return Math.min(
		1,
		0.55 * support + 0.25 * angleQuality + 0.2 * areaQuality + methodBias,
	);
}

/**
 * Mean agreement between the quad outline and the gradient ridge along it.
 *
 * Each sample tolerates being a couple of pixels off the ridge, because the
 * polygon runs through pixel centres while the ridge has width.
 */
function edgeSupport(
	quad: Quad,
	magnitude: GrayImage,
	gradientReference: number,
): number {
	const points = resamplePerimeter(
		quadPoints(quad),
		Math.max(2, Math.min(magnitude.width, magnitude.height) / 200),
	);
	if (points.length === 0) return 0;

	const tolerance = 2;
	let total = 0;

	for (const point of points) {
		let strongest = 0;
		for (let dy = -tolerance; dy <= tolerance; dy += 1) {
			for (let dx = -tolerance; dx <= tolerance; dx += 1) {
				strongest = Math.max(
					strongest,
					sampleGray(magnitude, point.x + dx, point.y + dy),
				);
			}
		}
		const normalized = strongest / gradientReference;
		total += Math.max(0, Math.min(1, (normalized - 0.2) / 0.4));
	}

	return total / points.length;
}

/** Walk a polygon outline, returning points spaced roughly `step` apart. */
function resamplePerimeter(points: readonly Point[], step: number): Point[] {
	const samples: Point[] = [];
	const perimeter = polygonPerimeter(points);
	if (perimeter <= 0) return samples;

	for (let i = 0; i < points.length; i += 1) {
		const start = points[i];
		const end = points[(i + 1) % points.length];
		const length = Math.hypot(end.x - start.x, end.y - start.y);
		const count = Math.max(2, Math.ceil(length / step));
		for (let j = 0; j < count; j += 1) {
			const t = j / count;
			samples.push({
				x: start.x + (end.x - start.x) * t,
				y: start.y + (end.y - start.y) * t,
			});
		}
	}

	return samples;
}
