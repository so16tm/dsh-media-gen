/**
 * What the generation card turns its fields into: a request for the agent
 * or a direct `/image` or `/video` line.
 * @module dsh-media-gen/src/client/card-model
 */

import type { MediaKind } from './api.ts'
import type { PickerKey, Translate } from './locales.ts'

/** What the user filled in. */
export interface CardValues {
  kind: MediaKind
  content: string
  /** Empty means the session choice or the configured default. */
  model: string
  aspect: string
  resolution: string
  duration: string
  /** Empty means not specified. */
  audio: '' | 'on' | 'off'
  /** Reference images of an image generation: saved file paths. */
  images: string[]
  /** First frame of a video: a saved image path, or empty. */
  firstFrame: string
}

/** Values the card starts with. */
export const EMPTY_VALUES: CardValues = {
  kind: 'image', content: '', model: '', aspect: '', resolution: '', duration: '', audio: '', images: [], firstFrame: '',
}

/** Input images of the values, whichever kind they are for. */
export function inputImagesOf(values: CardValues): string[] {
  return values.kind === 'image' ? values.images : values.firstFrame === '' ? [] : [values.firstFrame]
}

/** Values after switching kind: the content and the input images carry over. */
export function switchKind(values: CardValues, kind: CardValues['kind']): CardValues {
  const inputs = inputImagesOf(values)
  return {
    ...EMPTY_VALUES, kind, content: values.content,
    ...kind === 'image' ? { images: inputs } : { firstFrame: inputs[0] ?? '' },
  }
}

/** A path as one command-line value; quoted, because paths may hold spaces. */
function quoted(path: string): string {
  return `"${path}"`
}

/**
 * The request the agent receives: one line per filled field, in the
 * viewer's language, so the agent writes the model prompt from it.
 */
export function agentRequest(values: CardValues, t: Translate, modelName?: string): string {
  const lines = [t(values.kind === 'image' ? 'requestImage' : 'requestVideo')]
  const add = (key: PickerKey, value: string) => { if (value !== '') lines.push(t(key, { value })) }
  add('requestContent', values.content.trim())
  if (values.kind === 'image') add('requestInputImages', values.images.join(', '))
  else add('requestFirstFrame', values.firstFrame)
  add('requestModel', values.model === '' ? '' : modelName === undefined ? values.model : `${modelName} (${values.model})`)
  add('requestAspect', values.aspect)
  add('requestResolution', values.resolution)
  if (values.kind === 'video') {
    add('requestDuration', values.duration)
    if (values.audio !== '') lines.push(t(values.audio === 'on' ? 'requestAudioOn' : 'requestAudioOff'))
  }
  return lines.join('\n')
}

/** The `/image` or `/video` line that generates the content as written; `--yes` because the card showed the estimate. */
export function directCommand(values: CardValues): string {
  const parts = [`/${values.kind}`, '--yes']
  const add = (name: string, value: string) => { if (value !== '') parts.push(`--${name}`, value) }
  add('model', values.model)
  add('aspect', values.aspect)
  add('resolution', values.resolution)
  if (values.kind === 'image') {
    for (const path of values.images) parts.push('--image', quoted(path))
  } else {
    add('duration', values.duration)
    add('audio', values.audio)
    if (values.firstFrame !== '') parts.push('--first', quoted(values.firstFrame))
  }
  parts.push(values.content.trim())
  return parts.join(' ')
}
