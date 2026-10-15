/**
 * ImageConvert: re-encode a WebP or GIF image as PNG for models that take
 * only JPEG or PNG, such as video models given a first frame. Decoding uses
 * libwebp compiled to WebAssembly and a pure-JS GIF reader, so nothing has
 * to be built on install; PNG is written with node:zlib.
 * @module dsh-media-gen/src/image-convert
 */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';
/** Decoded pixels: 8-bit RGBA, row by row. */
interface Rgba {
    width: number;
    height: number;
    data: Uint8Array | Uint8ClampedArray;
}
/** Encode RGBA pixels as a PNG file. */
export declare function encodePng(image: Rgba): Uint8Array;
/**
 * Re-encode a WebP or GIF image as PNG.
 * @param path - shown in the error when the image cannot be decoded.
 * @throws MediaError INVALID_REQUEST when the image cannot be decoded.
 */
export declare function convertToPng(data: Uint8Array, mediaType: ImageMediaType, path: string): Promise<Uint8Array>;
export {};
