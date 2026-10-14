/**
 * What the chat's media views read from a tool call or a command result:
 * the saved images and the video job, from the call's presentation metadata
 * or, for commands and older calls, from the result text.
 * @module dsh-media-gen/src/client/media-model
 */

/** Suffixes of images the plugin saves. */
const IMAGE_SUFFIX = /\.(?:png|jpe?g|webp|gif)$/iu

/** URL of one generated file, served by the Host's file route. */
export function fileUrl(path: string): string {
  return `api/media-gen.file?path=${encodeURIComponent(path)}`
}

/** Image paths listed one per line as `- <path>` or `- <path> (<type>, …)`. */
export function imagePathsOf(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const match = /^- (.+?)(?: \([a-z]+\/[a-z0-9.+-]+, \d+ bytes\))?$/u.exec(line.trim())
    if (match !== null && IMAGE_SUFFIX.test(match[1]!)) out.push(match[1]!)
  }
  return out
}

/** Video job id at the start of a job description. */
export function jobIdOf(text: string): string | undefined {
  return /^Video job (\S+) \(/u.exec(text.trim())?.[1]
}

/** Text of a result's text blocks. */
export function textOf(content: readonly unknown[] | undefined): string {
  return (content ?? [])
    .filter((b): b is { type: 'text'; text: string } => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text')
    .map(b => b.text)
    .join('\n')
}

/** Saved images from an image tool result's metadata, else its text. */
export function imagesOf(meta: unknown, text: string): string[] {
  const images = (meta as { images?: unknown } | null | undefined)?.images
  if (Array.isArray(images)) {
    const paths = images.map(i => (i as { path?: unknown }).path).filter((p): p is string => typeof p === 'string')
    if (paths.length > 0) return paths
  }
  return imagePathsOf(text)
}

/** Video job id from a video tool result's metadata, else its text. */
export function videoJobOf(meta: unknown, text: string): string | undefined {
  const id = (meta as { jobId?: unknown } | null | undefined)?.jobId
  return typeof id === 'string' && id.length > 0 ? id : jobIdOf(text)
}

/** The prompt argument of a raw tool-call argument string. */
export function promptOf(argsRaw: string | undefined): string | undefined {
  if (argsRaw === undefined) return undefined
  try {
    const prompt = (JSON.parse(argsRaw) as { prompt?: unknown }).prompt
    return typeof prompt === 'string' ? prompt : undefined
  } catch {
    return undefined
  }
}
