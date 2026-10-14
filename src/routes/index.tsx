import { ClientOnly, createFileRoute } from "@tanstack/react-router";

import { DocumentScanner } from "#/components/DocumentScanner";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	return (
		<main className="min-h-dvh bg-slate-950 text-slate-100">
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
		<div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
			<div className="h-8 w-64 rounded bg-slate-800/70" />
			<div className="mt-8 h-56 rounded-xl border-2 border-dashed border-slate-800 bg-slate-900/40" />
		</div>
	);
}
