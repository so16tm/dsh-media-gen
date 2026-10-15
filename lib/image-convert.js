/**
 * ImageConvert: re-encode a WebP or GIF image as PNG for models that take
 * only JPEG or PNG, such as video models given a first frame. Decoding uses
 * libwebp compiled to WebAssembly and a pure-JS GIF reader, so nothing has
 * to be built on install; PNG is written with node:zlib.
 * @module dsh-media-gen/src/image-convert
 */
import { crc32, deflateSync } from 'node:zlib';
import { MediaError } from "./errors.js";
async function decode(data, mediaType) {
    if (mediaType === 'image/webp') {
        // Loaded on first use: the module compiles its WebAssembly when imported.
        const { decode: decodeWebp } = await import('@cwasm/webp');
        return decodeWebp(data);
    }
    if (mediaType === 'image/gif') {
        const { GifReader } = await import('omggif');
        const reader = new GifReader(data);
        const pixels = new Uint8Array(reader.width * reader.height * 4);
        // An animated GIF gives its first frame.
        reader.decodeAndBlitFrameRGBA(0, pixels);
        return { width: reader.width, height: reader.height, data: pixels };
    }
    throw new Error(`no decoder for ${mediaType}`);
}
function chunk(type, body) {
    const out = Buffer.alloc(12 + body.byteLength);
    out.writeUInt32BE(body.byteLength, 0);
    out.write(type, 4, 'ascii');
    out.set(body, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.byteLength)), 8 + body.byteLength);
    return out;
}
/** Encode RGBA pixels as a PNG file. */
export function encodePng(image) {
    const { width, height, data } = image;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // colour type: RGBA
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        // Each row starts with filter type 0 (none).
        raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    return Buffer.concat([
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', new Uint8Array(0)),
    ]);
}
/**
 * Re-encode a WebP or GIF image as PNG.
 * @param path - shown in the error when the image cannot be decoded.
 * @throws MediaError INVALID_REQUEST when the image cannot be decoded.
 */
export async function convertToPng(data, mediaType, path) {
    try {
        return encodePng(await decode(data, mediaType));
    }
    catch (err) {
        throw new MediaError('INVALID_REQUEST', `${path} could not be converted from ${mediaType} to PNG: ${err instanceof Error ? err.message : String(err)}`);
    }
}
