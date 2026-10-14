import { useEffect, useRef } from "react";

import { toImageData } from "#/lib/imageFile";
import type { RgbaImage } from "#/lib/pixels";

export interface ResultPreviewProps {
	pixels: RgbaImage | null;
}

/**
 * Draws the corrected page.
 *
 * The canvas keeps the pixel dimensions of the warp and is scaled down by CSS,
 * so the browser's own filtering does the resampling on screen.
 */
export function ResultPreview({ pixels }: ResultPreviewProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		if (!pixels) {
			canvas.width = 0;
			canvas.height = 0;
			return;
		}

		canvas.width = pixels.width;
		canvas.height = pixels.height;
		const context = canvas.getContext("2d");
		context?.putImageData(toImageData(pixels), 0, 0);
	}, [pixels]);

	if (!pixels) {
		return (
			<div className="flex min-h-48 items-center justify-center rounded-lg border border-slate-800 bg-slate-900/60 text-sm text-slate-500">
				The corrected page appears here.
			</div>
		);
	}

	return (
		<canvas
			ref={canvasRef}
			aria-label="Corrected page"
			className="mx-auto block h-auto max-w-full rounded-lg border border-slate-800 bg-white shadow-lg shadow-slate-950/40"
		/>
	);
}
