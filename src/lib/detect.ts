/**
 * Automatic document detection.
 *
 * Three views of the same photo propose where the page is:
 *
 *   flood   the page is a surface that a brightness frontier reaches before any
 *           dark boundary stops it, grown from the brightest pixel each surface
 *           still has to offer
 *   region  the page is the largest bright (or dark) blob that does not bleed
 *           into all four borders of the frame
 *   edges   the page border is the strongest connected ridge of image gradient
 *
 * Every proposal becomes a convex hull reduced to four corners, and is then
 * ranked by how well its outline sits on real image edges, how close its corners
 * are to right angles, how much of the frame it covers, how far it stands inside
 * the frame, and how much brighter it is than the surface around it. A ranking
 * below the confidence floor returns no quad, and the caller falls back to the
 * full frame so the user can drag the corners instead.
 *
 * `findCandidates` exposes the ranking on its own, which is what the tests and
 * any tuning work need to see.
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
	quadBorderInset,
	quadContainsPoint,
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
	floodRegions,
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

export type CandidateMethod = "region" | "edges";

export interface DetectionResult {
	/** Detected document corners, or null when nothing convincing was found. */
	quad: Quad | null;
	/** Ranking of the winning candidate, on a 0..1 scale. */
	score: number;
	method: CandidateMethod | "none";
}

/** How a candidate scored, kept so tuning and tests can inspect the ranking. */
export interface CandidateMetrics {
	/** Share of the frame the quad covers. */
	areaFraction: number;
	/** 1 when every corner is a right angle, lower as corners skew. */
	angleQuality: number;
	/** How much of the outline lies on a real gradient ridge. */
	edgeSupport: number;
	/** Distance from the quad to the nearest frame edge, as a share of the frame. */
	borderInset: number;
	/** Mean brightness inside the quad minus the dimmest of its four surroundings. */
	contrast: number;
	/** Final ranking, or -Infinity when a gate rejected the candidate. */
	score: number;
	/** Why the candidate was rejected, if it was. */
	rejected: string | null;
}

export interface Candidate {
	quad: Quad;
	method: CandidateMethod;
	metrics: CandidateMetrics;
}

const DEFAULT_MAX_DIMENSION = 640;
const DEFAULT_MIN_SCORE = 0.5;
/** A document far smaller than this is almost certainly noise. */
const MIN_AREA_FRACTION = 0.05;
/** A quad covering essentially the whole frame carries no cropping value. */
const MAX_AREA_FRACTION = 0.985;
/** Reference gradient level for edge support, as a high percentile of the map. */
const GRADIENT_REFERENCE_PERCENTILE = 0.98;
/**
 * Share of a seed's brightness range a flood may spread below that seed.
 *
 * Small enough that a page stops at a dark border of any width, wide enough to
 * carry a region across shading and the ink on a printed page.
 */
const FLOOD_DROP_SHARE = 0.4;
/** Floods to rank. Ranking a quad costs more than growing one. */
const MAX_FLOOD_CANDIDATES = 4;
/**
 * Smallest share of the frame a flood may cover and still be a page.
 *
 * A flood already fills whatever surface it starts on, so a small one is a
 * fragment of a surface, not a sheet of paper lying on one.
 */
const MIN_FLOOD_AREA_FRACTION = 0.25;
/** Difference from the surrounding surface, in gray levels, that scores full marks. */
const CONTRAST_REFERENCE = 45;
/** Distance from the quad to the frame, as a share of the frame, that scores full marks. */
const INSET_REFERENCE = 0.06;

interface CandidateContext {
	gray: GrayImage;
	magnitude: GrayImage;
	gradientReference: number;
	width: number;
	height: number;
}

export function detectDocumentQuad(
	image: RgbaImage,
	options: DetectOptions = {},
): DetectionResult {
	const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
	const { working, candidates } = detectCandidates(image, options);
	let best: Candidate | null = null;

	for (const candidate of candidates) {
		if (!best || candidate.metrics.score > best.metrics.score) best = candidate;
	}

	if (!best || best.metrics.score < minScore) {
		return {
			quad: null,
			score: Math.max(0, best?.metrics.score ?? 0),
			method: "none",
		};
	}

	// Detection runs on a reduced copy; report corners in the caller's pixels.
	const scale = image.width / working.width;

	return {
		quad: scaleQuad(best.quad, scale, scale),
		score: best.metrics.score,
		method: best.method,
	};
}

/**
 * Every quad the three views produced, with its ranking.
 *
 * Candidates keep their `-Infinity` scores so a caller can see that a quad was
 * found and then rejected, and why.
 */
export function findCandidates(
	image: RgbaImage,
	options: DetectOptions = {},
): Candidate[] {
	return detectCandidates(image, options).candidates;
}

function detectCandidates(
	image: RgbaImage,
	options: DetectOptions,
): { working: RgbaImage; candidates: Candidate[] } {
	const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
	const working = downscaleRgba(image, maxDimension);
	const { width, height } = working;

	const gray = toGray(working);
	const blurRadius = Math.max(1, Math.round(Math.max(width, height) / 240));
	const smoothed = boxBlur(gray, blurRadius, 2);
	const magnitude = sobelMagnitude(smoothed);
	const context: CandidateContext = {
		gray: smoothed,
		magnitude,
		gradientReference: Math.max(
			1e-3,
			percentileValue(magnitude.data, GRADIENT_REFERENCE_PERCENTILE),
		),
		width,
		height,
	};

	const candidates: Candidate[] = [];

	for (const quad of detectFromFlood(smoothed)) {
		candidates.push({
			quad,
			method: "region",
			metrics: rankQuad(quad, context),
		});
	}

	const regionQuad = detectFromRegion(smoothed);
	if (regionQuad) {
		candidates.push({
			quad: regionQuad,
			method: "region",
			metrics: rankQuad(regionQuad, context),
		});
	}

	const edgeQuad = detectFromEdges(magnitude);
	if (edgeQuad) {
		candidates.push({
			quad: edgeQuad,
			method: "edges",
			metrics: rankQuad(edgeQuad, context),
		});
	}

	return { working, candidates };
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
 * The page as the surface a brightness frontier fills first.
 *
 * Each region grows from the brightest pixel its surface still has, and stops
 * where brightness falls off — at a page's shadow line, at a cover's edge, or at
 * the boundary between a wall and a whiteboard. The hull of a region is that
 * surface's outline, so no threshold has to hold across the whole photo, which
 * is what a single global cut cannot do under uneven light.
 */
function detectFromFlood(gray: GrayImage): Quad[] {
	const { width, height } = gray;
	const quads: Quad[] = [];

	for (const region of floodRegions(gray, {
		dropShare: FLOOD_DROP_SHARE,
		maxRegions: 6,
	})) {
		const share = countMask(region) / (width * height);
		if (share < MIN_FLOOD_AREA_FRACTION) continue;

		const quad = quadFromHull(convexHull(maskToPoints(region)));
		if (quad) quads.push(quad);
	}

	return quads.slice(0, MAX_FLOOD_CANDIDATES);
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

/** Rank a candidate on a 0..1 scale, with the numbers that produced it. */
function rankQuad(quad: Quad, context: CandidateContext): CandidateMetrics {
	const { width, height } = context;
	const areaFraction = quadArea(quad) / (width * height);
	const inset = quadBorderInset(quad, width, height);
	const angles = quadAngles(quad);
	const halfPi = Math.PI / 2;
	const angleDeviation =
		angles.reduce((total, angle) => total + Math.abs(angle - halfPi), 0) /
		angles.length /
		halfPi;
	const angleQuality = Math.max(0, 1 - angleDeviation);
	const support = edgeSupport(
		quad,
		context.magnitude,
		context.gradientReference,
	);
	const contrast = surroundingContrast(quad, context);

	const metrics: CandidateMetrics = {
		areaFraction,
		angleQuality,
		edgeSupport: support,
		borderInset: inset,
		contrast,
		score: -Infinity,
		rejected: null,
	};

	const reject = (reason: string): CandidateMetrics => {
		metrics.rejected = reason;
		return metrics;
	};

	if (areaFraction < MIN_AREA_FRACTION) return reject("too small");
	if (areaFraction > MAX_AREA_FRACTION) return reject("fills the frame");
	if (!isConvexQuad(quad)) return reject("not convex");
	const shortestEdge = Math.min(...quadEdges(quad));
	if (shortestEdge < Math.hypot(width, height) * 0.04) {
		return reject("edge too short");
	}

	const areaQuality = Math.min(1, areaFraction / 0.7);
	const insetQuality = Math.min(1, inset / INSET_REFERENCE);
	const contrastQuality = Math.max(
		0,
		Math.min(1, contrast / CONTRAST_REFERENCE),
	);

	metrics.score = Math.min(
		1,
		0.34 * support +
			0.14 * angleQuality +
			0.12 * areaQuality +
			0.16 * insetQuality +
			0.24 * contrastQuality,
	);
	return metrics;
}

/**
 * How much brighter the quad's interior is than the surface around it.
 *
 * Every side is compared against the strip just outside it, and the weakest side
 * decides. A page on a desk, a whiteboard on a wall, and a receipt on a table
 * are all brighter than what surrounds them on all four sides; a bright patch of
 * that same wall is not, because one of its sides faces something brighter
 * still. A quad flush with the frame has no strip outside it, so it scores
 * nothing here.
 */
function surroundingContrast(quad: Quad, context: CandidateContext): number {
	const { gray, width, height } = context;
	const points = quadPoints(quad);
	const insideSamples = regionGrid(width, height).filter((point) =>
		quadContainsPoint(quad, point),
	);
	if (insideSamples.length === 0) return 0;

	let inside = 0;
	for (const point of insideSamples) {
		inside += sampleGray(gray, point.x, point.y);
	}
	inside /= insideSamples.length;

	const reach = Math.min(width, height) * 0.05;
	let weakest = Number.POSITIVE_INFINITY;

	for (let side = 0; side < 4; side += 1) {
		const start = points[side];
		const end = points[(side + 1) % 4];
		const length = Math.hypot(end.x - start.x, end.y - start.y);
		if (length < 1) return 0;
		// Outward normal, for a quad wound in order.
		const normalX = (end.y - start.y) / length;
		const normalY = -(end.x - start.x) / length;

		let total = 0;
		let samples = 0;
		for (let step = 0.1; step < 0.95; step += 0.1) {
			const baseX = start.x + (end.x - start.x) * step;
			const baseY = start.y + (end.y - start.y) * step;
			for (const distance of [reach * 0.5, reach, reach * 1.5]) {
				const x = baseX + normalX * distance;
				const y = baseY + normalY * distance;
				if (x < 0 || y < 0 || x >= width || y >= height) continue;
				total += sampleGray(gray, x, y);
				samples += 1;
			}
		}
		if (samples === 0) return 0;
		weakest = Math.min(weakest, inside - total / samples);
	}

	return weakest;
}

/** Sampling grid over the frame, shared by the interior measurements. */
function regionGrid(width: number, height: number): Point[] {
	const points: Point[] = [];
	const step = Math.max(2, Math.round(Math.min(width, height) / 48));
	for (let y = step / 2; y < height; y += step) {
		for (let x = step / 2; x < width; x += step) points.push({ x, y });
	}
	return points;
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
