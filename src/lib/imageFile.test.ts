import { describe, expect, it } from "vitest";

import { isSupportedImageFile } from "./imageFile";

/** A file as a browser would describe it, without reading its bytes. */
function file(name: string, type: string): File {
	return new File([new Uint8Array(1)], name, { type });
}

describe("isSupportedImageFile", () => {
	it("accepts what a browser labels as an image", () => {
		expect(isSupportedImageFile(file("photo.jpg", "image/jpeg"))).toBe(true);
		expect(isSupportedImageFile(file("scan.heic", "image/heic"))).toBe(true);
		expect(isSupportedImageFile(file("page.png", "image/png"))).toBe(true);
	});

	it("accepts an image that arrives without a usable type", () => {
		// Android camera captures do this: no MIME type, or a generic one.
		expect(isSupportedImageFile(file("IMG_2043.jpg", ""))).toBe(true);
		expect(
			isSupportedImageFile(file("capture.jpeg", "application/octet-stream")),
		).toBe(true);
		expect(isSupportedImageFile(file("shot.HEIC", ""))).toBe(true);
	});

	it("rejects anything that is not an image", () => {
		expect(isSupportedImageFile(file("notes.txt", ""))).toBe(false);
		expect(isSupportedImageFile(file("report.pdf", "application/pdf"))).toBe(
			false,
		);
		expect(
			isSupportedImageFile(file("archive.zip", "application/octet-stream")),
		).toBe(false);
	});
});
