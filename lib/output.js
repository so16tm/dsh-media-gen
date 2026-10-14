/**
 * MediaOutput: persist generated images as files under the session working
 * directory and, when an attachment store is mounted, as durable attachments
 * the chat can display. Files are the lasting copy; provider URLs are never
 * relied on.
 * @module dsh-media-gen/src/output
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { MediaError } from "./errors.js";
const EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};
/**
 * Identify a supported image from its signature; the provider's declared type
 * is not trusted.
 */
export function sniffImage(data) {
    const at = (i) => data[i];
    const ascii = (offset, text) => [...text].every((c, i) => at(offset + i) === c.charCodeAt(0));
    if (at(0) === 0x89 && ascii(1, 'PNG'))
        return 'image/png';
    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff)
        return 'image/jpeg';
    if (ascii(0, 'GIF8'))
        return 'image/gif';
    if (ascii(0, 'RIFF') && ascii(8, 'WEBP'))
        return 'image/webp';
    return undefined;
}
/**
 * Resolve the output directory inside the working directory. An absolute or
 * escaping configuration is refused so generated files stay where the user
 * expects them.
 */
export function resolveOutputDir(cwd, configured) {
    if (isAbsolute(configured))
        throw new MediaError('INVALID_REQUEST', 'outputDir must be relative to the working directory');
    const dir = resolve(cwd, configured);
    const rel = relative(cwd, dir);
    if (rel.startsWith('..') || isAbsolute(rel))
        throw new MediaError('INVALID_REQUEST', 'outputDir must stay inside the working directory');
    return dir;
}
/**
 * Write a new file named `<base>.<extension>`, or `<base>-2.<extension>` and
 * so on when that name is taken, e.g. by a generation in the same second.
 * Existing files are never overwritten.
 * @returns the path written.
 */
export async function writeNewFile(dir, base, extension, data) {
    for (let n = 1;; n++) {
        const path = join(dir, `${base}${n === 1 ? '' : `-${n}`}.${extension}`);
        try {
            await writeFile(path, data, { flag: 'wx' });
            return path;
        }
        catch (error) {
            if (error.code !== 'EEXIST' || n >= 1000)
                throw error;
        }
    }
}
/** File-name-safe slug of a model id. */
export function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'image';
}
/** Local `YYYYMMDD-HHMMSS` stamp used in output file names. */
export function timestamp(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
/**
 * Save generated images.
 * @param images - decoded image bytes in provider order.
 * @param options - destination directory, naming, and optional attachment store.
 * @returns saved images and how many attachments were refused.
 */
export async function saveImages(images, options) {
    await mkdir(options.dir, { recursive: true });
    const stem = `${timestamp(options.now ?? new Date())}-${slug(options.model)}`;
    const saved = [];
    let attachmentFailures = 0;
    // Every image is checked before any is written, so a bad one leaves no partial batch.
    const types = images.map((data) => {
        if (data.byteLength > options.maxBytes) {
            throw new MediaError('INVALID_RESPONSE', `a generated image is ${data.byteLength} bytes, above the ${options.maxBytes}-byte limit`);
        }
        const mediaType = sniffImage(data);
        if (mediaType === undefined)
            throw new MediaError('INVALID_RESPONSE', 'the provider returned an unsupported image format');
        return mediaType;
    });
    for (const [index, data] of images.entries()) {
        const mediaType = types[index];
        const path = await writeNewFile(options.dir, `${stem}-${index + 1}`, EXTENSIONS[mediaType], data);
        const entry = { path, mediaType, bytes: data.byteLength };
        if (options.attachments !== undefined && options.attachments.imageLimits.mediaTypes.includes(mediaType)) {
            try {
                entry.attachment = await options.attachments.saveImage({ data, mediaType, name: path.slice(options.dir.length + 1) });
            }
            catch {
                // The file is still saved; the chat only loses the inline preview.
                attachmentFailures += 1;
            }
        }
        saved.push(entry);
    }
    return { saved, attachmentFailures };
}
