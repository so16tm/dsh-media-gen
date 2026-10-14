/**
 * dsh-media-gen browser half: a video renderer for DSH's document preview,
 * the plugin's settings page, and the image and video model pickers in the
 * chat input. Built by scripts/build-client.mjs into DSH's client module
 * format.
 * @module dsh-media-gen/src/client
 */

import type { ComponentType } from 'react'
import { PICKER_DICTIONARIES, PICKER_LOCALE } from './locales.ts'
import { MediaCommandView, MediaToolView } from './media-view.tsx'
import { InputControl, SettingsView } from './pickers.tsx'
import { VIDEO_PREVIEW_ID, VIDEO_TYPES, VideoBody } from './video.tsx'

/** Services this half needs. */
export const inject = ['documentPreviews', 'slots', 'locale', 'sessions']

/** Key of this plugin's row on DSH's Plugins page: `<package>#<row id in cordis.patch.yml>`. */
export const CONFIG_KEY = 'dsh-media-gen#media-gen'

/** Id of the media control among the chat input's left controls. */
export const INPUT_PICKER_ID = 'dsh-media-gen.models'

/** Tool calls whose chat rows show the generated media. */
export const MEDIA_TOOLS = ['media_generate_image', 'media_generate_video'] as const

/** Commands whose chat rows show the generated media. */
export const MEDIA_COMMANDS = ['image', 'video'] as const

/** Locale namespace of the preview's labels. */
const LOCALE = 'mediaGenVideo'

const DICTIONARIES = {
  en: { title: 'Video', loading: 'Loading video…', failed: 'This video could not be played.' },
  ja: { title: '動画', loading: '動画を読み込んでいます…', failed: 'この動画は再生できません。' },
  zh: { title: '视频', loading: '正在加载视频…', failed: '无法播放此视频。' },
}

/** The parts of DSH's browser services this half calls. */
interface ClientContext {
  effect(fn: () => () => void, label?: string): void
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): (key: string) => string
  }
  documentPreviews: {
    register(definition: {
      id: string
      extensions: readonly string[]
      binaryExtensions?: readonly string[]
      priority?: 'builtin' | 'extension'
      title: () => string
      loading: 'text-pages' | 'bytes-complete' | 'renderer'
      wrap?: boolean
    }): () => void
  }
  slots: {
    inject(name: string, fn: () => () => void): () => void
    register(options: {
      name: string
      key?: string
      id?: string
      order?: number
      locale?: string
      inject?: (sessionId: string) => Record<string, unknown>
    }, component: ComponentType<never>): () => void
  }
  sessions: {
    binding(sessionId: string): {
      session: {
        command(line: string): Promise<
          | { ok: true; value: { matched: boolean } }
          | { ok: false; error: { code: string; message: string } }
        >
      }
    } | undefined
  }
}

/**
 * Run a slash command line in one session, as DSH's own pickers do.
 * @throws when the session is not live, the command fails, or the Host lacks it.
 */
export async function runCommand(sessions: ClientContext['sessions'], sessionId: string, line: string): Promise<void> {
  const live = sessions.binding(sessionId)?.session
  if (live === undefined) throw new Error('this session is not open yet')
  const result = await live.command(line)
  if (!result.ok) throw new Error(result.error.message)
  if (!result.value.matched) throw new Error(`the host offers no ${line.split(' ')[0]} command`)
}

/**
 * Register the video preview, the settings page, and the chat-input picker.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const extensions = Object.keys(VIDEO_TYPES)
  ctx.effect(() => ctx.locale.register(LOCALE, DICTIONARIES), 'media-gen: video dictionaries')
  const t = ctx.locale.bind(LOCALE)
  ctx.effect(() => ctx.documentPreviews.register({
    id: VIDEO_PREVIEW_ID,
    extensions,
    binaryExtensions: extensions,
    title: () => t('title'),
    loading: 'bytes-complete',
    wrap: false,
  }), 'media-gen: video preview')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: VIDEO_PREVIEW_ID, locale: LOCALE,
  }, VideoBody as ComponentType<never>)), 'media-gen: video body')

  ctx.effect(() => ctx.locale.register(PICKER_LOCALE, PICKER_DICTIONARIES), 'media-gen: picker dictionaries')
  ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config', key: CONFIG_KEY, locale: PICKER_LOCALE,
  }, SettingsView as ComponentType<never>)), 'media-gen: settings page')
  // DSH's tool and command rows are keyed by name; these replace the generic card for this plugin's names only.
  for (const key of MEDIA_TOOLS) {
    ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key, locale: PICKER_LOCALE,
    }, MediaToolView as ComponentType<never>)), `media-gen: ${key} row`)
  }
  for (const key of MEDIA_COMMANDS) {
    ctx.effect(() => ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
      name: 'conversation.chat.commandview', key, locale: PICKER_LOCALE,
    }, MediaCommandView as ComponentType<never>)), `media-gen: /${key} row`)
  }
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: INPUT_PICKER_ID,
    order: 100,
    locale: PICKER_LOCALE,
    inject: (sessionId: string) => ({ command: (line: string) => runCommand(ctx.sessions, sessionId, line) }),
  }, InputControl as ComponentType<never>)), 'media-gen: chat input control')
}
