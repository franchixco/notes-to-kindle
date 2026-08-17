import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from './types';

export type ConvertibleMediaType = 'image/png' | 'image/webp';

export interface RasterToJpeg {
	convert(data: Uint8Array, mediaType: ConvertibleMediaType): Promise<Uint8Array>;
}

export class ImageConversionUnavailableError extends Error {}

const JPEG_QUALITY = 0.9;

function encodeCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob) resolve(blob);
			else reject(new Error('Canvas JPEG encoding returned no data.'));
		}, 'image/jpeg', JPEG_QUALITY);
	});
}

export const chromiumRasterToJpeg: RasterToJpeg = {
	async convert(data: Uint8Array, mediaType: ConvertibleMediaType): Promise<Uint8Array> {
		if (typeof window.createImageBitmap !== 'function' || typeof window.document === 'undefined') {
			throw new ImageConversionUnavailableError('Chromium image conversion APIs are unavailable.');
		}
		const blob = new Blob([new Uint8Array(data)], { type: mediaType });
		let bitmap: ImageBitmap | null = null;
		let canvas: HTMLCanvasElement | null = null;
		try {
			bitmap = await window.createImageBitmap(blob, {
				imageOrientation: 'from-image',
				colorSpaceConversion: 'default',
				resizeQuality: 'high',
			});
			if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > MAX_IMAGE_PIXELS / bitmap.height) {
				throw new Error('Decoded image dimensions exceed the safe limit.');
			}
			canvas = window.document.body.createEl('canvas', { cls: 'is-hidden' });
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
			if (!context) throw new ImageConversionUnavailableError('A 2D canvas context is unavailable.');
			context.fillStyle = '#ffffff';
			context.fillRect(0, 0, bitmap.width, bitmap.height);
			context.drawImage(bitmap, 0, 0);
			const output = await encodeCanvas(canvas);
			if (output.type !== 'image/jpeg') throw new Error('Chromium did not produce a JPEG image.');
			if (output.size < 1 || output.size > MAX_IMAGE_BYTES) throw new Error('Converted JPEG exceeds the safe size limit.');
			return new Uint8Array(await output.arrayBuffer());
		} finally {
			bitmap?.close();
			if (canvas) {
				canvas.width = 0;
				canvas.height = 0;
				canvas.remove();
			}
		}
	},
};
