import { UPLOAD_MAX_BYTES } from '$lib/core/realtime/events';

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

type Canvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function canvas(width: number, height: number): { canvas: Canvas; ctx: Ctx } {
	const c =
		typeof OffscreenCanvas !== 'undefined'
			? new OffscreenCanvas(width, height)
			: Object.assign(document.createElement('canvas'), { width, height });
	const ctx = c.getContext('2d') as Ctx | null;
	if (!ctx) throw new PhotoError('type');
	return { canvas: c, ctx };
}

/** Browsers that can't write `type` return PNG instead (HTML canvas spec), so callers check the result. */
function encode(c: Canvas, type: string, quality?: number): Promise<Blob | null> {
	if ('convertToBlob' in c) return c.convertToBlob({ type, quality }).catch(() => null);
	return new Promise((r) => c.toBlob(r, type, quality));
}

/** The oriented size without decoding pixels, where the browser allows it. */
async function naturalSize(file: Blob): Promise<{ width: number; height: number } | null> {
	if (typeof Image === 'undefined') return null;
	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.src = url;
		await new Promise((resolve, reject) => {
			img.onload = resolve;
			img.onerror = reject;
		});
		return img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null;
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Decodes straight to the target size when possible, so a 50 MP photo never sits in memory at full size. */
async function decode(file: Blob): Promise<ImageBitmap> {
	const natural = await naturalSize(file);
	if (natural) {
		const target = fitWithin(natural.width, natural.height);
		if (target.width < natural.width) {
			try {
				const small = await createImageBitmap(file, {
					imageOrientation: 'from-image',
					resizeWidth: target.width,
					resizeHeight: target.height,
					resizeQuality: 'high'
				});
				// Engines disagree on whether resize applies before orientation; a swapped result is redone.
				if (small.width === target.width && small.height === target.height) return small;
				small.close();
			} catch {
				// Resize options unsupported for this input.
			}
		}
	}
	return createImageBitmap(file, { imageOrientation: 'from-image' });
}

function hasAlpha(ctx: Ctx, width: number, height: number): boolean {
	const data = ctx.getImageData(0, 0, width, height).data;
	for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
	return false;
}

/**
 * Re-encodes through a canvas, which writes pixels only, so camera EXIF and GPS never leave the phone.
 * Transparent images become WebP or PNG so their alpha survives.
 */
export async function preparePhoto(file: Blob): Promise<Blob> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await decode(file);
	} catch {
		throw new PhotoError('type');
	}
	try {
		const { width, height } = fitWithin(bitmap.width, bitmap.height);
		const { canvas: c, ctx } = canvas(width, height);
		ctx.drawImage(bitmap, 0, 0, width, height);
		if (file.type !== 'image/jpeg' && hasAlpha(ctx, width, height)) {
			for (const type of ['image/webp', 'image/png']) {
				const blob = await encode(c, type, JPEG_QUALITY);
				if (blob?.type === type && blob.size <= UPLOAD_MAX_BYTES) return blob;
			}
			// Over the size cap with alpha, so flatten onto white, since JPEG would turn it black.
			ctx.globalCompositeOperation = 'destination-over';
			ctx.fillStyle = '#fff';
			ctx.fillRect(0, 0, width, height);
		}
		const blob = await encode(c, 'image/jpeg', JPEG_QUALITY);
		if (!blob || blob.type !== 'image/jpeg') throw new PhotoError('type');
		if (blob.size > UPLOAD_MAX_BYTES) throw new PhotoError('size');
		return blob;
	} finally {
		bitmap.close();
	}
}

const EXT: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/png': 'png'
};

/** The upload's display name: the original base name with the extension of its re-encoded type. */
export function photoName(name: string, type = 'image/jpeg'): string {
	const base = name.replace(/\.[^.]*$/, '').trim() || 'photo';
	return `${base}.${EXT[type] ?? 'jpg'}`;
}
