/**
 * Planar geometry for document corners.
 *
 * A quad is always stored in the order top-left, top-right, bottom-right,
 * bottom-left of the *visible* document, so callers can rely on the order.
 * Coordinates are in pixels of the image the quad belongs to, with the origin
 * at the top-left corner and `y` growing downwards.
 */

export interface Point {
	x: number;
	y: number;
}

export interface Quad {
	tl: Point;
	tr: Point;
	br: Point;
	bl: Point;
}

/** Corners in order, which is the order most algorithms want. */
export function quadPoints(quad: Quad): [Point, Point, Point, Point] {
	return [quad.tl, quad.tr, quad.br, quad.bl];
}

/** Clockwise quarter turns, wrapped to 0..3. */
export type QuarterTurns = 0 | 1 | 2 | 3;

/** Wrap any turn count, including negative ones, into the 0..3 range. */
export function normalizeTurns(turns: number): QuarterTurns {
	return (((turns % 4) + 4) % 4) as QuarterTurns;
}

/**
 * Re-label a quad's corners as if the produced image were turned clockwise by
 * `turns` quarter turns.
 *
 * The warp sends the top-left corner to the top-left of the output, so turning
 * the output clockwise means the corner that sat at the bottom-left becomes the
 * new top-left. Renaming the corners is enough: they stay in clockwise order,
 * and the output size follows from the edges, so a quarter turn swaps width and
 * height for free.
 */
export function rotateQuad(quad: Quad, turns: number): Quad {
	const steps = normalizeTurns(turns);
	if (steps === 0) return quad;

	const points = quadPoints(quad);
	const shifted = points.map((_, index) => points[(index - steps + 4) % 4]);
	return { tl: shifted[0], tr: shifted[1], br: shifted[2], bl: shifted[3] };
}

/** Copy with one corner replaced, keeping the position order intact. */
export function withQuadCorner(quad: Quad, index: number, point: Point): Quad {
	const points = quadPoints(quad);
	points[index] = point;
	return {
		tl: points[0],
		tr: points[1],
		br: points[2],
		bl: points[3],
	};
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function quadEdges(quad: Quad): [number, number, number, number] {
	const [tl, tr, br, bl] = quadPoints(quad);
	return [
		distance(tl, tr),
		distance(tr, br),
		distance(br, bl),
		distance(bl, tl),
	];
}

/** Shoelace area of any polygon. */
export function polygonArea(points: readonly Point[]): number {
	let sum = 0;
	for (let i = 0; i < points.length; i += 1) {
		const current = points[i];
		const next = points[(i + 1) % points.length];
		sum += current.x * next.y - next.x * current.y;
	}
	return Math.abs(sum) / 2;
}

export function quadArea(quad: Quad): number {
	return polygonArea(quadPoints(quad));
}

/** How close a quad runs to the frame, as a share of the frame's short side. */
export function quadBorderInset(
	quad: Quad,
	width: number,
	height: number,
): number {
	const points = quadPoints(quad);
	const left = Math.min(...points.map((point) => point.x));
	const right = Math.max(...points.map((point) => point.x));
	const top = Math.min(...points.map((point) => point.y));
	const bottom = Math.max(...points.map((point) => point.y));
	const shortest = Math.min(width, height);

	return (
		Math.min(left, top, width - right, height - bottom) / Math.max(1, shortest)
	);
}

export function polygonPerimeter(points: readonly Point[]): number {
	let total = 0;
	for (let i = 0; i < points.length; i += 1) {
		total += distance(points[i], points[(i + 1) % points.length]);
	}
	return total;
}

/**
 * Put four corners in top-left, top-right, bottom-right, bottom-left order.
 *
 * Corners are sorted by their angle around the centroid, then rotated so the
 * corner closest to the top-left of the bounding box comes first. Sorting by
 * angle keeps the winding consistent, so the result never self-intersects,
 * no matter how the input was ordered.
 */
export function orderQuad(points: readonly Point[]): Quad {
	if (points.length !== 4) {
		throw new Error(`orderQuad expects 4 points, received ${points.length}`);
	}

	const center = {
		x: (points[0].x + points[1].x + points[2].x + points[3].x) / 4,
		y: (points[0].y + points[1].y + points[2].y + points[3].y) / 4,
	};

	// With y pointing down, an increasing angle runs clockwise on screen.
	const sorted = [...points].sort(
		(a, b) =>
			Math.atan2(a.y - center.y, a.x - center.x) -
			Math.atan2(b.y - center.y, b.x - center.x),
	);

	let startIndex = 0;
	let smallestSum = Number.POSITIVE_INFINITY;
	for (let i = 0; i < sorted.length; i += 1) {
		const sum = sorted[i].x + sorted[i].y;
		if (sum < smallestSum) {
			smallestSum = sum;
			startIndex = i;
		}
	}

	return {
		tl: sorted[startIndex],
		tr: sorted[(startIndex + 1) % 4],
		br: sorted[(startIndex + 2) % 4],
		bl: sorted[(startIndex + 3) % 4],
	};
}

/** Twice the signed area of the triangle a, b, c. */
function cross(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** True when every turn of the polygon has the same sign. */
export function isConvex(points: readonly Point[]): boolean {
	const count = points.length;
	if (count < 3) return false;

	let sign = 0;
	for (let i = 0; i < count; i += 1) {
		const turn = cross(
			points[i],
			points[(i + 1) % count],
			points[(i + 2) % count],
		);
		if (turn === 0) continue;
		const direction = Math.sign(turn);
		if (sign === 0) {
			sign = direction;
		} else if (direction !== sign) {
			return false;
		}
	}
	return sign !== 0;
}

export function isConvexQuad(quad: Quad): boolean {
	return isConvex(quadPoints(quad));
}

/** Interior angle at each corner, in radians, for a convex ordered quad. */
export function quadAngles(quad: Quad): [number, number, number, number] {
	const points = quadPoints(quad);
	return points.map((corner, i) => {
		const previous = points[(i + 3) % 4];
		const next = points[(i + 1) % 4];
		const incoming = {
			x: previous.x - corner.x,
			y: previous.y - corner.y,
		};
		const outgoing = {
			x: next.x - corner.x,
			y: next.y - corner.y,
		};
		const numerator = incoming.x * outgoing.x + incoming.y * outgoing.y;
		const denominator =
			Math.hypot(incoming.x, incoming.y) * Math.hypot(outgoing.x, outgoing.y);
		if (denominator === 0) return 0;
		return Math.acos(Math.max(-1, Math.min(1, numerator / denominator)));
	}) as [number, number, number, number];
}

/** Andrew's monotone chain. Returns the hull counter-clockwise, no duplicate. */
export function convexHull(points: readonly Point[]): Point[] {
	if (points.length < 3) return [...points];

	const sorted = [...points].sort((a, b) =>
		a.x === b.x ? a.y - b.y : a.x - b.x,
	);

	const build = (source: readonly Point[]): Point[] => {
		const chain: Point[] = [];
		for (const point of source) {
			while (
				chain.length >= 2 &&
				cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0
			) {
				chain.pop();
			}
			chain.push(point);
		}
		chain.pop();
		return chain;
	};

	const lower = build(sorted);
	const upper = build([...sorted].reverse());
	return [...lower, ...upper];
}

/** Distance from a point to the segment start-end. */
function perpendicularDistance(point: Point, start: Point, end: Point): number {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) {
		return Math.hypot(point.x - start.x, point.y - start.y);
	}
	const t =
		((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
	return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

/** Ramer-Douglas-Peucker on an open polyline. Keeps both ends. */
function simplifyPolyline(points: readonly Point[], epsilon: number): Point[] {
	if (points.length < 3) return [...points];

	const start = points[0];
	const end = points[points.length - 1];
	let farthestIndex = -1;
	let farthestDistance = 0;

	for (let i = 1; i < points.length - 1; i += 1) {
		const distance = perpendicularDistance(points[i], start, end);
		if (distance > farthestDistance) {
			farthestDistance = distance;
			farthestIndex = i;
		}
	}

	if (farthestIndex === -1 || farthestDistance <= epsilon) {
		return [start, end];
	}

	const left = simplifyPolyline(points.slice(0, farthestIndex + 1), epsilon);
	const right = simplifyPolyline(points.slice(farthestIndex), epsilon);
	return [...left.slice(0, -1), ...right];
}

/**
 * Ramer-Douglas-Peucker on a closed polygon. The polygon is walked as an open
 * polyline that returns to its first vertex, so the first vertex is pinned and
 * the farthest vertex from it becomes the split.
 */
function simplifyPolygon(points: readonly Point[], epsilon: number): Point[] {
	if (points.length <= 4) return [...points];
	const simplified = simplifyPolyline([...points, points[0]], epsilon);
	return simplified.slice(0, -1);
}

/** Upper bound on vertices fed to the exhaustive quad search, for speed. */
const MAX_QUAD_SEARCH_VERTICES = 80;

/**
 * The four vertices of a convex polygon that span the largest quadrilateral.
 *
 * Area is the right objective here. Dropping vertices by smallest triangle
 * area instead tends to round off shallow corners, because a corner between a
 * near-horizontal edge and a steep edge costs almost nothing to remove. The
 * largest inscribed quad always keeps the extreme vertices, which are the
 * document corners a perspective transform needs.
 */
export function maxAreaQuadFromPolygon(points: readonly Point[]): Point[] {
	if (points.length <= 4) return [...points];

	// Collapse near-collinear runs so the exhaustive search stays cheap, then
	// loosen until the candidate set fits. Epsilon starts below a pixel, so a
	// genuine corner is never dropped for a clean hull.
	let epsilon = 0.5;
	let candidates = simplifyPolygon(points, epsilon);
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (candidates.length <= MAX_QUAD_SEARCH_VERTICES) break;
		epsilon *= 2;
		candidates = simplifyPolygon(points, epsilon);
	}
	if (candidates.length < 4) return [...points].slice(0, 4);

	let best: Point[] = [];
	let bestArea = -1;
	const count = candidates.length;

	for (let a = 0; a < count - 3; a += 1) {
		const first = candidates[a];
		for (let b = a + 1; b < count - 2; b += 1) {
			const second = candidates[b];
			for (let c = b + 1; c < count - 1; c += 1) {
				const third = candidates[c];
				for (let d = c + 1; d < count; d += 1) {
					const fourth = candidates[d];
					// Shoelace in cyclic order, written out to avoid allocating
					// a polygon on every one of the millions of combinations.
					const area =
						Math.abs(
							first.x * (second.y - fourth.y) +
								second.x * (third.y - first.y) +
								third.x * (fourth.y - second.y) +
								fourth.x * (first.y - third.y),
						) / 2;
					if (area > bestArea) {
						bestArea = area;
						best = [first, second, third, fourth];
					}
				}
			}
		}
	}

	return best.length === 4 ? best : [...points].slice(0, 4);
}

/** Fit a quad to a convex hull, or return null when the hull is degenerate. */
export function quadFromHull(hull: readonly Point[]): Quad | null {
	if (hull.length < 4) return null;
	const corners = maxAreaQuadFromPolygon(hull);
	if (corners.length !== 4) return null;
	const quad = orderQuad(corners);
	if (quadArea(quad) <= 0) return null;
	return quad;
}

/** The image rectangle inset by `fraction` of its size on every side. */
export function insetFullQuad(
	width: number,
	height: number,
	fraction: number,
): Quad {
	const insetX = width * fraction;
	const insetY = height * fraction;
	return {
		tl: { x: insetX, y: insetY },
		tr: { x: width - insetX, y: insetY },
		br: { x: width - insetX, y: height - insetY },
		bl: { x: insetX, y: height - insetY },
	};
}

export function clampPointToBounds(
	point: Point,
	width: number,
	height: number,
): Point {
	return {
		x: Math.max(0, Math.min(width, point.x)),
		y: Math.max(0, Math.min(height, point.y)),
	};
}

/** True when the point lies inside the convex quad. */
export function quadContainsPoint(quad: Quad, point: Point): boolean {
	const points = quadPoints(quad);
	let sign = 0;

	for (let i = 0; i < points.length; i += 1) {
		const turn = cross(points[i], points[(i + 1) % 4], point);
		if (turn === 0) continue;
		const direction = Math.sign(turn);
		if (sign === 0) sign = direction;
		else if (direction !== sign) return false;
	}

	return sign !== 0;
}

/**
 * Move the whole quad by a delta, stopping at the image edge.
 *
 * The delta is limited by the corner closest to the edge it is moving toward,
 * so a drag that overshoots leaves the quad fully inside the image instead of
 * squashing it against the border.
 */
export function translateQuad(
	quad: Quad,
	deltaX: number,
	deltaY: number,
	width: number,
	height: number,
): Quad {
	const points = quadPoints(quad);
	const left = Math.min(...points.map((point) => point.x));
	const right = Math.max(...points.map((point) => point.x));
	const top = Math.min(...points.map((point) => point.y));
	const bottom = Math.max(...points.map((point) => point.y));

	const shiftX = Math.max(-left, Math.min(width - right, deltaX));
	const shiftY = Math.max(-top, Math.min(height - bottom, deltaY));

	return {
		tl: { x: quad.tl.x + shiftX, y: quad.tl.y + shiftY },
		tr: { x: quad.tr.x + shiftX, y: quad.tr.y + shiftY },
		br: { x: quad.br.x + shiftX, y: quad.br.y + shiftY },
		bl: { x: quad.bl.x + shiftX, y: quad.bl.y + shiftY },
	};
}

/** Scale a quad, for example from a downscaled copy back to the original. */
export function scaleQuad(quad: Quad, scaleX: number, scaleY: number): Quad {
	return {
		tl: { x: quad.tl.x * scaleX, y: quad.tl.y * scaleY },
		tr: { x: quad.tr.x * scaleX, y: quad.tr.y * scaleY },
		br: { x: quad.br.x * scaleX, y: quad.br.y * scaleY },
		bl: { x: quad.bl.x * scaleX, y: quad.bl.y * scaleY },
	};
}

export function quadsEqual(a: Quad, b: Quad, epsilon = 0.5): boolean {
	return quadPoints(a).every((point, i) => {
		const other = quadPoints(b)[i];
		return (
			Math.abs(point.x - other.x) <= epsilon &&
			Math.abs(point.y - other.y) <= epsilon
		);
	});
}
