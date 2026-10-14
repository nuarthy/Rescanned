import { RotateCcw, RotateCw } from "lucide-react";
import {
	type ChangeEvent,
	type DragEvent as ReactDragEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { CropEditor } from "#/components/CropEditor";
import { ResultPreview } from "#/components/ResultPreview";
import {
	type DetectionResult,
	detectDocumentQuadOrFallback,
} from "#/lib/detect";
import {
	normalizeTurns,
	type Quad,
	type QuarterTurns,
	quadsEqual,
	rotateQuad,
	scaleQuad,
} from "#/lib/geometry";
import {
	canvasFromPixels,
	DETECTION_DIMENSION,
	downloadBlob,
	encodeCanvas,
	ImageLoadError,
	isSupportedImageFile,
	type LoadedImage,
	loadImageFile,
	MAX_SOURCE_DIMENSION,
	PREVIEW_DIMENSION,
	QUICK_PREVIEW_DIMENSION,
	readCanvasPixels,
	scannedFileName,
} from "#/lib/imageFile";
import { warpQuadToRgba } from "#/lib/perspective";
import type { RgbaImage } from "#/lib/pixels";

/** Wait for the browser to paint before a long, blocking step. */
function nextFrame(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

type BusyState = "idle" | "loading" | "exporting";

export function DocumentScanner() {
	const [source, setSource] = useState<LoadedImage | null>(null);
	const [fileName, setFileName] = useState<string | null>(null);
	const [detection, setDetection] = useState<DetectionResult | null>(null);
	const [detectedQuad, setDetectedQuad] = useState<Quad | null>(null);
	const [quad, setQuad] = useState<Quad | null>(null);
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState<BusyState>("idle");
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<RgbaImage | null>(null);
	const [dragActive, setDragActive] = useState(false);
	const [dragging, setDragging] = useState(false);
	/** Clockwise quarter turns applied to the corrected page. */
	const [rotationTurns, setRotationTurns] = useState<QuarterTurns>(0);

	/** Full-resolution pixels of the current source, read once per upload. */
	const sourcePixelsRef = useRef<RgbaImage | null>(null);

	const reset = useCallback(() => {
		sourcePixelsRef.current = null;
		setSource(null);
		setFileName(null);
		setDetection(null);
		setDetectedQuad(null);
		setQuad(null);
		setPreview(null);
		setEditing(false);
		setRotationTurns(0);
		setError(null);
		setBusy("idle");
	}, []);

	const acceptFile = useCallback(
		async (file: File) => {
			if (!isSupportedImageFile(file)) {
				setError("Choose an image file, such as a JPEG, PNG, or WebP photo.");
				return;
			}

			setBusy("loading");
			setError(null);
			setPreview(null);
			setFileName(file.name);
			await nextFrame();

			try {
				const loaded = await loadImageFile(file, MAX_SOURCE_DIMENSION);
				sourcePixelsRef.current = readCanvasPixels(loaded.canvas);

				// Detection runs on a small copy; the quad is scaled back up so the
				// editor and the warp always speak in source pixels.
				const detectionPixels = readCanvasPixels(
					loaded.canvas,
					DETECTION_DIMENSION,
				);
				const result = detectDocumentQuadOrFallback(detectionPixels);
				const scaled = scaleQuad(
					result.quad,
					loaded.width / detectionPixels.width,
					loaded.height / detectionPixels.height,
				);

				setSource(loaded);
				setDetection(result);
				setDetectedQuad(scaled);
				setQuad(scaled);
				setEditing(false);
			} catch (cause) {
				reset();
				setError(
					cause instanceof ImageLoadError
						? cause.message
						: "This image could not be loaded.",
				);
			} finally {
				setBusy("idle");
			}
		},
		[reset],
	);

	const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (file) void acceptFile(file);
		// Reset so choosing the same file again still fires a change event.
		event.target.value = "";
	};

	const handleDrop = (event: ReactDragEvent<HTMLLabelElement>) => {
		event.preventDefault();
		setDragActive(false);
		const file = event.dataTransfer.files?.[0];
		if (file) void acceptFile(file);
	};

	// Rotation only renames corners, so the crop editor keeps working on the
	// photo as taken while the result and the download come out turned.
	const outputQuad = useMemo(
		() => (quad ? rotateQuad(quad, rotationTurns) : null),
		[quad, rotationTurns],
	);

	// Corrected preview.
	//
	// Warping a megapixel page on the main thread takes long enough to stall a
	// drag on a phone, so while a corner is moving the panel keeps the last
	// result. When the drag ends the page catches up in two passes: a cheap one
	// so the update looks immediate, then the full preview resolution.
	useEffect(() => {
		const pixels = sourcePixelsRef.current;
		if (!source || !outputQuad || !pixels) {
			setPreview(null);
			return;
		}
		if (dragging) return;

		let cancelled = false;
		const quick = window.setTimeout(() => {
			if (cancelled) return;
			setPreview(warpQuadToRgba(pixels, outputQuad, QUICK_PREVIEW_DIMENSION));
		}, 0);
		const full = window.setTimeout(() => {
			if (cancelled) return;
			setPreview(warpQuadToRgba(pixels, outputQuad, PREVIEW_DIMENSION));
		}, 150);

		return () => {
			cancelled = true;
			window.clearTimeout(quick);
			window.clearTimeout(full);
		};
	}, [source, outputQuad, dragging]);

	const handleDownload = async () => {
		const pixels = sourcePixelsRef.current;
		if (!pixels || !outputQuad) return;

		setBusy("exporting");
		setError(null);
		await nextFrame();

		try {
			const warped = warpQuadToRgba(pixels, outputQuad, MAX_SOURCE_DIMENSION);
			const blob = await encodeCanvas(
				canvasFromPixels(warped),
				"image/jpeg",
				0.92,
			);
			downloadBlob(blob, scannedFileName(fileName ?? "scan"));
		} catch (cause) {
			setError(
				cause instanceof Error
					? `The download failed: ${cause.message}`
					: "The download failed.",
			);
		} finally {
			setBusy("idle");
		}
	};

	const changedFromDetection =
		quad !== null &&
		detectedQuad !== null &&
		!quadsEqual(quad, detectedQuad, 1);

	return (
		<div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
			<header className="mb-8">
				<h1 className="text-2xl font-semibold tracking-tight text-slate-100 sm:text-3xl">
					Document scanner
				</h1>
				<p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">
					Upload a photo of a document. The page corners are found for you; if
					they are off, open the editor and drag them. Then download the
					straightened scan.
				</p>
			</header>

			{!source && (
				<UploadZone
					busy={busy === "loading"}
					dragActive={dragActive}
					onDragActiveChange={setDragActive}
					onDrop={handleDrop}
					onInputChange={handleInputChange}
				/>
			)}

			{error && (
				<p
					role="alert"
					className="mt-4 rounded-lg border border-rose-900/70 bg-rose-950/50 px-4 py-3 text-sm text-rose-200"
				>
					{error}
				</p>
			)}

			{source && quad && (
				<div className="grid gap-8 lg:grid-cols-2">
					<section>
						<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
							<h2 className="text-sm font-medium tracking-wide text-slate-300 uppercase">
								Crop
							</h2>
							<span className="truncate text-xs text-slate-500">
								{fileName}
							</span>
						</div>

						<CropEditor
							image={source.canvas}
							quad={quad}
							editable={editing}
							onChange={setQuad}
							onDragChange={setDragging}
						/>

						<div className="mt-4 flex flex-wrap gap-2">
							<button
								type="button"
								className={primaryButton}
								onClick={() => setEditing((value) => !value)}
							>
								{editing ? "Done editing" : "Edit corners"}
							</button>
							<button
								type="button"
								className={secondaryButton}
								disabled={!changedFromDetection}
								onClick={() => {
									if (detectedQuad) setQuad(detectedQuad);
								}}
							>
								Reset to detected
							</button>
							<button type="button" className={secondaryButton} onClick={reset}>
								New image
							</button>
						</div>

						<p className="mt-3 text-xs text-slate-500">
							{editing
								? "Drag any corner node to the page corner."
								: "Press Edit corners to move the crop nodes."}
						</p>

						{detection && <DetectionNote detection={detection} />}
					</section>

					<section>
						<h2 className="mb-3 text-sm font-medium tracking-wide text-slate-300 uppercase">
							Result
						</h2>
						{/* Faded while a corner moves, to show the page is catching up. */}
						<div
							className={
								dragging
									? "opacity-40 transition-opacity"
									: "transition-opacity"
							}
						>
							<ResultPreview pixels={preview} />
						</div>
						<div className="mt-4 flex w-full items-center gap-2 sm:w-auto">
							<button
								type="button"
								aria-label="Rotate 90 degrees anticlockwise"
								title="Rotate 90° anticlockwise"
								className={iconButton}
								onClick={() =>
									setRotationTurns((current) => normalizeTurns(current - 1))
								}
							>
								<RotateCcw className="h-5 w-5" aria-hidden="true" />
							</button>
							<button
								type="button"
								aria-label="Rotate 90 degrees clockwise"
								title="Rotate 90° clockwise"
								className={iconButton}
								onClick={() =>
									setRotationTurns((current) => normalizeTurns(current + 1))
								}
							>
								<RotateCw className="h-5 w-5" aria-hidden="true" />
							</button>
							<button
								type="button"
								className={`${primaryButton} flex-1 justify-center sm:flex-none`}
								disabled={busy === "exporting"}
								onClick={() => void handleDownload()}
							>
								{busy === "exporting" ? "Preparing…" : "Download"}
							</button>
						</div>
					</section>
				</div>
			)}
		</div>
	);
}

function DetectionNote({ detection }: { detection: DetectionResult }) {
	if (detection.method === "none") {
		return (
			<p className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
				The page was not detected clearly, so the crop shows the whole frame.
				Use Edit corners to set the page outline.
			</p>
		);
	}

	const label = detection.method === "region" ? "page area" : "page border";
	return (
		<p className="mt-4 text-xs text-slate-500">
			Detected from the {label} · confidence{" "}
			{Math.round(Math.min(1, Math.max(0, detection.score)) * 100)}%
		</p>
	);
}

interface UploadZoneProps {
	busy: boolean;
	dragActive: boolean;
	onDragActiveChange: (active: boolean) => void;
	onDrop: (event: ReactDragEvent<HTMLLabelElement>) => void;
	onInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

function UploadZone({
	busy,
	dragActive,
	onDragActiveChange,
	onDrop,
	onInputChange,
}: UploadZoneProps) {
	return (
		<label
			htmlFor="scanner-file"
			onDragOver={(event) => {
				event.preventDefault();
				onDragActiveChange(true);
			}}
			onDragLeave={() => onDragActiveChange(false)}
			onDrop={onDrop}
			className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-14 text-center transition ${
				dragActive
					? "border-sky-400 bg-sky-950/30"
					: "border-slate-700 bg-slate-900/50 hover:border-slate-500"
			}`}
		>
			<span className="text-base font-medium text-slate-200">
				{busy ? "Reading the image…" : "Choose a photo or drop it here"}
			</span>
			<span className="text-xs text-slate-500">
				JPEG, PNG, WebP, or HEIC where the browser can decode it
			</span>
			<input
				id="scanner-file"
				type="file"
				accept="image/*"
				className="sr-only"
				disabled={busy}
				onChange={onInputChange}
			/>
		</label>
	);
}

const primaryButton =
	"inline-flex items-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50";
const iconButton =
	"inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-slate-200 transition hover:border-slate-500 hover:bg-slate-800/60";
const secondaryButton =
	"inline-flex items-center rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-40";
