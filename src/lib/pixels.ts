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

/** ITU-R BT.601 luma, kept on the 0..255 scale. */
export function toGray(image: RgbaImage): GrayImage {
	const { width, height, data } = image;
	const gray = new Float32Array(width * height);
	for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
		gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
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

/** Separable max (dilate) or min (erode) filter with a square structuring element. */
export function morph(
	mask: Mask,
	radius: number,
	mode: "dilate" | "erode",
): Mask {
	if (radius < 1) return mask;

	const { width, height } = mask;
	const alongX = new Uint8Array(width * height);
	const output = createMask(width, height);
	const pick = mode === "dilate" ? Math.max : Math.min;

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
