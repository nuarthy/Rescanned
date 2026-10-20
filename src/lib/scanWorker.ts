/**
 * Worker that analyses and renders the photo.
 *
 * Finding the page in a photo and then warping and filtering it both take
 * hundreds of milliseconds on a phone. Doing them here keeps the main thread
 * free, so a drag stays smooth and a new photo appears without a freeze.
 *
 * The source pixels are sent once and kept; each request is then a few numbers.
 */

import { type Adjustments, applyAdjustments } from "./adjustments";
import { type DetectionResult, detectDocumentQuadOrFallback } from "./detect";
import { applyFilter, type DocumentFilter } from "./filters";
import type { Quad } from "./geometry";
import { type Orientation, orientRgba } from "./orientation";
import { applyShape, type OutputShape } from "./paper";
import { warpQuadToRgba } from "./perspective";
import type { RgbaImage } from "./pixels";

/** What a render needs, once it is the worker's turn to act on it. */
export interface RenderRequest {
	quad: Quad;
	maxDimension: number;
	filter: DocumentFilter;
	/** The sheet or ratio the page is stretched to, or the crop's shape. */
	shape: OutputShape;
	/** Slider values applied after the filter, before the shape. */
	adjustments: Adjustments;
	/** The turn and mirror the crop screen shows. */
	orientation: Orientation;
}

/** A render that also encodes the page, for a preview that only has to show it. */
export interface RenderImageRequest extends RenderRequest {
	encodeType: string;
	quality?: number;
}

export type ScanWorkerRequest =
	| { type: "source"; image: RgbaImage }
	| ({ type: "render"; id: number } & RenderRequest)
	| ({ type: "renderImage"; id: number } & RenderImageRequest)
	| { type: "detect"; id: number };

export type ScanWorkerResponse =
	| { type: "rendered"; id: number; image: RgbaImage }
	/**
	 * An encoded preview. `bytes` is null when this worker cannot encode, and
	 * the pixels come back instead so the caller encodes them itself.
	 */
	| {
			type: "image";
			id: number;
			bytes: ArrayBuffer | null;
			contentType: string | null;
			image?: RgbaImage;
	  }
	| { type: "detected"; id: number; result: DetectionResult };

/**
 * Encode pixels with an OffscreenCanvas, or report that this worker cannot.
 *
 * Encoding on this side keeps a preview change from blocking the main thread,
 * which is the whole reason the render happens here.
 */
async function encodeOffscreen(
	image: RgbaImage,
	type: string,
	quality?: number,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
	if (typeof OffscreenCanvas === "undefined") return null;

	try {
		const canvas = new OffscreenCanvas(image.width, image.height);
		const context = canvas.getContext("2d");
		if (!context) return null;
		// Same conversion the main thread uses, so both paths encode the same
		// pixels.
		const expected = image.width * image.height * 4;
		const data =
			image.data.length === expected
				? image.data
				: new Uint8ClampedArray(image.data);
		context.putImageData(new ImageData(data, image.width, image.height), 0, 0);
		const blob = await canvas.convertToBlob({ type, quality });
		return { bytes: await blob.arrayBuffer(), contentType: blob.type || type };
	} catch {
		return null;
	}
}

type WorkerScope = {
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<ScanWorkerRequest>) => void,
	): void;
	postMessage(message: ScanWorkerResponse, transfer: Transferable[]): void;
};

const scope = globalThis as unknown as WorkerScope;
let source: RgbaImage | null = null;

scope.addEventListener("message", async (event) => {
	const message = event.data;

	if (message.type === "source") {
		source = message.image;
		return;
	}

	if (!source) return;

	if (message.type === "renderImage") {
		const warped = warpQuadToRgba(source, message.quad, message.maxDimension);
		const image = applyShape(
			orientRgba(
				applyAdjustments(
					applyFilter(warped, message.filter),
					message.adjustments,
				),
				message.orientation,
			),
			message.shape,
			message.maxDimension,
		);
		const encoded = await encodeOffscreen(
			image,
			message.encodeType,
			message.quality,
		);

		if (encoded) {
			scope.postMessage(
				{
					type: "image",
					id: message.id,
					bytes: encoded.bytes,
					contentType: encoded.contentType,
				},
				[encoded.bytes],
			);
			return;
		}

		scope.postMessage(
			{ type: "image", id: message.id, bytes: null, contentType: null, image },
			[image.data.buffer],
		);
		return;
	}

	if (message.type === "detect") {
		// Corners come back in the coordinates of the source, so the caller
		// never has to know which size detection ran at.
		scope.postMessage(
			{
				type: "detected",
				id: message.id,
				result: detectDocumentQuadOrFallback(source),
			},
			[],
		);
		return;
	}

	const warped = warpQuadToRgba(source, message.quad, message.maxDimension);
	const image = applyShape(
		orientRgba(
			applyAdjustments(
				applyFilter(warped, message.filter),
				message.adjustments,
			),
			message.orientation,
		),
		message.shape,
		message.maxDimension,
	);

	// Hand the pixels over instead of copying them: a full-resolution page is
	// tens of megabytes.
	scope.postMessage({ type: "rendered", id: message.id, image }, [
		image.data.buffer,
	]);
});
