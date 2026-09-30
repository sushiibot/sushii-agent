import { fileUrl, UPLOAD_ID_RE, type UploadRef } from '$lib/chat/events';
import type { FileRef } from '../types';

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A tile for a bot-stored file. Only a bot-sniffed raster (`inline`) gets an image `src`. */
export function fileRefFromUpload(ref: UploadRef): FileRef {
	const valid = UPLOAD_ID_RE.test(ref.id);
	return {
		id: ref.id,
		name: ref.name,
		size: formatBytes(ref.bytes),
		image: ref.inline,
		src: valid && ref.inline ? fileUrl(ref.id) : undefined,
		removed: !valid
	};
}

// Looser than UPLOAD_ID_RE so fixture ids work, but still no dot or slash to climb out of /f/.
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The `/f/<id>` URL for a path-safe id; null for anything else, so no tile links elsewhere. */
export function fileHref(id: string): string | null {
	return FILE_ID_RE.test(id) ? fileUrl(id) : null;
}

// Script never runs in an <img>, whatever the image type; what matters is not fetching off-site.
const LOCAL_IMAGE_RE = /^(blob:|data:image\/)/;

/** An image tile's `src` when it is the file's own `/f/<id>`, or a local blob or data URL (an
 *  unsent photo's preview). Never a remote URL, so a tile cannot beacon off-site. */
export function imageSrc(file: FileRef): string | null {
	if (!file.src) return null;
	const href = fileHref(file.id);
	if (href && file.src === href) return href;
	return LOCAL_IMAGE_RE.test(file.src) ? file.src : null;
}
