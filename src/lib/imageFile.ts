/**
 * Browser glue: files in, canvases out.
 *
 * Everything else in `lib` is free of DOM types so it can be tested and
 * eventually moved into a worker. This module is the only place that touches
 * `File`, `Image`, and `canvas`.
 */

import type { RgbaImage } from "./pixels";

/** Longest side kept from the uploaded photo, to stay inside canvas limits. */
export const MAX_SOURCE_DIMENSION = 3500;
/** Longest side of the first, cheap detection pass. */
export const DETECTION_DIMENSION = 640;
/** Longest side of the settled corrected preview. */
export const PREVIEW_DIMENSION = 1000;
/** Longest side of the first, cheap preview pass. */
export const QUICK_PREVIEW_DIMENSION = 420;

export interface LoadedImage {
	canvas: HTMLCanvasElement;
	width: number;
	height: number;
}

export class ImageLoadError extends Error {}

export function isSupportedImageFile(file: File): boolean {
	return file.type.startsWith("image/");
}

/**
 * Decode a file into a canvas, downscaling oversized photos.
 *
 * Drawing through an `Image` element lets the browser apply EXIF orientation,
 * so photos from phones arrive the right way up without extra work.
 */
export async function loadImageFile(
	file: File,
	maxDimension = MAX_SOURCE_DIMENSION,
): Promise<LoadedImage> {
	const url = URL.createObjectURL(file);
	try {
		const image = await decodeImage(url);
		const longest = Math.max(image.naturalWidth, image.naturalHeight);
		if (longest === 0) throw new ImageLoadError("The image has no pixels.");

		const scale = longest > maxDimension ? maxDimension / longest : 1;
		const width = Math.max(1, Math.round(image.naturalWidth * scale));
		const height = Math.max(1, Math.round(image.naturalHeight * scale));

		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new ImageLoadError("Canvas 2D is unavailable.");
		context.imageSmoothingQuality = "high";
		context.drawImage(image, 0, 0, width, height);

		return { canvas, width, height };
	} finally {
		URL.revokeObjectURL(url);
	}
}

function decodeImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.decoding = "async";
		image.onload = () => resolve(image);
		image.onerror = () =>
			reject(new ImageLoadError("This file could not be decoded as an image."));
		image.src = url;
	});
}

/** Read a canvas back as raw pixels, optionally downscaled. */
export function readCanvasPixels(
	canvas: HTMLCanvasElement,
	maxDimension?: number,
): RgbaImage {
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) throw new ImageLoadError("Canvas 2D is unavailable.");
	const imageData = context.getImageData(0, 0, canvas.width, canvas.height);

	const pixels: RgbaImage = {
		data: imageData.data,
		width: imageData.width,
		height: imageData.height,
	};

	if (!maxDimension || Math.max(pixels.width, pixels.height) <= maxDimension) {
		return pixels;
	}

	// Downscale through an offscreen canvas; the browser's filter is faster and
	// better than anything hand-rolled here.
	const scale = maxDimension / Math.max(pixels.width, pixels.height);
	const small = document.createElement("canvas");
	small.width = Math.max(1, Math.round(pixels.width * scale));
	small.height = Math.max(1, Math.round(pixels.height * scale));
	const smallContext = small.getContext("2d", { willReadFrequently: true });
	if (!smallContext) throw new ImageLoadError("Canvas 2D is unavailable.");
	smallContext.imageSmoothingQuality = "high";
	smallContext.drawImage(canvas, 0, 0, small.width, small.height);
	const smallData = smallContext.getImageData(0, 0, small.width, small.height);

	return {
		data: smallData.data,
		width: smallData.width,
		height: smallData.height,
	};
}

export function toImageData(pixels: RgbaImage): ImageData {
	const expected = pixels.width * pixels.height * 4;
	const data =
		pixels.data.length === expected
			? pixels.data
			: new Uint8ClampedArray(pixels.data);
	return new ImageData(data, pixels.width, pixels.height);
}

export function canvasFromPixels(pixels: RgbaImage): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = pixels.width;
	canvas.height = pixels.height;
	const context = canvas.getContext("2d");
	if (context) context.putImageData(toImageData(pixels), 0, 0);
	return canvas;
}

export function encodeCanvas(
	canvas: HTMLCanvasElement,
	type = "image/jpeg",
	quality = 0.92,
): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new ImageLoadError("The image could not be encoded."));
			},
			type,
			quality,
		);
	});
}

/** Strip the original extension and add the scanned one. */
export function scannedFileName(
	originalName: string,
	extension = "jpg",
): string {
	const base = originalName.replace(/\.[^./\\]+$/, "") || "scan";
	return `${base}-scan.${extension}`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.rel = "noopener";
	document.body.append(link);
	link.click();
	link.remove();
	// Revoke late: Safari needs the URL to stay alive while the download starts.
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
