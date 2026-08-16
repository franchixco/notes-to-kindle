export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_UNIQUE_IMAGES = 100;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_EPUB_BYTES = 60 * 1024 * 1024;
export const MAX_EMBED_REFERENCES = 2_000;
export const MAX_EXPANDED_NOTES = 256;
export const MAX_TOTAL_MARKDOWN_BYTES = 5 * 1024 * 1024;

export type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif';
export type SupportedImageExtension = 'jpg' | 'png' | 'gif';

export interface EpubImageAsset {
	hash: string;
	href: string;
	mediaType: SupportedImageMediaType;
	data: Uint8Array;
	sourcePath: string;
	width: number;
	height: number;
}

export type ImageWarningCode =
	| 'image-not-found'
	| 'unsupported-image-format'
	| 'invalid-image-binary'
	| 'transparent-image'
	| 'animated-gif'
	| 'image-too-large'
	| 'image-budget-exceeded'
	| 'image-read-failed';

export interface ImageWarning {
	code: ImageWarningCode;
	sourcePath: string;
	target: string;
	message: string;
}

export interface ValidatedImage {
	mediaType: SupportedImageMediaType;
	extension: SupportedImageExtension;
	width: number;
	height: number;
}

export type ImageValidationResult =
	| { ok: true; image: ValidatedImage }
	| {
		ok: false;
		code: Extract<ImageWarningCode,
			| 'unsupported-image-format'
			| 'invalid-image-binary'
			| 'transparent-image'
			| 'animated-gif'
			| 'image-too-large'>;
		reason: string;
	};
