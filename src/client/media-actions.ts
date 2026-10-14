/**
 * Media actions: lets a generated image in the chat be reused. The chat
 * input's media control registers itself here while it is mounted, and the
 * buttons under an image call the most recently mounted one, which belongs
 * to the conversation on screen.
 * @module dsh-media-gen/src/client/media-actions
 */

import type { CardValues } from './card-model.ts'

/** What the chat input offers to an image's buttons. */
export interface InputHandle {
  sessionId: string
  /** Open the generation card with these values filled in. */
  compose(initial: Partial<CardValues>): void
  /** Replace the chat input's draft. */
  setDraft(text: string): void
}

const handles: InputHandle[] = []
const listeners = new Set<() => void>()

/**
 * Register a chat input while it is mounted.
 * @returns the function that removes it.
 */
export function registerInput(handle: InputHandle): () => void {
  handles.push(handle)
  for (const l of listeners) l()
  return () => {
    const index = handles.lastIndexOf(handle)
    if (index >= 0) handles.splice(index, 1)
    for (const l of listeners) l()
  }
}

/** The chat input the buttons act on, if any is mounted. */
export function activeInput(): InputHandle | undefined {
  return handles.at(-1)
}

/** Call `listener` whenever the set of inputs changes. */
export function onInputsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
