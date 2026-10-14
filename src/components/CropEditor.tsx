import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
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
	quadContainsPoint,
	quadPoints,
	translateQuad,
	withQuadCorner,
} from "#/lib/geometry";

/** Touch-friendly grab radius, in CSS pixels. */
const HANDLE_HIT_RADIUS = 26;
const HANDLE_RADIUS = 9;
/** A quad smaller than this share of the image is rejected while dragging. */
const MIN_AREA_FRACTION = 0.015;
const MAX_HEIGHT_RATIO = 0.7;
const ACCENT = "#38bdf8";

export interface CropEditorProps {
	image: HTMLCanvasElement;
	quad: Quad;
	editable: boolean;
	onChange: (quad: Quad) => void;
	/** Called when a corner drag starts and when it ends. */
	onDragChange?: (dragging: boolean) => void;
}

/**
 * Shows the photo with the crop quad on top and lets the user drag the four
 * corners.
 *
 * Two stacked canvases keep a drag cheap. The photo is scaled into its own
 * canvas once per size, so a pointer move repaints only the overlay: the dim
 * mask, the outline and the handles. Redrawing the photo every frame means
 * resampling a multi-megapixel image sixty times a second, which a phone
 * cannot keep up with.
 *
 * Both canvases are drawn in image pixel coordinates, so the geometry matches
 * the values that feed the perspective transform and the handle size only has
 * to be divided by the display scale.
 */
export function CropEditor({
	image,
	quad,
	editable,
	onChange,
	onDragChange,
}: CropEditorProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const photoRef = useRef<HTMLCanvasElement>(null);
	const overlayRef = useRef<HTMLCanvasElement>(null);
	/** Either a single corner being dragged, or the whole quad moving. */
	const dragRef = useRef<
		{ kind: "corner"; index: number } | { kind: "move"; from: Point } | null
	>(null);
	const [display, setDisplay] = useState({ width: 0, height: 0 });

	useLayoutEffect(() => {
		const node = containerRef.current;
		if (!node) return;

		const update = () => {
			const availableWidth = node.clientWidth;
			if (availableWidth === 0) return;
			const maxHeight = Math.max(240, window.innerHeight * MAX_HEIGHT_RATIO);
			const scale = Math.min(
				availableWidth / image.width,
				maxHeight / image.height,
			);
			const width = Math.round(image.width * scale);
			const height = Math.round(image.height * scale);
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
	}, [image]);

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
		const scale = display.width / image.width;
		context.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);
		context.imageSmoothingQuality = "high";
		context.clearRect(0, 0, image.width, image.height);
		context.drawImage(image, 0, 0, image.width, image.height);
	}, [image, display.width, display.height]);

	// Overlay layer: the only thing a pointer move repaints.
	useLayoutEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay || display.width === 0) return;

		const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
		const scale = display.width / image.width;
		const context = overlay.getContext("2d");
		if (!context) return;

		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, overlay.width, overlay.height);
		context.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);

		const points = quadPoints(quad);

		// Dim everything outside the quad. One path with two subpaths plus the
		// even-odd rule fills the frame minus the quad.
		context.beginPath();
		context.rect(0, 0, image.width, image.height);
		context.moveTo(points[0].x, points[0].y);
		for (let i = 1; i < points.length; i += 1) {
			context.lineTo(points[i].x, points[i].y);
		}
		context.closePath();
		context.fillStyle = "rgba(2, 6, 23, 0.55)";
		context.fill("evenodd");

		context.beginPath();
		context.moveTo(points[0].x, points[0].y);
		for (let i = 1; i < points.length; i += 1) {
			context.lineTo(points[i].x, points[i].y);
		}
		context.closePath();
		context.lineJoin = "round";
		context.lineWidth = 2 / scale;
		context.strokeStyle = editable ? ACCENT : "rgba(226, 232, 240, 0.95)";
		context.stroke();

		const handleRadius = HANDLE_RADIUS / scale;
		for (const point of points) {
			context.beginPath();
			context.arc(point.x, point.y, handleRadius, 0, Math.PI * 2);
			context.fillStyle = editable ? ACCENT : "rgba(226, 232, 240, 0.95)";
			context.fill();
			context.lineWidth = 2 / scale;
			context.strokeStyle = "#0f172a";
			context.stroke();
		}
	}, [display.width, image.width, image.height, quad, editable]);

	const toImagePoint = useCallback(
		(clientX: number, clientY: number): Point => {
			const canvas = overlayRef.current;
			if (!canvas) return { x: 0, y: 0 };
			const rect = canvas.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
			return {
				x: ((clientX - rect.left) / rect.width) * image.width,
				y: ((clientY - rect.top) / rect.height) * image.height,
			};
		},
		[image],
	);

	const findHandle = useCallback(
		(point: Point): number | null => {
			const scale = display.width === 0 ? 1 : image.width / display.width;
			const grabRadius = HANDLE_HIT_RADIUS * scale;
			const points = quadPoints(quad);

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
		[display.width, image.width, quad],
	);

	const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
		if (!editable) return;
		const point = toImagePoint(event.clientX, event.clientY);
		const index = findHandle(point);

		if (index !== null) {
			dragRef.current = { kind: "corner", index };
		} else if (quadContainsPoint(quad, point)) {
			// Anywhere inside moves the whole crop, which is how a wrongly
			// detected page is brought onto the page before the corners are
			// fine-tuned.
			dragRef.current = { kind: "move", from: point };
		} else {
			return;
		}

		onDragChange?.(true);
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

		const point = toImagePoint(event.clientX, event.clientY);

		if (drag.kind === "move") {
			onChange(
				translateQuad(
					quad,
					point.x - drag.from.x,
					point.y - drag.from.y,
					image.width,
					image.height,
				),
			);
			return;
		}

		const clamped = clampPointToBounds(point, image.width, image.height);
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
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		onDragChange?.(false);
	};

	const canvasStyle = {
		inset: 0,
		margin: "auto",
		width: display.width || undefined,
		height: display.height || undefined,
	};

	return (
		<div
			ref={containerRef}
			className="relative w-full overflow-hidden rounded-lg shadow-lg shadow-slate-950/40"
			style={{ height: display.height || undefined }}
		>
			<canvas ref={photoRef} className="absolute" style={canvasStyle} />
			<canvas
				ref={overlayRef}
				aria-label="Photo with the crop corners"
				className="absolute block"
				style={{
					...canvasStyle,
					touchAction: "none",
					cursor: editable ? "grab" : "default",
				}}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
			/>
		</div>
	);
}
