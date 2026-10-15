import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command, isPreview }) => {
	// The plugin produces the deployable Worker bundle and serves that bundle
	// inside workerd for `vite preview`. Its dev integration cannot reach its own
	// internal Vite route in this environment (it fetches
	// `http://localhost/__vite_plugin_cloudflare_get_export_types__` and gets
	// ECONNREFUSED), so `vite dev` keeps the plain Vite server. Use
	// `wrangler dev` against the built output to run the real Worker locally.
	const runsInWorker = command === "build" || isPreview;

	return {
		resolve: { tsconfigPaths: true },
		plugins: [
			devtools({
				// Console piping echoes client logs into the terminal and server logs
				// back into the browser console. The two directions amplify each
				// other: a piped log arrives as a new client log, and each round trip
				// nests the previous payload. On a long-lived page that grows into
				// hundreds of kilobytes per message and saturates the main thread, so
				// every interaction stutters. The app needs neither direction.
				consolePiping: { enabled: false },
			}),
			tailwindcss(),
			...(runsInWorker
				? [
						// Has to see the SSR environment that TanStack Start builds into.
						cloudflare({ viteEnvironment: { name: "ssr" } }),
					]
				: []),
			tanstackStart(),
			viteReact(),
		],
	};
});
