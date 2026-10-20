import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				name: "description",
				content:
					"Turn a photo of a document into a straight, cropped scan in the browser.",
			},
			{
				name: "theme-color",
				content: "#dcdcda",
			},
			{
				title: "Rescanned",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
			// Scalable first, with a bitmap for browsers that ignore SVG icons.
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/rescanned.svg",
			},
			{
				rel: "icon",
				type: "image/png",
				sizes: "32x32",
				href: "/favicon-32.png",
			},
			{
				rel: "apple-touch-icon",
				href: "/apple-touch-icon.png",
			},
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}
