import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

export interface ResultPreviewProps {
	image: Blob | null;
	/** Magnification applied by the zoom row. */
	zoom: number;
}

/**
 * Draws the corrected page as a real image, so a hold on it opens the device's
 * own menu: copy or save on a phone, Copy image on a right-click. A canvas shows
 * the same pixels but offers no such menu, which is why this is an `img`.
 *
 * The box the page sits in is fixed by the layout, and the page is fitted inside
 * it the way the crop screen fits the photo: both sides are measured, so the
 * card never grows past the space it was given and never shrinks away from it.
 */
export function ResultPreview({ image, zoom }: ResultPreviewProps) {
	const [url, setUrl] = useState<string | null>(null);
	const [natural, setNatural] = useState<{
		width: number;
		height: number;
	} | null>(null);
	const [box, setBox] = useState({ width: 0, height: 0 });
	/** Offset of the zoomed page inside its box, in CSS pixels. */
	const [pan, setPan] = useState({ x: 0, y: 0 });
	const boxRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{
		pointer: { x: number; y: number };
		pan: { x: number; y: number };
	} | null>(null);

	useEffect(() => {
		if (!image) {
			setUrl(null);
			setNatural(null);
			return;
		}

		const next = URL.createObjectURL(image);
		setUrl(next);

		// Decode before drawing: the fit needs the page's shape, and the image
		// element that would report it is the one waiting for the fit.
		let cancelled = false;
		const decoder = new Image();
		decoder.onload = () => {
			if (cancelled) return;
			const size = {
				width: decoder.naturalWidth,
				height: decoder.naturalHeight,
			};
			setNatural(size);
		};
		decoder.src = next;

		return () => {
			cancelled = true;
			URL.revokeObjectURL(next);
		};
	}, [image]);

	// The region is fixed by the layout, so measure it rather than guess.
	useLayoutEffect(() => {
		const node = boxRef.current;
		if (!node) return;

		const update = () => {
			setBox((current) =>
				current.width === node.clientWidth &&
				current.height === node.clientHeight
					? current
					: { width: node.clientWidth, height: node.clientHeight },
			);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	const fit = useMemo(() => {
		if (!natural || box.width === 0 || box.height === 0) return null;
		const scale = Math.min(
			box.width / natural.width,
			box.height / natural.height,
		);
		return {
			width: Math.max(1, Math.round(natural.width * scale)),
			height: Math.max(1, Math.round(natural.height * scale)),
		};
	}, [natural, box]);

	/** Half of what sticks out of the box at this zoom: how far a drag may go. */
	const limit = fit
		? {
				x: Math.max(0, (fit.width * zoom - box.width) / 2),
				y: Math.max(0, (fit.height * zoom - box.height) / 2),
			}
		: { x: 0, y: 0 };

	// Zooming out must not leave the page parked outside its box.
	useEffect(() => {
		setPan((current) => ({
			x: clamp(current.x, -limit.x, limit.x),
			y: clamp(current.y, -limit.y, limit.y),
		}));
	}, [limit.x, limit.y]);

	const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (limit.x <= 0 && limit.y <= 0) return;
		dragRef.current = { pointer: { x: event.clientX, y: event.clientY }, pan };
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// The drag works without capture.
		}
	};

	const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		setPan({
			x: clamp(
				drag.pan.x + (event.clientX - drag.pointer.x),
				-limit.x,
				limit.x,
			),
			y: clamp(
				drag.pan.y + (event.clientY - drag.pointer.y),
				-limit.y,
				limit.y,
			),
		});
	};

	const endPan = () => {
		dragRef.current = null;
	};

	return (
		<div
			ref={boxRef}
			className="relative h-full min-h-0 w-full overflow-hidden"
			style={{ touchAction: limit.x > 0 || limit.y > 0 ? "none" : undefined }}
			onPointerDown={startPan}
			onPointerMove={movePan}
			onPointerUp={endPan}
			onPointerCancel={endPan}
		>
			<div className="absolute inset-0 flex items-center justify-center">
				{image && url && fit ? (
					<div
						className="overflow-hidden rounded-[10px] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.12)]"
						style={{
							width: fit.width,
							height: fit.height,
							transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
						}}
					>
						<img
							src={url}
							alt="Corrected page"
							draggable={false}
							className="h-full w-full"
						/>
					</div>
				) : (
					<div className="flex h-full w-full items-center justify-center rounded-xl border border-dashed border-[#d3d3ce] bg-white/60 text-xs text-[#8e8e93]">
						The corrected page appears here.
					</div>
				)}
			</div>
		</div>
	);
}

function clamp(value: number, low: number, high: number): number {
	return value < low ? low : value > high ? high : value;
}
