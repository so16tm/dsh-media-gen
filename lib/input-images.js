/**
 * InputImages: local images handed to a model as references or video
 * frames. Files are read from the session working directory, checked by
 * their signature, and sent as Base64 data URLs, because they have no public
 * URL the provider could fetch.
 * @module dsh-media-gen/src/input-images
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MediaError } from "./errors.js";
import { convertToPng } from "./image-convert.js";
import { sniffImage } from "./output.js";
/** Largest input image accepted. */
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * Formats video models take as frames and references. OpenRouter's video
 * models (Veo among them) refuse WebP with "Expected JPEG or PNG".
 */
export const VIDEO_INPUT_TYPES = ['image/png', 'image/jpeg'];
/** Most input images one call may carry. */
export const MAX_INPUT_IMAGES = 16;
/**
 * Check a list of input paths before anything is read or billed.
 * @returns the trimmed, de-duplicated paths.
 */
export function inputPaths(paths, name) {
    const out = [...new Set((paths ?? []).map(p => p.trim()).filter(p => p.length > 0))];
    if (out.length > MAX_INPUT_IMAGES)
        throw new MediaError('LIMIT_EXCEEDED', `${name} takes at most ${MAX_INPUT_IMAGES} images; got ${out.length}`);
    return out;
}
/**
 * The input paths that lie outside the working directory. Such a file is sent
 * to the provider only after the user sees its path.
 * @param paths - absolute, or relative to `cwd`.
 * @param cwd - the session working directory.
 */
export function outsidePaths(paths, cwd) {
    return paths.filter((path) => {
        const rel = relative(cwd, isAbsolute(path) ? path : resolve(cwd, path));
        return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    });
}
/**
 * Read one input image.
 * @param path - absolute, or relative to `cwd`.
 * @param cwd - the session working directory.
 * @param accept - formats the model takes; another format is re-encoded as
 * PNG. Undefined sends the file as it is.
 * @throws MediaError INVALID_REQUEST when the file is missing, too large, or not an image.
 */
export async function loadInputImage(path, cwd, maxBytes = MAX_INPUT_IMAGE_BYTES, accept) {
    const full = isAbsolute(path) ? path : resolve(cwd, path);
    let size;
    try {
        const info = await stat(full);
        if (!info.isFile())
            throw new Error('not a file');
        size = info.size;
    }
    catch {
        throw new MediaError('INVALID_REQUEST', `input image not found: ${path}`);
    }
    if (size > maxBytes)
        throw new MediaError('INVALID_REQUEST', `input image ${path} is ${size} bytes, above the ${maxBytes}-byte limit`);
    let data = new Uint8Array(await readFile(full));
    let mediaType = sniffImage(data);
    if (mediaType === undefined)
        throw new MediaError('INVALID_REQUEST', `${path} is not a PNG, JPEG, WebP, or GIF image`);
    if (accept !== undefined && !accept.includes(mediaType)) {
        data = await convertToPng(data, mediaType, path);
        mediaType = 'image/png';
    }
    return { path: full, mediaType, bytes: data.byteLength, dataUrl: `data:${mediaType};base64,${Buffer.from(data).toString('base64')}` };
}
/** Read several input images in order. */
export async function loadInputImages(paths, cwd, accept) {
    const out = [];
    for (const path of paths)
        out.push(await loadInputImage(path, cwd, MAX_INPUT_IMAGE_BYTES, accept));
    return out;
}
