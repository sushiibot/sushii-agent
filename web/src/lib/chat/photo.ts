import { UPLOAD_MAX_BYTES } from './events';

export const LONG_EDGE_MAX = 2560;
export const JPEG_QUALITY = 0.85;

export class PhotoError extends Error {
	constructor(readonly reason: 'type' | 'size') {
		super(reason);
	}
}

/** The size that fits the long edge into `max`, never upscaling. */
export function fitWithin(width: number, height: number, max = LONG_EDGE_MAX) {
	const scale = Math.min(1, max / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}

/**
 * Decodes, applies EXIF orientation, downsizes and re-encodes as JPEG. The canvas encoder writes
 * pixels only, so EXIF and GPS metadata from the camera never leave the phone.
 */
export async function preparePhoto(file: Blob): Promise<Blob> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	} catch {
		throw new PhotoError('type');
	}
	try {
		const { width, height } = fitWithin(bitmap.width, bitmap.height);
		let blob: Blob | null;
		if (typeof OffscreenCanvas !== 'undefined') {
			const canvas = new OffscreenCanvas(width, height);
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new PhotoError('type');
			ctx.drawImage(bitmap, 0, 0, width, height);
			blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
		} else {
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
			blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
		}
		if (!blob || blob.type !== 'image/jpeg') throw new PhotoError('type');
		if (blob.size > UPLOAD_MAX_BYTES) throw new PhotoError('size');
		return blob;
	} finally {
		bitmap.close();
	}
}

/** The upload's display name: the original base name with a .jpg extension, since it's re-encoded. */
export function jpegName(name: string): string {
	const base = name.replace(/\.[^.]*$/, '').trim() || 'photo';
	return `${base}.jpg`;
}
