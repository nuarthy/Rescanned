/**
 * Analyses and renders the photo, in a worker when the browser allows one.
 *
 * Callers only see promises, so the same code path covers the worker and the
 * on-main-thread fallback.
 */

import { type DetectionResult, detectDocumentQuadOrFallback } from "./detect";
import { applyFilter } from "./filters";
import { canvasFromPixels, encodeCanvas } from "./imageFile";
import { warpQuadToRgba } from "./perspective";
import type { RgbaImage } from "./pixels";
import type {
	RenderImageRequest,
	RenderRequest,
	ScanWorkerRequest,
	ScanWorkerResponse,
} from "./scanWorker";

/** Type and quality for the preview image the user can hold and copy. */
export const PREVIEW_IMAGE = { type: "image/jpeg", quality: 0.9 } as const;

export interface ScanRenderer {
	/** Store the source pixels. Safe to call again for a new photo. */
	setSource(pixels: RgbaImage): void;
	/** Find the page. Corners come back in the coordinates of the source. */
	detect(): Promise<DetectionResult>;
	/** Warped and filtered pixels, for a full-resolution export. */
	render(request: RenderRequest): Promise<RgbaImage>;
	/**
	 * The same page as an encoded image, for a preview that only has to be
	 * displayed and held. The worker encodes it when it can, so a preview change
	 * costs the main thread nothing but a new object URL.
	 */
	renderImage(request: RenderImageRequest): Promise<Blob>;
	dispose(): void;
}

function renderOnMainThread(
	source: RgbaImage,
	request: RenderRequest,
): RgbaImage {
	return applyFilter(
		warpQuadToRgba(source, request.quad, request.maxDimension),
		request.filter,
	);
}

function encodeOnMainThread(
	pixels: RgbaImage,
	request: RenderImageRequest,
): Promise<Blob> {
	return encodeCanvas(
		canvasFromPixels(pixels),
		request.encodeType,
		request.quality,
	);
}

class WorkerRenderer {
	private readonly worker: Worker;
	private readonly pending = new Map<
		number,
		{
			resolve: (response: ScanWorkerResponse) => void;
			reject: (error: Error) => void;
		}
	>();
	private nextId = 0;

	constructor() {
		this.worker = new Worker(new URL("./scanWorker.ts", import.meta.url), {
			type: "module",
		});
		this.worker.addEventListener(
			"message",
			(event: MessageEvent<ScanWorkerResponse>) => {
				const entry = this.pending.get(event.data.id);
				if (!entry) return;
				this.pending.delete(event.data.id);
				entry.resolve(event.data);
			},
		);
		// A worker that cannot start or that dies must not leave callers waiting
		// forever; rejecting lets the caller fall back.
		this.worker.addEventListener("error", () => {
			this.fail(new Error("The worker failed."));
		});
	}

	setSource(pixels: RgbaImage): void {
		// A copy rather than a transfer: the caller keeps its pixels so it can
		// still render if the worker turns out to be unusable.
		this.worker.postMessage({ type: "source", image: pixels });
	}

	async detect(): Promise<DetectionResult> {
		this.nextId += 1;
		const response = await this.send({
			type: "detect",
			id: this.nextId,
		});
		if (response.type !== "detected") {
			throw new Error("The worker answered a detection with a render.");
		}
		return response.result;
	}

	async render(request: RenderRequest): Promise<RgbaImage> {
		this.nextId += 1;
		const response = await this.send({
			type: "render",
			id: this.nextId,
			...request,
		});
		if (response.type !== "rendered") {
			throw new Error("The worker answered a render with another request.");
		}
		return response.image;
	}

	async renderImage(request: RenderImageRequest): Promise<Blob | null> {
		this.nextId += 1;
		const response = await this.send({
			type: "renderImage",
			id: this.nextId,
			...request,
		});
		if (response.type !== "image") {
			throw new Error(
				"The worker answered an image render with another request.",
			);
		}
		if (response.bytes === null) return null;
		return new Blob([response.bytes], {
			type: response.contentType ?? request.encodeType,
		});
	}

	dispose(): void {
		this.fail(new Error("The worker was disposed."));
		this.worker.terminate();
	}

	private send(
		request: Extract<ScanWorkerRequest, { id: number }>,
	): Promise<ScanWorkerResponse> {
		return new Promise<ScanWorkerResponse>((resolve, reject) => {
			this.pending.set(request.id, { resolve, reject });
			this.worker.postMessage(request);
		});
	}

	private fail(error: Error): void {
		for (const entry of this.pending.values()) entry.reject(error);
		this.pending.clear();
	}
}

/**
 * A renderer that starts on a worker and quietly drops to the main thread if
 * the worker is unavailable or fails, so detection and rendering always work.
 */
class ResilientRenderer implements ScanRenderer {
	private source: RgbaImage | null = null;
	private worker: WorkerRenderer | null = null;
	private workerFailed = false;

	constructor() {
		if (typeof Worker === "undefined") {
			this.workerFailed = true;
			return;
		}
		try {
			this.worker = new WorkerRenderer();
		} catch {
			this.workerFailed = true;
		}
	}

	setSource(pixels: RgbaImage): void {
		this.source = pixels;
		if (!this.workerFailed) this.worker?.setSource(pixels);
	}

	async detect(): Promise<DetectionResult> {
		if (!this.workerFailed && this.worker) {
			try {
				return await this.worker.detect();
			} catch {
				this.dropWorker();
			}
		}

		if (!this.source) throw new Error("No source image to find a page in.");
		return detectDocumentQuadOrFallback(this.source);
	}

	async render(request: RenderRequest): Promise<RgbaImage> {
		if (!this.workerFailed && this.worker) {
			try {
				return await this.worker.render(request);
			} catch {
				this.dropWorker();
			}
		}

		if (!this.source) throw new Error("No source image to render.");
		return renderOnMainThread(this.source, request);
	}

	async renderImage(request: RenderImageRequest): Promise<Blob> {
		const source = this.source;
		if (!source) throw new Error("No source image to render.");

		if (!this.workerFailed && this.worker) {
			try {
				const blob = await this.worker.renderImage(request);
				if (blob) return blob;
				// The worker could not encode; it warped the page for us. Reuse it
				// rather than warping twice.
				const pixels = await this.worker.render(request);
				return await encodeOnMainThread(pixels, request);
			} catch {
				this.dropWorker();
			}
		}

		return encodeOnMainThread(renderOnMainThread(source, request), request);
	}

	dispose(): void {
		this.dropWorker();
		this.source = null;
	}

	private dropWorker(): void {
		this.worker?.dispose();
		this.worker = null;
		this.workerFailed = true;
	}
}

export function createScanRenderer(): ScanRenderer {
	return new ResilientRenderer();
}
