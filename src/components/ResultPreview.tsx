import { useEffect, useState } from "react";

export interface ResultPreviewProps {
	image: Blob | null;
}

/**
 * Draws the corrected page as a real image, so a hold on it opens the device's
 * own menu: copy or save on a phone, Copy image on a right-click. A canvas shows
 * the same pixels but offers no such menu, which is why this is an `img`.
 *
 * The image keeps the pixel dimensions of the warp and is scaled down by CSS, so
 * the browser's own filtering does the resampling on screen.
 */
export function ResultPreview({ image }: ResultPreviewProps) {
	const [url, setUrl] = useState<string | null>(null);

	useEffect(() => {
		if (!image) {
			setUrl(null);
			return;
		}

		const next = URL.createObjectURL(image);
		setUrl(next);
		return () => URL.revokeObjectURL(next);
	}, [image]);

	if (!image) {
		return (
			<div className="flex min-h-48 items-center justify-center rounded-lg border border-slate-800 bg-slate-900/60 text-sm text-slate-500">
				The corrected page appears here.
			</div>
		);
	}

	// Full width rather than max-width: the two preview passes differ in
	// resolution but share an aspect ratio, so the box stays put and only the
	// sharpness changes. A max-width box would snap to the small pass's own size
	// and jump back up when the sharp pass arrives.
	return (
		<img
			src={url ?? undefined}
			alt="Corrected page"
			className="mx-auto block h-auto w-full rounded-lg border border-slate-800 bg-white shadow-lg shadow-slate-950/40"
		/>
	);
}
