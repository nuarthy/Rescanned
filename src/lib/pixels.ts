/**
 * Small, dependency-free pixel operations.
 *
 * These helpers deliberately avoid DOM types so the detection pipeline can run
 * in a worker, in a test, or in the page. An `RgbaImage` is structurally
 * compatible with `ImageData`, so canvas output can be passed in directly.
 */

export interface RgbaImage {
	data: Uint8ClampedArray<ArrayBuffer>;
	width: number;
	height: number;
}

export interface GrayImage {
	data: Float32Array;
	width: number;
	height: number;
}

export interface Mask {
	data: Uint8Array;
	width: number;
	height: number;
}

export function createMask(width: number, height: number): Mask {
	return { data: new Uint8Array(width * height), width, height };
}

/** ITU-R BT.601 luma weights, also used for chroma work in the filters. */
export const LUMA_WEIGHTS = { red: 0.299, green: 0.587, blue: 0.114 } as const;

/** ITU-R BT.601 luma, kept on the 0..255 scale. */
export function toGray(image: RgbaImage): GrayImage {
	const { width, height, data } = image;
	const gray = new Float32Array(width * height);
	for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
		gray[i] =
			LUMA_WEIGHTS.red * data[p] +
			LUMA_WEIGHTS.green * data[p + 1] +
			LUMA_WEIGHTS.blue * data[p + 2];
	}
	return { data: gray, width, height };
}

/**
 * Box-average downscale, used to make detection cheap.
 *
 * When the target is only slightly smaller the scale factor rounds to 1 and the
 * input is returned unchanged, so callers never pay for a no-op copy.
 */
export function downscaleRgba(
	image: RgbaImage,
	maxDimension: number,
): RgbaImage {
	const { width, height } = image;
	const longest = Math.max(width, height);
	if (longest <= maxDimension) return image;

	const scale = maxDimension / longest;
	const targetWidth = Math.max(1, Math.round(width * scale));
	const targetHeight = Math.max(1, Math.round(height * scale));
	const output = new Uint8ClampedArray(targetWidth * targetHeight * 4);

	const blockWidth = width / targetWidth;
	const blockHeight = height / targetHeight;

	for (let y = 0; y < targetHeight; y += 1) {
		const sourceYStart = Math.floor(y * blockHeight);
		const sourceYEnd = Math.max(
			sourceYStart + 1,
			Math.floor((y + 1) * blockHeight),
		);
		for (let x = 0; x < targetWidth; x += 1) {
			const sourceXStart = Math.floor(x * blockWidth);
			const sourceXEnd = Math.max(
				sourceXStart + 1,
				Math.floor((x + 1) * blockWidth),
			);

			let red = 0;
			let green = 0;
			let blue = 0;
			let alpha = 0;
			let count = 0;

			for (let sy = sourceYStart; sy < sourceYEnd && sy < height; sy += 1) {
				for (let sx = sourceXStart; sx < sourceXEnd && sx < width; sx += 1) {
					const p = (sy * width + sx) * 4;
					red += image.data[p];
					green += image.data[p + 1];
					blue += image.data[p + 2];
					alpha += image.data[p + 3];
					count += 1;
				}
			}

			const target = (y * targetWidth + x) * 4;
			output[target] = red / count;
			output[target + 1] = green / count;
			output[target + 2] = blue / count;
			output[target + 3] = alpha / count;
		}
	}

	return { data: output, width: targetWidth, height: targetHeight };
}

function blurPass(
	source: Float32Array,
	target: Float32Array,
	width: number,
	height: number,
	radius: number,
	horizontal: boolean,
): void {
	const lineLength = horizontal ? width : height;
	const lineCount = horizontal ? height : width;
	const step = horizontal ? 1 : width;
	const lineStep = horizontal ? width : 1;
	const window = radius * 2 + 1;

	for (let line = 0; line < lineCount; line += 1) {
		const base = line * lineStep;
		let sum = 0;

		for (let i = -radius; i <= radius; i += 1) {
			const index = Math.min(lineLength - 1, Math.max(0, i));
			sum += source[base + index * step];
		}

		for (let i = 0; i < lineLength; i += 1) {
			target[base + i * step] = sum / window;

			const leaving = Math.min(lineLength - 1, Math.max(0, i - radius));
			const entering = Math.min(lineLength - 1, Math.max(0, i + radius + 1));
			sum += source[base + entering * step] - source[base + leaving * step];
		}
	}
}

/** Edge-clamped box blur. Two passes approximate a Gaussian well enough here. */
export function boxBlur(
	gray: GrayImage,
	radius: number,
	passes = 2,
): GrayImage {
	if (radius < 1) return gray;

	const { width, height } = gray;
	let source = gray.data;
	let first = new Float32Array(width * height);
	let second = new Float32Array(width * height);

	for (let pass = 0; pass < passes; pass += 1) {
		blurPass(source, first, width, height, radius, true);
		blurPass(first, second, width, height, radius, false);
		source = second;
		second = first;
		first = new Float32Array(width * height);
	}

	return { data: source, width, height };
}

/** Gradient magnitude from the 3x3 Sobel operator. */
export function sobelMagnitude(gray: GrayImage): GrayImage {
	const { width, height, data } = gray;
	const magnitude = new Float32Array(width * height);
	const at = (x: number, y: number): number => {
		const clampedX = x < 0 ? 0 : x >= width ? width - 1 : x;
		const clampedY = y < 0 ? 0 : y >= height ? height - 1 : y;
		return data[clampedY * width + clampedX];
	};

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const topLeft = at(x - 1, y - 1);
			const top = at(x, y - 1);
			const topRight = at(x + 1, y - 1);
			const left = at(x - 1, y);
			const right = at(x + 1, y);
			const bottomLeft = at(x - 1, y + 1);
			const bottom = at(x, y + 1);
			const bottomRight = at(x + 1, y + 1);

			const gradientX =
				-topLeft - 2 * left - bottomLeft + topRight + 2 * right + bottomRight;
			const gradientY =
				-topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;

			magnitude[y * width + x] = Math.hypot(gradientX, gradientY);
		}
	}

	return { data: magnitude, width, height };
}

export function minMax(data: Float32Array): { min: number; max: number } {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < data.length; i += 1) {
		const value = data[i];
		if (value < min) min = value;
		if (value > max) max = value;
	}
	if (min === Number.POSITIVE_INFINITY) return { min: 0, max: 0 };
	return { min, max };
}

/**
 * Otsu's method over 256 buckets spanning the observed value range.
 *
 * Returns the split value. When the image is flat the middle of the range is
 * returned, which keeps callers free of a special case.
 */
export function otsuThreshold(gray: GrayImage): number {
	const { min, max } = minMax(gray.data);
	if (max - min < 1e-6) return min;

	const binCount = 256;
	const scale = (binCount - 1) / (max - min);
	const histogram = new Float64Array(binCount);
	const binValue = new Float64Array(binCount);

	for (let i = 0; i < gray.data.length; i += 1) {
		const bin = Math.round((gray.data[i] - min) * scale);
		histogram[bin] += 1;
		binValue[bin] += gray.data[i];
	}

	const total = gray.data.length;
	let totalValue = 0;
	for (let bin = 0; bin < binCount; bin += 1) totalValue += binValue[bin];

	let backgroundWeight = 0;
	let backgroundValue = 0;
	let bestVariance = -1;
	let bestThreshold = min;

	for (let bin = 0; bin < binCount; bin += 1) {
		backgroundWeight += histogram[bin];
		if (backgroundWeight === 0) continue;

		const foregroundWeight = total - backgroundWeight;
		if (foregroundWeight === 0) break;

		backgroundValue += binValue[bin];
		const backgroundMean = backgroundValue / backgroundWeight;
		const foregroundMean = (totalValue - backgroundValue) / foregroundWeight;
		const between =
			backgroundWeight *
			foregroundWeight *
			(backgroundMean - foregroundMean) ** 2;

		if (between > bestVariance) {
			bestVariance = between;
			bestThreshold = min + (bin + 0.5) / scale;
		}
	}

	return bestThreshold;
}

/**
 * Separable max (dilate) or min (erode) filter with a square structuring element.
 *
 * On a binary mask, "is there a set pixel in the window" (dilate) and "is every
 * pixel in the window set" (erode) both follow from a sliding sum, so each pass
 * costs one add and one compare per pixel no matter how wide the radius is. That
 * matters here: detection runs this filter over the whole working copy several
 * times, and a naive window walk is what made detection slow on phones.
 */
export function morph(
	mask: Mask,
	radius: number,
	mode: "dilate" | "erode",
): Mask {
	if (radius < 1) return mask;

	const { width, height } = mask;
	const alongX = new Uint8Array(width * height);
	const output = createMask(width, height);
	const wantsSet = mode === "dilate";

	const line = Math.max(width, height);
	const running = new Int32Array(line + 1);

	const axis = (
		source: Uint8Array,
		target: Uint8Array,
		outer: number,
		inner: number,
		stride: number,
		step: number,
	) => {
		for (let o = 0; o < outer; o += 1) {
			let sum = 0;
			running[0] = 0;
			for (let i = 0; i < inner; i += 1) {
				sum += source[o * stride + i * step];
				running[i + 1] = sum;
			}
			for (let i = 0; i < inner; i += 1) {
				const from = i - radius < 0 ? 0 : i - radius;
				const to = i + radius > inner - 1 ? inner - 1 : i + radius;
				const set = running[to + 1] - running[from];
				const fits = wantsSet ? set > 0 : set === to - from + 1;
				target[o * stride + i * step] = fits ? 1 : 0;
			}
		}
	};

	// Rows, then columns: drawing the result of the first pass into `alongX`
	// keeps the second pass reading a flat buffer.
	axis(mask.data, alongX, height, width, width, 1);
	axis(alongX, output.data, width, height, 1, width);

	return output;
}

export function countMask(mask: Mask): number {
	let count = 0;
	for (let i = 0; i < mask.data.length; i += 1) count += mask.data[i];
	return count;
}

/**
 * Keep only the largest 8-connected blob.
 *
 * Returns null when the mask has no set pixels. This is the workhorse behind
 * "find the paper": the document is normally the biggest connected region.
 */
export function largestComponent(mask: Mask): Mask | null {
	const { width, height } = mask;
	const visited = new Uint8Array(width * height);
	const stack = new Int32Array(width * height);
	let best: number[] | null = null;

	for (let start = 0; start < mask.data.length; start += 1) {
		if (mask.data[start] === 0 || visited[start] === 1) continue;

		let top = 0;
		stack[top] = start;
		top += 1;
		visited[start] = 1;
		const component: number[] = [];

		while (top > 0) {
			top -= 1;
			const index = stack[top];
			component.push(index);

			const x = index % width;
			const y = (index - x) / width;

			for (let dy = -1; dy <= 1; dy += 1) {
				const nextY = y + dy;
				if (nextY < 0 || nextY >= height) continue;
				for (let dx = -1; dx <= 1; dx += 1) {
					if (dx === 0 && dy === 0) continue;
					const nextX = x + dx;
					if (nextX < 0 || nextX >= width) continue;
					const nextIndex = nextY * width + nextX;
					if (mask.data[nextIndex] === 0 || visited[nextIndex] === 1) continue;
					visited[nextIndex] = 1;
					stack[top] = nextIndex;
					top += 1;
				}
			}
		}

		if (best === null || component.length > best.length) {
			best = component;
		}
	}

	if (best === null) return null;

	const output = createMask(width, height);
	for (const index of best) output.data[index] = 1;
	return output;
}

export interface FloodOptions {
	/**
	 * How far below its own seed a region may spread, as a share of the
	 * distance from the seed's level to the dimmest level worth keeping.
	 */
	dropShare?: number;
	/** Maximum number of regions to grow. */
	maxRegions?: number;
	/** Dimmest level a region may start from. */
	minLevel?: number;
}

/**
 * Split a grayscale image into regions grown from its brightest pixels down.
 *
 * Each region starts at the brightest pixel no earlier region claimed, then
 * spreads to neighbouring pixels in descending brightness order until its
 * frontier drops `dropShare` of the seed's range below the seed. A stop level
 * relative to each seed lets one photo hold both a dim surface and a bright
 * page, which no single global threshold separates, and any dark boundary stops
 * a region, which is what keeps a page apart from a similar surface behind it.
 *
 * Regions come back largest first, and cover the image in a gradient only when
 * they meet no boundary at all.
 */
export function floodRegions(
	gray: GrayImage,
	options: FloodOptions = {},
): Mask[] {
	const dropShare = options.dropShare ?? 0.4;
	const maxRegions = options.maxRegions ?? 6;
	const minLevel = options.minLevel ?? 8;

	const { width, height, data } = gray;
	const count = width * height;
	const levels = new Uint8Array(count);
	for (let index = 0; index < count; index += 1) {
		const value = Math.round(data[index]);
		levels[index] = value < 0 ? 0 : value > 255 ? 255 : value;
	}

	// Pixels in ascending brightness, so each region can claim the brightest
	// pixel that nothing has claimed yet.
	const buckets: number[][] = [];
	for (let level = 0; level < 256; level += 1) buckets.push([]);
	const histogram = new Int32Array(257);
	for (let index = 0; index < count; index += 1)
		histogram[levels[index] + 1] += 1;
	for (let level = 0; level < 256; level += 1)
		histogram[level + 1] += histogram[level];
	const order = new Int32Array(count);
	const cursor = histogram.slice(0, 256);
	for (let index = 0; index < count; index += 1) {
		order[cursor[levels[index]]] = index;
		cursor[levels[index]] += 1;
	}

	const claimed = new Uint8Array(count);
	const inRegion = new Uint8Array(count);
	const queued = new Uint8Array(count);
	const regions: { mask: Mask; size: number }[] = [];

	let brightest = count - 1;
	while (regions.length < maxRegions && brightest >= 0) {
		while (brightest >= 0 && claimed[order[brightest]] === 1) brightest -= 1;
		if (brightest < 0) break;

		const seed = order[brightest];
		const seedLevel = levels[seed];
		if (seedLevel < minLevel) break;
		const stop = seedLevel - Math.round(dropShare * (seedLevel - minLevel));

		let high = seedLevel;
		buckets[seedLevel].push(seed);
		queued[seed] = 1;
		const members: number[] = [];

		while (high >= stop) {
			while (high >= stop && buckets[high].length === 0) high -= 1;
			if (high < stop) break;

			const index = buckets[high].pop() as number;
			if (inRegion[index] === 1) continue;
			inRegion[index] = 1;
			members.push(index);

			const x = index % width;
			const y = (index - x) / width;
			for (let dy = -1; dy <= 1; dy += 1) {
				const nextY = y + dy;
				if (nextY < 0 || nextY >= height) continue;
				for (let dx = -1; dx <= 1; dx += 1) {
					const nextX = x + dx;
					if (nextX < 0 || nextX >= width) continue;
					const nextIndex = nextY * width + nextX;
					if (inRegion[nextIndex] === 1) continue;
					if (claimed[nextIndex] === 1 || queued[nextIndex] === 1) continue;
					queued[nextIndex] = 1;
					const level = levels[nextIndex];
					buckets[level].push(nextIndex);
					if (level > high) high = level;
				}
			}
		}

		const mask = createMask(width, height);
		for (const index of members) {
			mask.data[index] = 1;
			claimed[index] = 1;
			inRegion[index] = 0;
		}
		// Frontier pixels the stop level cut adrift stay unclaimed, and are
		// available as seeds of their own once the brighter surfaces are taken.
		queued.fill(0);
		for (let level = 0; level < 256; level += 1) buckets[level].length = 0;
		if (members.length > 0) regions.push({ mask, size: members.length });
	}

	regions.sort((a, b) => b.size - a.size);
	return regions.map((region) => region.mask);
}

export type BorderSide = "top" | "right" | "bottom" | "left";

/**
 * Which outer rows and columns the mask touches.
 *
 * A region that reaches all four sides is the backdrop of the photo rather
 * than an object sitting on it, which is how detection tells them apart.
 */
export function touchedBorderSides(mask: Mask): Set<BorderSide> {
	const { width, height } = mask;
	const sides = new Set<BorderSide>();

	for (let x = 0; x < width; x += 1) {
		if (mask.data[x] === 1) sides.add("top");
		if (mask.data[(height - 1) * width + x] === 1) sides.add("bottom");
	}
	for (let y = 0; y < height; y += 1) {
		if (mask.data[y * width] === 1) sides.add("left");
		if (mask.data[y * width + width - 1] === 1) sides.add("right");
	}

	return sides;
}

/** Pixel centres of every set pixel, as points. */
export function maskToPoints(mask: Mask): { x: number; y: number }[] {
	const points: { x: number; y: number }[] = [];
	const { width } = mask;
	for (let index = 0; index < mask.data.length; index += 1) {
		if (mask.data[index] === 0) continue;
		const x = index % width;
		points.push({ x: x + 0.5, y: (index - x) / width + 0.5 });
	}
	return points;
}

/** Bilinear sample of a grayscale image at fractional coordinates. */
export function sampleGray(gray: GrayImage, x: number, y: number): number {
	const { width, height, data } = gray;
	const clampedX = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
	const clampedY = y < 0 ? 0 : y > height - 1 ? height - 1 : y;

	const x0 = Math.floor(clampedX);
	const y0 = Math.floor(clampedY);
	const x1 = Math.min(width - 1, x0 + 1);
	const y1 = Math.min(height - 1, y0 + 1);
	const fx = clampedX - x0;
	const fy = clampedY - y0;

	const topLeft = data[y0 * width + x0];
	const topRight = data[y0 * width + x1];
	const bottomLeft = data[y1 * width + x0];
	const bottomRight = data[y1 * width + x1];

	return (
		topLeft * (1 - fx) * (1 - fy) +
		topRight * fx * (1 - fy) +
		bottomLeft * (1 - fx) * fy +
		bottomRight * fx * fy
	);
}

/** Value at the given fraction of the sorted data (0 = min, 1 = max). */
export function percentileValue(
	data: Float32Array,
	fraction: number,
	maxSamples = 20000,
): number {
	const total = data.length;
	const stride = Math.max(1, Math.floor(total / maxSamples));
	const samples: number[] = [];
	for (let i = 0; i < total; i += stride) samples.push(data[i]);
	samples.sort((a, b) => a - b);
	if (samples.length === 0) return 0;
	const index = Math.min(
		samples.length - 1,
		Math.max(0, Math.round(fraction * (samples.length - 1))),
	);
	return samples[index];
}
