import { ClientOnly, createFileRoute } from "@tanstack/react-router";

import { DocumentScanner } from "#/components/DocumentScanner";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	return (
		<main className="min-h-dvh bg-[#dcdcda] text-[#1c1c1e]">
			<ClientOnly fallback={<ScannerPlaceholder />}>
				<DocumentScanner />
			</ClientOnly>
		</main>
	);
}

/**
 * The scanner needs canvas and file APIs, so it only renders on the client.
 * This keeps the first paint stable while that happens.
 */
function ScannerPlaceholder() {
	return (
		<div className="mx-auto w-full max-w-[460px] px-3 py-4">
			<div className="h-7 w-40 rounded bg-[#cfcfca]" />
			<div className="mt-6 h-56 rounded-xl border border-dashed border-[#c5c5c0] bg-white/60" />
		</div>
	);
}
