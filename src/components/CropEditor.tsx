import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import {
	clampPointToBounds,
	isConvex,
	type Point,
	type Quad,
	quadArea,
	quadPoints,
	withQuadCorner,
} from "#/lib/geometry";
import {
	normalizeTurns,
	type Orientation,
	orientedSize,
	toDisplayPoint,
	toPhotoPoint,
} from "#/lib/orientation";

/** Touch-friendly grab radius, in CSS pixels. */
const HANDLE_HIT_RADIUS = 26;
/** Side of the drawn handle, in CSS pixels. */
const HANDLE_SIZE = 14;
/** A quad smaller than this share of the image is rejected while dragging. */
const MIN_AREA_FRACTION = 0.015;
const ACCENT = "#1c1c1e";
const HANDLE_FILL = "#ffffff";
/** Side of the corner magnifier, in CSS pixels. */
const LOUPE_SIZE = 148;
/** How much the magnifier enlarges the photo, on top of the display scale. */
const LOUPE_ZOOM = 3;
/** Clearance between the node and the magnifier, in CSS pixels. */
const LOUPE_GAP = 16;
/** Inset of the magnifier from the edges of the photo, in CSS pixels. */
const LOUPE_MARGIN = 6;
/** How far inside its square the crosshair is kept, in CSS pixels. */
const LOUPE_CROSS_INSET = 12;

export interface CropEditorProps {
	image: HTMLCanvasElement;
	/** Corners in the photo's own coordinates, whatever the turn. */
	quad: Quad;
	/** The turn and mirror the photo is shown with. */
	orientation: Orientation;
	/** Magnification applied by the zoom row. */
	zoom: number;
	onChange: (quad: Quad) => void;
	/** Called when a corner drag starts and when it ends. */
	onDragChange?: (dragging: boolean) => void;
}

/** Compose two 2D matrices: the result applies `b`, then `a`. */
function multiply(
	a: [number, number, number, number, number, number],
	b: [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
	return [
		a[0] * b[0] + a[2] * b[1],
		a[1] * b[0] + a[3] * b[1],
		a[0] * b[2] + a[2] * b[3],
		a[1] * b[2] + a[3] * b[3],
		a[0] * b[4] + a[2] * b[5] + a[4],
		a[1] * b[4] + a[3] * b[5] + a[5],
	];
}

/** Photo coordinates to displayed coordinates, as a canvas matrix. */
function displayMatrix(
	image: { width: number; height: number },
	orientation: Orientation,
): {
	matrix: [number, number, number, number, number, number];
	size: { width: number; height: number };
} {
	const size = orientedSize(image, orientation);
	const turns = normalizeTurns(orientation.turns);

	let matrix: [number, number, number, number, number, number] = [
		1, 0, 0, 1, 0, 0,
	];
	if (turns === 1) matrix = [0, 1, -1, 0, image.height, 0];
	if (turns === 2) matrix = [-1, 0, 0, -1, image.width, image.height];
	if (turns === 3) matrix = [0, -1, 1, 0, 0, image.width];
	if (orientation.flipHorizontal) {
		matrix = multiply([-1, 0, 0, 1, size.width, 0], matrix);
	}
	if (orientation.flipVertical) {
		matrix = multiply([1, 0, 0, -1, 0, size.height], matrix);
	}
	return { matrix, size };
}

/**
 * Draw the magnifier that follows a dragged corner.
 *
 * The square is centred on the node but offset clear of it, so a finger does not
 * cover what it is placing. It is cut from the photo layer, which already has
 * the turn and the zoom applied, so it shows what the screen shows.
 *
 * Everything here is in device pixels of the loupe canvas.
 */
function drawLoupe(
	context: CanvasRenderingContext2D,
	photo: HTMLCanvasElement,
	displayPoint: Point,
	displayWidth: number,
	displayHeight: number,
	displayScale: number,
) {
	// Place the square beside the node, clear of the finger, inside the photo.
	const left = Math.min(
		displayWidth - LOUPE_SIZE - LOUPE_MARGIN,
		Math.max(
			LOUPE_MARGIN,
			displayPoint.x > displayWidth / 2
				? displayPoint.x - LOUPE_SIZE - LOUPE_GAP
				: displayPoint.x + LOUPE_GAP,
		),
	);
	const top = Math.min(
		displayHeight - LOUPE_SIZE - LOUPE_MARGIN,
		Math.max(
			LOUPE_MARGIN,
			displayPoint.y > displayHeight / 2
				? displayPoint.y - LOUPE_SIZE - LOUPE_GAP
				: displayPoint.y + LOUPE_GAP,
		),
	);

	const size = LOUPE_SIZE * displayScale;
	const x = left * displayScale;
	const y = top * displayScale;
	const span = (LOUPE_SIZE / LOUPE_ZOOM) * displayScale;

	// The node in the photo layer's pixels.
	const nodeX = displayPoint.x * displayScale;
	const nodeY = displayPoint.y * displayScale;

	// Near an edge the square that would be centred on the node reaches past
	// the photo, and drawing past it stretches the border pixels into a smear.
	// The window slides inward instead, which keeps the square full of real
	// pixels, and the crosshair moves to wherever the node now sits.
	const half = span / 2;
	const windowX =
		photo.width <= span
			? (photo.width - span) / 2
			: clamp(nodeX - half, 0, photo.width - span);
	const windowY =
		photo.height <= span
			? (photo.height - span) / 2
			: clamp(nodeY - half, 0, photo.height - span);

	context.setTransform(1, 0, 0, 1, 0, 0);
	context.save();
	// One clip for the picture and the crosshair: the square is the frame, so
	// neither can spill outside it.
	context.beginPath();
	context.roundRect(x, y, size, size, 8 * displayScale);
	context.clip();
	context.imageSmoothingEnabled = true;
	context.drawImage(photo, windowX, windowY, span, span, x, y, size, size);

	// Arms run the full width and height of the square, so they read as a
	// crosshair rather than as marks that stop short of the edge.
	// The node's place inside the square, held a little way in from the border.
	// A crosshair drawn exactly on the frame would be swallowed by it, so the
	// last few pixels of travel are given up to keep it visible.
	const scale = size / span;
	const inset = LOUPE_CROSS_INSET * displayScale;
	const centreX = clamp(
		x + (nodeX - windowX) * scale,
		x + inset,
		x + size - inset,
	);
	const centreY = clamp(
		y + (nodeY - windowY) * scale,
		y + inset,
		y + size - inset,
	);
	const lineWidth = Math.max(1, displayScale);

	for (const [colour, width] of [
		["rgba(2, 6, 23, 0.75)", lineWidth * 3],
		["rgba(255, 255, 255, 0.98)", lineWidth],
	] as const) {
		context.strokeStyle = colour;
		context.lineWidth = width;
		context.beginPath();
		context.moveTo(x, centreY);
		context.lineTo(x + size, centreY);
		context.moveTo(centreX, y);
		context.lineTo(centreX, y + size);
		context.stroke();
	}
	context.restore();

	context.beginPath();
	context.roundRect(x, y, size, size, 8 * displayScale);
	context.lineWidth = 2 * displayScale;
	context.strokeStyle = "rgba(255,255,255,0.95)";
	context.stroke();
}

/**
 * Shows the photo with the crop quad on top and lets the user drag the four
 * corners.
 *
 * Two stacked canvases keep a drag cheap. The photo is scaled, turned and
 * mirrored into its own canvas once per size, so a pointer move repaints only
 * the overlay: the dim mask, the outline and the handles. Redrawing the photo
 * every frame means resampling a multi-megapixel image sixty times a second,
 * which a phone cannot keep up with.
 *
 * The corners are stored in the photo's coordinates and converted for display,
 * so a turn never rewrites the crop, only the way it is drawn.
 */
export function CropEditor({
	image,
	quad,
	orientation,
	zoom,
	onChange,
	onDragChange,
}: CropEditorProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const photoRef = useRef<HTMLCanvasElement>(null);
	const overlayRef = useRef<HTMLCanvasElement>(null);
	/** A corner being dragged, or the zoomed photo being panned. */
	const dragRef = useRef<
		| { kind: "corner"; index: number }
		| { kind: "pan"; pointer: Point; pan: Point }
		| null
	>(null);
	const [display, setDisplay] = useState({ width: 0, height: 0 });
	/** Offset of the zoomed photo inside its box, in CSS pixels. */
	const [pan, setPan] = useState({ x: 0, y: 0 });
	/** Corner under the finger, which the magnifier follows. */
	const [activeCorner, setActiveCorner] = useState<number | null>(null);

	const displaySize = orientedSize(
		{ width: image.width, height: image.height },
		orientation,
	);

	// The photo fills whatever the layout gives it: both sides are measured, so
	// a tall photo is limited by height instead of stretching to the full width.
	useLayoutEffect(() => {
		const node = containerRef.current;
		if (!node) return;

		const update = () => {
			const availableWidth = node.clientWidth;
			const availableHeight = node.clientHeight;
			if (availableWidth === 0 || availableHeight === 0) return;
			const scale = Math.min(
				availableWidth / displaySize.width,
				availableHeight / displaySize.height,
			);
			const width = Math.round(displaySize.width * scale);
			const height = Math.round(displaySize.height * scale);
			setDisplay((previous) =>
				previous.width === width && previous.height === height
					? previous
					: { width, height },
			);
		};

		update();
		const observer = new ResizeObserver(update);
		observer.observe(node);
		window.addEventListener("resize", update);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [displaySize.width, displaySize.height]);

	// Photo layer: sized and drawn once per display size. This is the only place
	// the full-resolution photo is resampled.
	useLayoutEffect(() => {
		const photo = photoRef.current;
		const overlay = overlayRef.current;
		if (!photo || !overlay || display.width === 0) return;

		const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
		const pixelWidth = Math.round(display.width * ratio);
		const pixelHeight = Math.round(display.height * ratio);
		for (const canvas of [photo, overlay]) {
			if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
			if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
		}

		const context = photo.getContext("2d");
		if (!context) return;
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, pixelWidth, pixelHeight);

		const scale = display.width / displaySize.width;
		const { matrix } = displayMatrix(image, orientation);
		const k = ratio * scale;
		context.setTransform(
			matrix[0] * k,
			matrix[1] * k,
			matrix[2] * k,
			matrix[3] * k,
			matrix[4] * k,
			matrix[5] * k,
		);
		context.imageSmoothingQuality = "high";
		context.drawImage(image, 0, 0);
	}, [image, orientation, display.width, display.height, displaySize.width]);

	// Overlay layer: the only thing a pointer move repaints.
	useLayoutEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay || display.width === 0) return;

		const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
		const scale = display.width / displaySize.width;
		const context = overlay.getContext("2d");
		if (!context) return;

		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, overlay.width, overlay.height);
		context.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);

		const points = quadPoints(quad).map((point) =>
			toDisplayPoint(point, image, orientation),
		);

		// Lift the photo around the crop so the page reads as the subject.
		context.beginPath();
		context.rect(0, 0, displaySize.width, displaySize.height);
		context.moveTo(points[0].x, points[0].y);
		for (let i = 1; i < points.length; i += 1) {
			context.lineTo(points[i].x, points[i].y);
		}
		context.closePath();
		context.fillStyle = "rgba(255, 255, 255, 0.32)";
		context.fill("evenodd");

		context.beginPath();
		context.moveTo(points[0].x, points[0].y);
		for (let i = 1; i < points.length; i += 1) {
			context.lineTo(points[i].x, points[i].y);
		}
		context.closePath();
		context.lineJoin = "round";
		context.lineWidth = 1.5 / scale;
		context.strokeStyle = ACCENT;
		context.stroke();

		const half = HANDLE_SIZE / 2 / scale;
		for (const point of points) {
			context.beginPath();
			context.roundRect(
				point.x - half,
				point.y - half,
				half * 2,
				half * 2,
				2 / scale,
			);
			context.fillStyle = HANDLE_FILL;
			context.fill();
			context.lineWidth = 1.5 / scale;
			context.strokeStyle = ACCENT;
			context.stroke();
		}

		if (activeCorner !== null) {
			const photo = photoRef.current;
			if (photo) {
				// The corner is in photo pixels; the magnifier works in the CSS
				// box and cuts from the photo layer in device pixels.
				const scaleX = display.width / displaySize.width;
				const scaleY = display.height / displaySize.height;
				drawLoupe(
					context,
					photo,
					{
						x: points[activeCorner].x * scaleX,
						y: points[activeCorner].y * scaleY,
					},
					display.width,
					display.height,
					Math.min(window.devicePixelRatio || 1, 2.5),
				);
			}
		}
	}, [
		display.width,
		display.height,
		displaySize.width,
		displaySize.height,
		image,
		orientation,
		quad,
		activeCorner,
	]);

	/** Half of the overflow at this zoom: the furthest the photo may travel. */
	const panLimit = {
		x: Math.max(0, (display.width * (zoom - 1)) / 2),
		y: Math.max(0, (display.height * (zoom - 1)) / 2),
	};

	// Zooming out must not leave the photo parked outside its box.
	useEffect(() => {
		setPan((current) => ({
			x: clamp(current.x, -panLimit.x, panLimit.x),
			y: clamp(current.y, -panLimit.y, panLimit.y),
		}));
	}, [panLimit.x, panLimit.y]);

	/** The finger's position, in displayed coordinates. */
	const toDisplaySpace = useCallback(
		(clientX: number, clientY: number): Point => {
			const canvas = overlayRef.current;
			if (!canvas) return { x: 0, y: 0 };
			const rect = canvas.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
			return {
				x: ((clientX - rect.left) / rect.width) * displaySize.width,
				y: ((clientY - rect.top) / rect.height) * displaySize.height,
			};
		},
		[displaySize.width, displaySize.height],
	);

	const findHandle = useCallback(
		(point: Point): number | null => {
			const scale = display.width === 0 ? 1 : displaySize.width / display.width;
			const grabRadius = HANDLE_HIT_RADIUS * scale;
			const points = quadPoints(quad).map((corner) =>
				toDisplayPoint(corner, image, orientation),
			);

			let nearest: number | null = null;
			let nearestDistance = Number.POSITIVE_INFINITY;
			for (let i = 0; i < points.length; i += 1) {
				const distance = Math.hypot(
					points[i].x - point.x,
					points[i].y - point.y,
				);
				if (distance <= grabRadius && distance < nearestDistance) {
					nearest = i;
					nearestDistance = distance;
				}
			}
			return nearest;
		},
		[display.width, displaySize.width, image, orientation, quad],
	);

	const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		const point = toDisplaySpace(event.clientX, event.clientY);
		const index = findHandle(point);

		if (index !== null) {
			dragRef.current = { kind: "corner", index };
			setActiveCorner(index);
			onDragChange?.(true);
		} else if (panLimit.x > 0 || panLimit.y > 0) {
			// A drag on the photo moves the view, not the crop: at a zoom above
			// 100% the page is larger than the box, and looking around is what a
			// finger on the picture is expected to do.
			dragRef.current = {
				kind: "pan",
				pointer: { x: event.clientX, y: event.clientY },
				pan,
			};
		} else {
			return;
		}

		event.preventDefault();

		// Capture keeps the drag alive when the pointer leaves the canvas, but
		// the browser throws if it no longer tracks this pointer. The drag works
		// without capture, so that is not worth failing the gesture over.
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// Ignore: the drag continues without capture.
		}
	};

	const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		const drag = dragRef.current;
		if (!drag) return;

		const point = toDisplaySpace(event.clientX, event.clientY);

		if (drag.kind === "pan") {
			setPan({
				x: clamp(
					drag.pan.x + (event.clientX - drag.pointer.x),
					-panLimit.x,
					panLimit.x,
				),
				y: clamp(
					drag.pan.y + (event.clientY - drag.pointer.y),
					-panLimit.y,
					panLimit.y,
				),
			});
			return;
		}

		const photoPoint = toPhotoPoint(point, image, orientation);
		const clamped = clampPointToBounds(photoPoint, image.width, image.height);
		const candidate = withQuadCorner(quad, drag.index, clamped);
		const points = quadPoints(candidate);

		if (!isConvex(points)) return;
		if (quadArea(candidate) < image.width * image.height * MIN_AREA_FRACTION) {
			return;
		}

		onChange(candidate);
	};

	const endDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		if (dragRef.current === null) return;
		dragRef.current = null;
		setActiveCorner(null);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		onDragChange?.(false);
	};

	// A pointer that lifts outside the canvas, or a gesture the browser takes
	// over, would otherwise leave the drag open and freeze the result.
	useEffect(() => {
		const stop = () => {
			if (dragRef.current === null) return;
			dragRef.current = null;
			setActiveCorner(null);
			onDragChange?.(false);
		};
		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
		return () => {
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
		};
	}, [onDragChange]);

	const card = {
		width: display.width || undefined,
		height: display.height || undefined,
		transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
	};

	return (
		<div
			ref={containerRef}
			className="flex h-full w-full items-center justify-center overflow-hidden"
		>
			<div
				className="relative overflow-hidden rounded-[10px] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.12)]"
				style={card}
			>
				<canvas
					ref={photoRef}
					className="absolute inset-0 h-full w-full"
					style={{ width: display.width, height: display.height }}
				/>
				<canvas
					ref={overlayRef}
					aria-label="Photo with the crop corners"
					className="absolute inset-0 block h-full w-full"
					style={{
						width: display.width,
						height: display.height,
						touchAction: "none",
						cursor: "grab",
					}}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
				/>
			</div>
		</div>
	);
}

function clamp(value: number, low: number, high: number): number {
	return value < low ? low : value > high ? high : value;
}
