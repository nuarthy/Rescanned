import { useEffect, useRef } from "react";

export interface HistogramProps {
	/** The preview the levels are read from, so the graph matches the page. */
	image: Blob | null;
}

const WIDTH = 240;
const HEIGHT = 40;
const BINS = 64;
const CHANNELS = [
	"rgba(255, 59, 48, 0.5)",
	"rgba(52, 199, 89, 0.45)",
	"rgba(0, 122, 255, 0.4)",
];

/**
 * Red, green and blue levels of the corrected page.
 *
 * The pixels are read from a 128 pixel copy rather than the full preview: the
 * shape of the levels is all the graph shows, and sampling sixteen thousand
 * pixels costs a fraction of the full page.
 *
 * A square root keeps one large area, such as the white of the paper, from
 * flattening everything else to the floor.
 */
export function Histogram({ image }: HistogramProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		canvas.width = WIDTH;
		canvas.height = HEIGHT;
		const context = canvas.getContext("2d");
		if (!context) return;
		context.clearRect(0, 0, WIDTH, HEIGHT);
		if (!image) return;

		let cancelled = false;

		const draw = async () => {
			let bitmap: ImageBitmap;
			try {
				bitmap = await createImageBitmap(image);
			} catch {
				return;
			}
			if (cancelled) {
				bitmap.close();
				return;
			}

			const sample = document.createElement("canvas");
			sample.width = 128;
			sample.height = 128;
			const sampleContext = sample.getContext("2d", {
				willReadFrequently: true,
			});
			if (!sampleContext) return;
			sampleContext.drawImage(bitmap, 0, 0, 128, 128);
			bitmap.close();
			if (cancelled) return;

			const { data } = sampleContext.getImageData(0, 0, 128, 128);
			const bins = [
				new Array<number>(BINS).fill(0),
				new Array<number>(BINS).fill(0),
				new Array<number>(BINS).fill(0),
			];
			for (let i = 0; i < data.length; i += 4) {
				bins[0][data[i] >> 2] += 1;
				bins[1][data[i + 1] >> 2] += 1;
				bins[2][data[i + 2] >> 2] += 1;
			}

			const scaled = bins.map((bin) => bin.map((count) => Math.sqrt(count)));
			const peak = Math.max(...scaled.flat(), 1);

			scaled.forEach((bin, channel) => {
				context.beginPath();
				context.moveTo(0, HEIGHT);
				bin.forEach((count, index) => {
					const x = (index / (bin.length - 1)) * WIDTH;
					const y = HEIGHT - (count / peak) * (HEIGHT - 2);
					context.lineTo(x, y);
				});
				context.lineTo(WIDTH, HEIGHT);
				context.closePath();
				context.fillStyle = CHANNELS[channel];
				context.fill();
			});
		};

		void draw();

		return () => {
			cancelled = true;
		};
	}, [image]);

	return (
		<canvas
			ref={canvasRef}
			role="img"
			aria-label="Tone levels of the corrected page"
			className="mb-2 block h-10 w-full rounded-md border border-[#f0f0ee] bg-[#fafafa]"
		/>
	);
}
