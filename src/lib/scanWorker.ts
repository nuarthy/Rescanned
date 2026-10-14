/**
 * Worker that analyses and renders the photo.
 *
 * Finding the page in a photo and then warping and filtering it both take
 * hundreds of milliseconds on a phone. Doing them here keeps the main thread
 * free, so a drag stays smooth and a new photo appears without a freeze.
 *
 * The source pixels are sent once and kept; each request is then a few numbers.
 */

import { type DetectionResult, detectDocumentQuadOrFallback } from "./detect";
import { applyFilter, type DocumentFilter } from "./filters";
import type { Quad } from "./geometry";
import { warpQuadToRgba } from "./perspective";
import type { RgbaImage } from "./pixels";

/** What a render needs, once it is the worker's turn to act on it. */
export interface RenderRequest {
	quad: Quad;
	maxDimension: number;
	filter: DocumentFilter;
}

export type ScanWorkerRequest =
	| { type: "source"; image: RgbaImage }
	| ({ type: "render"; id: number } & RenderRequest)
	| { type: "detect"; id: number };

export type ScanWorkerResponse =
	| { type: "rendered"; id: number; image: RgbaImage }
	| { type: "detected"; id: number; result: DetectionResult };

type WorkerScope = {
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<ScanWorkerRequest>) => void,
	): void;
	postMessage(message: ScanWorkerResponse, transfer: Transferable[]): void;
};

const scope = globalThis as unknown as WorkerScope;
let source: RgbaImage | null = null;

scope.addEventListener("message", (event) => {
	const message = event.data;

	if (message.type === "source") {
		source = message.image;
		return;
	}

	if (!source) return;

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
	const image = applyFilter(warped, message.filter);

	// Hand the pixels over instead of copying them: a full-resolution page is
	// tens of megabytes.
	scope.postMessage({ type: "rendered", id: message.id, image }, [
		image.data.buffer,
	]);
});
