import {
	ArrowLeft,
	FlipHorizontal2,
	FlipVertical2,
	ImagePlus,
	Redo2,
	RotateCcw,
	RotateCw,
	Undo2,
} from "lucide-react";
import {
	type ChangeEvent,
	type DragEvent as ReactDragEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { CropEditor } from "#/components/CropEditor";
import { Histogram } from "#/components/Histogram";
import { OptionSelect } from "#/components/OptionSelect";
import { ResultPreview } from "#/components/ResultPreview";
import {
	ADJUSTMENT_SLIDERS,
	type Adjustments,
	isNeutral,
	NEUTRAL_ADJUSTMENTS,
} from "#/lib/adjustments";
import type { DetectionResult } from "#/lib/detect";
import { DOCUMENT_FILTERS, type DocumentFilter } from "#/lib/filters";
import { type Quad, quadPoints } from "#/lib/geometry";
import {
	canvasFromPixels,
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
import {
	isUpright,
	normalizeTurns,
	type Orientation,
	UPRIGHT,
} from "#/lib/orientation";
import {
	ASPECT_RATIOS,
	exportSize,
	type OutputShape,
	PAPER_SIZES,
	shapeFromValue,
	shapeValue,
} from "#/lib/paper";
import {
	createScanRenderer,
	PREVIEW_IMAGE,
	type ScanRenderer,
} from "#/lib/scanRenderer";

/** Wait for the browser to paint before a long, blocking step. */
function nextFrame(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

type BusyState = "idle" | "loading" | "exporting";
/** Which half of the flow the screen shows. The two never share a screen. */
type Stage = "crop" | "adjust";
type CardId = "looks" | "light" | "colour" | "resize" | "rotate";
type Compare = "after" | "before";

/** Everything the undo stack restores. */
interface Snapshot {
	quad: Quad | null;
	filter: DocumentFilter;
	shape: OutputShape;
	adjustments: Adjustments;
	orientation: Orientation;
}

export function DocumentScanner() {
	const [source, setSource] = useState<LoadedImage | null>(null);
	const [fileName, setFileName] = useState<string | null>(null);
	const [detection, setDetection] = useState<DetectionResult | null>(null);
	const [quad, setQuad] = useState<Quad | null>(null);
	const [stage, setStage] = useState<Stage>("crop");
	const [compare, setCompare] = useState<Compare>("after");
	const [zoom, setZoom] = useState(1);
	/** Which card the phone shows in the bottom sheet, if any. */
	const [sheet, setSheet] = useState<CardId | null>(null);
	const isDesktop = useMediaQuery("(min-width: 1024px)");
	const [busy, setBusy] = useState<BusyState>("idle");
	const [error, setError] = useState<string | null>(null);
	/** Encoded preview image, the thing the user holds to copy or save. */
	const [preview, setPreview] = useState<Blob | null>(null);
	const [dragActive, setDragActive] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [orientation, setOrientation] = useState<Orientation>(UPRIGHT);
	const [filter, setFilter] = useState<DocumentFilter>("original");
	/** The shape the result is stretched to: the crop's own, a paper, or a ratio. */
	const [shape, setShape] = useState<OutputShape>({ kind: "original" });
	const [adjustments, setAdjustments] =
		useState<Adjustments>(NEUTRAL_ADJUSTMENTS);
	/**
	 * Sliders settle before the preview is rebuilt.
	 *
	 * A range input fires on every pixel of travel, and each render warps and
	 * encodes the page. Rendering every event would queue dozens of passes and
	 * leave the slider stuttering behind the image, so the preview follows the
	 * settled value. The download reads the live value.
	 */
	const settledAdjustments = useDebounced(adjustments, 90);

	/**
	 * Renders the corrected page. Warping and filtering a megapixel image takes
	 * hundreds of milliseconds on a phone, so it runs in a worker when it can.
	 */
	const rendererRef = useRef<ScanRenderer | null>(null);

	const reset = useCallback(() => {
		rendererRef.current?.dispose();
		rendererRef.current = null;
		setSource(null);
		setFileName(null);
		setDetection(null);
		setQuad(null);
		setPreview(null);
		setStage("crop");
		setSheet(null);
		setCompare("after");
		setZoom(1);
		setOrientation(UPRIGHT);
		setFilter("original");
		setShape({ kind: "original" });
		setAdjustments(NEUTRAL_ADJUSTMENTS);
		setDragging(false);
		setError(null);
		setBusy("idle");
		setHistory({ entries: [], index: -1 });
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

				// One renderer per photo, so a worker from a previous photo cannot
				// answer for this one. It also finds the page, off the main
				// thread, and reports corners in source pixels.
				rendererRef.current?.dispose();
				const renderer = createScanRenderer();
				rendererRef.current = renderer;
				renderer.setSource(readCanvasPixels(loaded.canvas));
				const result = await renderer.detect();

				setSource(loaded);
				setDetection(result);
				setQuad(result.quad);
				setStage("crop");
				setHistory({ entries: [], index: -1 });
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

	// Corrected preview.
	//
	// Warping a megapixel page on the main thread takes long enough to stall a
	// drag on a phone, so while a corner is moving the panel keeps the last
	// result. When the drag ends the page catches up in two passes: a cheap one
	// so the update looks immediate, then the full preview resolution.
	//
	// "Before" renders the same crop with no look and no adjustments, so the
	// toggle compares two states of one page rather than two pages.
	useEffect(() => {
		const renderer = rendererRef.current;
		if (!source || !quad || !renderer) {
			setPreview(null);
			return;
		}
		if (dragging) return;

		let cancelled = false;
		const request = (maxDimension: number) => {
			renderer
				.renderImage({
					quad,
					maxDimension,
					filter: compare === "before" ? "original" : filter,
					shape,
					adjustments:
						compare === "before" ? NEUTRAL_ADJUSTMENTS : settledAdjustments,
					orientation,
					encodeType: PREVIEW_IMAGE.type,
					quality: PREVIEW_IMAGE.quality,
				})
				.then((image) => {
					// A render that finished after a newer one started is dropped.
					if (!cancelled) setPreview(image);
				})
				.catch(() => {
					// Superseded renders need no report; a render that cannot run at
					// all still surfaces through the download path.
				});
		};

		const quick = window.setTimeout(() => request(QUICK_PREVIEW_DIMENSION), 0);
		const full = window.setTimeout(() => request(PREVIEW_DIMENSION), 150);

		return () => {
			cancelled = true;
			window.clearTimeout(quick);
			window.clearTimeout(full);
		};
	}, [
		source,
		quad,
		dragging,
		filter,
		shape,
		settledAdjustments,
		compare,
		orientation,
	]);

	// Release the worker when the scanner goes away.
	useEffect(
		() => () => {
			rendererRef.current?.dispose();
			rendererRef.current = null;
		},
		[],
	);

	const [history, setHistory] = useState<{ entries: string[]; index: number }>({
		entries: [],
		index: -1,
	});

	const snapshot = useMemo(
		() =>
			JSON.stringify({
				quad,
				filter,
				shape,
				adjustments,
				orientation,
			} satisfies Snapshot),
		[quad, filter, shape, adjustments, orientation],
	);

	const applySnapshot = useCallback((value: string) => {
		const parsed = JSON.parse(value) as Snapshot;
		setQuad(parsed.quad);
		setFilter(parsed.filter);
		setShape(parsed.shape);
		setAdjustments(parsed.adjustments);
		setOrientation({
			...parsed.orientation,
			turns: normalizeTurns(parsed.orientation.turns),
		});
	}, []);

	// A short quiet period, rather than one entry per slider event, keeps the
	// stack small enough to step through.
	useEffect(() => {
		if (!source) return;
		const timer = window.setTimeout(() => {
			setHistory((current) => {
				if (current.entries[current.index] === snapshot) return current;
				const entries = [
					...current.entries.slice(0, current.index + 1),
					snapshot,
				];
				return { entries, index: entries.length - 1 };
			});
		}, 350);
		return () => window.clearTimeout(timer);
	}, [snapshot, source]);

	const undo = () => {
		if (history.index <= 0) return;
		setHistory({ ...history, index: history.index - 1 });
		applySnapshot(history.entries[history.index - 1]);
	};

	const redo = () => {
		if (history.index >= history.entries.length - 1) return;
		setHistory({ ...history, index: history.index + 1 });
		applySnapshot(history.entries[history.index + 1]);
	};

	const handleDownload = async () => {
		const renderer = rendererRef.current;
		if (!renderer || !quad) return;

		setBusy("exporting");
		setError(null);
		await nextFrame();

		try {
			const rendered = await renderer.render({
				quad,
				maxDimension: MAX_SOURCE_DIMENSION,
				filter,
				shape,
				adjustments,
				orientation,
			});
			const blob = await encodeCanvas(
				canvasFromPixels(rendered),
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

	// The crop chip and the panel readout both report the file the app would
	// save, so the two screens can never disagree.
	const cropDimensions = quad ? cropSize(quad) : { width: 0, height: 0 };
	const saved = quad
		? exportSize(cropDimensions, shape, orientation, MAX_SOURCE_DIMENSION)
		: null;
	const cropLabel = saved ? `${saved.width} × ${saved.height}` : "";

	const adjustCards: { id: CardId; label: string; content: ReactNode }[] = [
		{
			id: "looks",
			label: "Looks",
			content: (
				<section className={card}>
					<CardHead
						title="Looks"
						onReset={() => setFilter("original")}
						disabled={filter === "original"}
					/>
					<div className="flex flex-wrap gap-1.5">
						{DOCUMENT_FILTERS.map((option) => (
							<button
								key={option.id}
								type="button"
								aria-pressed={filter === option.id}
								className={
									filter === option.id
										? "rounded-full border border-transparent bg-[#1c1c1e] px-3 py-1.5 text-[11.5px] text-white"
										: "rounded-full border border-transparent bg-[#f3f3f1] px-3 py-1.5 text-[11.5px] text-[#1c1c1e]"
								}
								onClick={() => setFilter(option.id)}
							>
								{option.label}
							</button>
						))}
					</div>
				</section>
			),
		},
		{
			id: "light",
			label: "Light",
			content: (
				<section className={card}>
					<CardHead
						title="Light"
						onReset={() =>
							setAdjustments({
								...adjustments,
								brightness: 0,
								contrast: 0,
								highlights: 0,
								shadows: 0,
							})
						}
						disabled={
							adjustments.brightness === 0 &&
							adjustments.contrast === 0 &&
							adjustments.highlights === 0 &&
							adjustments.shadows === 0
						}
					/>
					<Histogram image={preview} />
					<p className="mb-1 text-[9.5px] font-semibold tracking-[0.12em] text-[#b0b0ac]">
						EXPOSURE
					</p>
					<AdjustmentSliders
						adjustments={adjustments}
						ids={["brightness", "contrast", "highlights", "shadows"]}
						onChange={setAdjustments}
					/>
				</section>
			),
		},
		{
			id: "colour",
			label: "Colour",
			content: (
				<section className={card}>
					<CardHead
						title="Colour"
						onReset={() => setAdjustments({ ...adjustments, saturation: 0 })}
						disabled={adjustments.saturation === 0}
					/>
					<AdjustmentSliders
						adjustments={adjustments}
						ids={["saturation"]}
						onChange={setAdjustments}
					/>
				</section>
			),
		},
		{
			id: "resize",
			label: "Resize",
			content: (
				<section className={card}>
					<CardHead
						title="Resize"
						onReset={() => setShape({ kind: "original" })}
						disabled={shape.kind === "original"}
					/>
					<OptionSelect
						label="Resize"
						value={shapeValue(shape)}
						options={[{ value: "original", label: "Original size" }]}
						groups={[
							{
								label: "Paper",
								options: PAPER_SIZES.map((size) => ({
									value: shapeValue({ kind: "paper", id: size.id }),
									label: size.label,
								})),
							},
							{
								label: "Ratio",
								options: ASPECT_RATIOS.map((ratio) => ({
									value: shapeValue({ kind: "ratio", id: ratio.id }),
									label: ratio.label,
								})),
							},
						]}
						onChange={(next) => setShape(shapeFromValue(next))}
					/>
					<p className="mt-1.5 text-[11px] text-[#8e8e93] tabular-nums">
						{saved ? `${saved.width} × ${saved.height} px` : "—"}
					</p>
				</section>
			),
		},
		{
			id: "rotate",
			label: "Rotate",
			content: (
				<section className={card}>
					<CardHead
						title="Rotate & flip"
						onReset={() => setOrientation(UPRIGHT)}
						disabled={isUpright(orientation)}
					/>
					<OrientationButtons
						orientation={orientation}
						onChange={setOrientation}
					/>
				</section>
			),
		},
	];

	if (!source || !quad) {
		return (
			<div className="flex h-dvh flex-col overflow-hidden bg-[#dcdcda] text-[#1c1c1e]">
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 pb-10">
					<div className="flex items-center gap-3">
						{/* The mark is drawn in white for dark surfaces; invert makes it
						    the same gradient in ink. */}
						<img
							src="/rescanned-mark.svg"
							alt=""
							aria-hidden="true"
							className="h-10 w-auto invert"
						/>
						<span className="text-2xl font-semibold tracking-tight">
							Rescanned
						</span>
					</div>

					{error && (
						<p
							role="alert"
							className="max-w-[320px] rounded-xl border border-[#e6b3ae] bg-[#fdecea] px-3 py-2 text-center text-xs text-[#8a2a20]"
						>
							{error}
						</p>
					)}

					<UploadScreen
						busy={busy === "loading"}
						dragActive={dragActive}
						onDragActiveChange={setDragActive}
						onDrop={handleDrop}
						onInputChange={handleInputChange}
					/>

					<p className="max-w-[320px] text-center text-xs leading-relaxed text-[#8e8e93]">
						Turn a photo of a document into a straight, cropped scan. Everything
						runs in your browser, so the photo never leaves the device.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-dvh flex-col overflow-hidden bg-[#dcdcda] text-[#1c1c1e]">
			<header className="flex w-full shrink-0 items-center justify-between gap-2 px-3 py-2.5">
				<div className="flex items-center gap-1.5">
					{stage === "adjust" ? (
						<button
							type="button"
							className="inline-flex items-center gap-1 rounded-full border border-[#cfcfca] bg-white/90 px-2.5 py-1.5 text-xs font-medium"
							onClick={() => setStage("crop")}
						>
							<ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
							Crop
						</button>
					) : (
						<button
							type="button"
							aria-label="Start over"
							className="grid h-8 w-8 place-items-center rounded-full border border-[#cfcfca] bg-white/90"
							onClick={reset}
						>
							<span className="text-sm leading-none">✕</span>
						</button>
					)}
				</div>
				<div className="flex items-center gap-1.5">
					{stage === "adjust" && (
						<button
							type="button"
							disabled={isNeutral(adjustments) && filter === "original"}
							className="rounded-full border border-[#cfcfca] bg-white/90 px-2.5 py-1.5 text-[11px] font-medium text-[#1c1c1e] disabled:opacity-40"
							onClick={() => {
								setAdjustments(NEUTRAL_ADJUSTMENTS);
								setFilter("original");
							}}
						>
							Reset all
						</button>
					)}
					<button
						type="button"
						aria-label="Undo"
						disabled={history.index <= 0}
						className="grid h-8 w-8 place-items-center rounded-full border border-[#cfcfca] bg-white/90 disabled:opacity-40"
						onClick={undo}
					>
						<Undo2 className="h-4 w-4" aria-hidden="true" />
					</button>
					<button
						type="button"
						aria-label="Redo"
						disabled={history.index >= history.entries.length - 1}
						className="grid h-8 w-8 place-items-center rounded-full border border-[#cfcfca] bg-white/90 disabled:opacity-40"
						onClick={redo}
					>
						<Redo2 className="h-4 w-4" aria-hidden="true" />
					</button>
					{stage === "adjust" && (
						<button
							type="button"
							disabled={busy === "exporting"}
							className="rounded-full bg-[#1c1c1e] px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
							onClick={() => void handleDownload()}
						>
							{busy === "exporting" ? "Saving…" : "Save image"}
						</button>
					)}
				</div>
			</header>

			{error && (
				<p
					role="alert"
					className="mx-3 mb-2 rounded-xl border border-[#e6b3ae] bg-[#fdecea] px-3 py-2 text-xs text-[#8a2a20]"
				>
					{error}
				</p>
			)}

			<div
				className={`flex min-h-0 w-full flex-1 gap-1.5 px-3 pb-3 ${
					stage === "adjust" ? "flex-col lg:flex-row lg:gap-4" : "flex-col"
				}`}
			>
				{stage === "crop" ? (
					<>
						<div className="flex min-h-0 flex-1 items-center justify-center">
							<CropEditor
								image={source.canvas}
								quad={quad}
								orientation={orientation}
								zoom={zoom}
								onChange={setQuad}
								onDragChange={setDragging}
							/>
						</div>
						{/* The size sits above the zoom control, so it stays put
						    whatever the photo does behind it. */}
						<div className="flex shrink-0 justify-center">
							<span className="rounded-md bg-[#1c1c1e]/85 px-2 py-0.5 text-[10px] whitespace-nowrap text-white tabular-nums">
								{cropLabel}
							</span>
						</div>
						<ZoomRow zoom={zoom} onChange={setZoom} />
						<div className="flex flex-wrap items-center justify-center gap-1.5">
							<button
								type="button"
								className={tool}
								onClick={() => setQuad(detection?.quad ?? quad)}
							>
								Reset
							</button>
							<OrientationButtons
								orientation={orientation}
								onChange={setOrientation}
							/>
							<button
								type="button"
								className="rounded-full bg-[#1c1c1e] px-3.5 py-1.5 text-xs font-semibold text-white"
								onClick={() => setStage("adjust")}
							>
								Apply crop
							</button>
						</div>
						{detection && (
							<p className="text-center text-[11px] text-[#8e8e93]">
								{detection.method === "none"
									? "No clear page edge found. Drag the corners to the page."
									: `Detected from the ${detection.method === "region" ? "page area" : "page border"} · confidence ${Math.round(
											Math.min(1, Math.max(0, detection.score)) * 100,
										)}%`}
							</p>
						)}
					</>
				) : (
					<>
						<div className="flex min-h-0 flex-1 flex-col gap-2">
							{/* A fixed box for the page: it starts at the left edge, ends
							    at the tool rail, and runs from under the header to above
							    the toggles. The page is fitted inside it. */}
							<div className="min-h-0 flex-1">
								<ResultPreview image={preview} zoom={zoom} />
							</div>
							<div className="flex shrink-0 items-center justify-center gap-2">
								<div className="flex rounded-full border border-[#dcdcd8] bg-white p-0.5 text-[11.5px] font-semibold">
									{(["after", "before"] as const).map((value) => (
										<button
											key={value}
											type="button"
											aria-pressed={compare === value}
											className={
												compare === value
													? "rounded-full bg-[#1c1c1e] px-3 py-1 text-white"
													: "rounded-full px-3 py-1 text-[#6f6f6a]"
											}
											onClick={() => setCompare(value)}
										>
											{value === "after" ? "After" : "Before"}
										</button>
									))}
								</div>
								<ZoomRow zoom={zoom} onChange={setZoom} />
							</div>
						</div>

						{isDesktop && (
							<aside className="flex min-h-0 flex-col gap-2 overflow-y-auto pb-1 lg:w-[360px] lg:shrink-0 lg:pb-0">
								{adjustCards.map((entry) => (
									<div key={entry.id}>{entry.content}</div>
								))}
							</aside>
						)}

						{!isDesktop && (
							<nav className="flex shrink-0 items-stretch gap-1 rounded-xl bg-white p-1 shadow-[0_1px_3px_rgba(0,0,0,0.07)]">
								{adjustCards.map((entry) => (
									<button
										key={entry.id}
										type="button"
										aria-pressed={sheet === entry.id}
										onClick={() => setSheet(entry.id)}
										className={`flex-1 rounded-lg px-1 py-2 text-[10.5px] font-semibold ${
											sheet === entry.id
												? "bg-[#1c1c1e] text-white"
												: "text-[#6f6f6a]"
										}`}
									>
										{entry.label}
									</button>
								))}
							</nav>
						)}

						{!isDesktop && sheet && (
							<div className="fixed inset-0 z-40 flex items-end">
								<button
									type="button"
									aria-label="Close panel"
									onClick={() => setSheet(null)}
									className="absolute inset-0 bg-black/30"
								/>
								{/* The sheet is the card: no wrapper, no second title, no
								    shadow inside a shadow. The backdrop is the only way out. */}
								<div className="relative max-h-[72dvh] w-full overflow-y-auto rounded-t-2xl bg-white pt-2 pb-[calc(12px+env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(0,0,0,0.18)] [&>section]:rounded-none [&>section]:shadow-none">
									<div className="mx-auto mb-1 h-1 w-9 rounded-full bg-[#dcdcd8]" />
									{adjustCards.find((entry) => entry.id === sheet)?.content}
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ pieces */

const card =
	"rounded-xl bg-white px-3 pt-2.5 pb-3 shadow-[0_1px_3px_rgba(0,0,0,0.07)]";
const tool =
	"rounded-full border border-[#dcdcd8] bg-white px-3 py-1.5 text-xs font-medium text-[#1c1c1e]";
/** A square tool button: grid centring keeps the icon on the button's middle. */
const iconTool =
	"grid h-8 w-8 place-items-center rounded-full border border-[#dcdcd8] bg-white text-[#1c1c1e]";

/** The crop's own width and height, in the photo's pixels. */
function cropSize(quad: Quad): { width: number; height: number } {
	const [topLeft, topRight, bottomRight, bottomLeft] = quadPoints(quad);
	const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
		Math.hypot(b.x - a.x, b.y - a.y);
	const width =
		(distance(topLeft, topRight) + distance(bottomLeft, bottomRight)) / 2;
	const height =
		(distance(topLeft, bottomLeft) + distance(topRight, bottomRight)) / 2;
	return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Follow a value only after it stops changing for `delay` milliseconds.
 *
 * A range input fires on every pixel of travel, and each render warps and
 * encodes the page, so the preview follows the settled value instead of every
 * event. Nothing else reads the settled copy.
 */
function useDebounced<T>(value: T, delay: number): T {
	const [settled, setSettled] = useState(value);

	useEffect(() => {
		const timer = window.setTimeout(() => setSettled(value), delay);
		return () => window.clearTimeout(timer);
	}, [value, delay]);

	return settled;
}

/** Follow a media query, so a layout can be picked rather than hidden. */
function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(
		() => typeof window !== "undefined" && window.matchMedia(query).matches,
	);

	useEffect(() => {
		const list = window.matchMedia(query);
		const update = () => setMatches(list.matches);
		update();
		list.addEventListener("change", update);
		return () => list.removeEventListener("change", update);
	}, [query]);

	return matches;
}

/** A card's title row, with the reset that belongs to that card alone. */
function CardHead({
	title,
	onReset,
	disabled,
}: {
	title: string;
	onReset: () => void;
	disabled: boolean;
}) {
	return (
		<div className="mb-2 flex items-center justify-between gap-2">
			<h2 className="text-[11.5px] font-semibold text-[#6f6f6a]">{title}</h2>
			<button
				type="button"
				onClick={onReset}
				disabled={disabled}
				className="text-[10.5px] font-medium text-[#8e8e93] disabled:opacity-35"
			>
				Reset
			</button>
		</div>
	);
}

/** Turn and mirror controls, used by the crop tools and the edit panel. */
function OrientationButtons({
	orientation,
	onChange,
}: {
	orientation: Orientation;
	onChange: (next: Orientation) => void;
}) {
	const toggle = (change: (current: Orientation) => Orientation) =>
		onChange(change(orientation));

	return (
		<div className="flex flex-wrap gap-1.5">
			<button
				type="button"
				aria-label="Rotate anticlockwise"
				className={iconTool}
				onClick={() =>
					toggle((current) => ({
						...current,
						turns: normalizeTurns(current.turns - 1),
					}))
				}
			>
				<RotateCcw className="h-4 w-4" aria-hidden="true" />
			</button>
			<button
				type="button"
				aria-label="Rotate clockwise"
				className={iconTool}
				onClick={() =>
					toggle((current) => ({
						...current,
						turns: normalizeTurns(current.turns + 1),
					}))
				}
			>
				<RotateCw className="h-4 w-4" aria-hidden="true" />
			</button>
			<button
				type="button"
				aria-label="Flip horizontally"
				aria-pressed={orientation.flipHorizontal}
				className={`${iconTool} aria-pressed:border-[#1c1c1e] aria-pressed:bg-[#1c1c1e] aria-pressed:text-white`}
				onClick={() =>
					toggle((current) => ({
						...current,
						flipHorizontal: !current.flipHorizontal,
					}))
				}
			>
				<FlipHorizontal2 className="h-4 w-4" aria-hidden="true" />
			</button>
			<button
				type="button"
				aria-label="Flip vertically"
				aria-pressed={orientation.flipVertical}
				className={`${iconTool} aria-pressed:border-[#1c1c1e] aria-pressed:bg-[#1c1c1e] aria-pressed:text-white`}
				onClick={() =>
					toggle((current) => ({
						...current,
						flipVertical: !current.flipVertical,
					}))
				}
			>
				<FlipVertical2 className="h-4 w-4" aria-hidden="true" />
			</button>
		</div>
	);
}

function AdjustmentSliders({
	adjustments,
	ids,
	onChange,
}: {
	adjustments: Adjustments;
	ids: (keyof Adjustments)[];
	onChange: (next: Adjustments) => void;
}) {
	return (
		<>
			{ADJUSTMENT_SLIDERS.filter(({ id }) => ids.includes(id)).map(
				({ id, label }) => (
					<label
						key={id}
						className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 py-1"
					>
						<span className="text-[11.5px] text-[#3a3a3c]">{label}</span>
						<output className="text-[11px] text-[#8e8e93] tabular-nums">
							{adjustments[id] > 0 ? `+${adjustments[id]}` : adjustments[id]}
						</output>
						<input
							type="range"
							min={-100}
							max={100}
							step={1}
							value={adjustments[id]}
							onChange={(event) => {
								// Read the value before the update: React clears
								// `currentTarget` once the handler returns.
								const value = Number(event.currentTarget.value);
								onChange({ ...adjustments, [id]: value });
							}}
							className="range col-span-2"
						/>
					</label>
				),
			)}
		</>
	);
}

function ZoomRow({
	zoom,
	onChange,
}: {
	zoom: number;
	onChange: (next: number) => void;
}) {
	return (
		<div className="inline-flex items-center gap-0.5 self-center rounded-full border border-[#dcdcd8] bg-white p-0.5">
			<button
				type="button"
				aria-label="Zoom out"
				className="h-6 w-6 rounded-full text-sm"
				onClick={() => onChange(Math.max(0.5, zoom - 0.25))}
			>
				−
			</button>
			<span className="min-w-[34px] text-center text-[11px] text-[#6f6f6a] tabular-nums">
				{Math.round(zoom * 100)}%
			</span>
			<button
				type="button"
				aria-label="Zoom in"
				className="h-6 w-6 rounded-full text-sm"
				onClick={() => onChange(Math.min(3, zoom + 0.25))}
			>
				+
			</button>
		</div>
	);
}

interface UploadScreenProps {
	busy: boolean;
	dragActive: boolean;
	onDragActiveChange: (active: boolean) => void;
	onDrop: (event: ReactDragEvent<HTMLLabelElement>) => void;
	onInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

function UploadScreen({
	busy,
	dragActive,
	onDragActiveChange,
	onDrop,
	onInputChange,
}: UploadScreenProps) {
	return (
		<label
			htmlFor="scanner-file"
			onDragOver={(event) => {
				event.preventDefault();
				onDragActiveChange(true);
			}}
			onDragLeave={() => onDragActiveChange(false)}
			onDrop={onDrop}
			className={`flex aspect-[3/2] w-[260px] max-w-[80vw] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed text-center transition ${
				dragActive
					? "border-[#1c1c1e] bg-white"
					: "border-[#c1c1bb] bg-white/70 hover:border-[#1c1c1e] hover:bg-white"
			}`}
		>
			<ImagePlus className="h-5 w-5 text-[#1c1c1e]" aria-hidden="true" />
			<span className="text-sm font-medium text-[#1c1c1e]">
				{busy ? "Reading the image…" : "Choose a photo"}
			</span>
			<span className="text-[11px] text-[#8e8e93]">or drop it here</span>
			<input
				id="scanner-file"
				type="file"
				accept={IMAGE_ACCEPT}
				className="sr-only"
				disabled={busy}
				onChange={onInputChange}
			/>
		</label>
	);
}

/**
 * What the photo input asks the platform for.
 *
 * `image/*` alone is not enough on Android. From Android 13 the system photo
 * picker took over this input, and that picker has no camera tile, so a phone
 * that is not an iPhone can only reach the gallery. Chrome falls back to its
 * older chooser, camera included, as soon as the filter names a type that is not
 * an image; the entry here exists for that reason and matches no real file.
 * `capture` is deliberately absent: it would send the input straight to the
 * camera and take the gallery away.
 */
const IMAGE_ACCEPT = "image/*,application/x-rescanned-camera";
