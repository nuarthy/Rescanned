import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const config = defineConfig({
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
		tanstackStart(),
		viteReact(),
	],
});

export default config;
