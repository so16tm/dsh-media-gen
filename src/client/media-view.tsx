/**
 * Media views: the chat rows of the generation tools and of `/image` and
 * `/video`, showing the saved images and, once its job ends, the video.
 * They replace DSH's generic tool card for these names only.
 * @module dsh-media-gen/src/client/media-view
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { Translate } from './locales.ts'
import { activeInput, onInputsChange } from './media-actions.ts'
import { turnImages, type TurnTailOwner } from './turn-media.ts'
import { fileUrl, imagePathsOf, imagesOf, jobIdOf, promptOf, textOf, videoJobOf } from './media-model.ts'

/** How often a running video job is checked while its row is on screen. */
const JOB_POLL_MS = 10_000

/** The parts of DSH's tool-call block the views read. */
interface ToolBlock {
  kind?: string
  argsRaw?: string
  call?: { argsRaw: string } | null
  content?: readonly unknown[]
  isError?: boolean
  meta?: unknown
}

/** Owner props of DSH's `tool.call.toolview` slot, plus this plugin's translator. */
export interface MediaToolViewProps {
  toolName: string
  block: ToolBlock
  openFile(path: string): void
  /** Chat-supplied, session-authorized loader for an image attachment of the result. */
  loadImage?: (attachment: unknown) => Promise<string>
  t: Translate
}

/** Owner props of DSH's `conversation.chat.commandview` slot, plus this plugin's translator. */
export interface MediaCommandViewProps {
  node: { name: string | null; args: string | null; outcome: { kind: 'success' | 'error'; text?: string } | null }
  t: Translate
}

const headStyle: CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0, fontSize: 14, lineHeight: '24px',
  color: 'var(--dsw-alias-label-secondary)',
}
const quietStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
}
const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap', fontSize: 13 }
const mediaStyle: CSSProperties = {
  display: 'block', maxWidth: 'min(100%, 360px)', maxHeight: 360, borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
}

function Head(props: { title: string; detail?: string | undefined }): ReactNode {
  return (
    <div style={headStyle}>
      <span>{props.title}</span>
      {props.detail === undefined ? null : <span style={quietStyle}>{props.detail}</span>}
    </div>
  )
}

function Prompt(props: { text: string | undefined; t: Translate }): ReactNode {
  if (props.text === undefined || props.text.length === 0) return null
  return (
    <details style={{ fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' }}>
      <summary style={{ cursor: 'pointer' }}>{props.t('mediaPrompt')}</summary>
      <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{props.text}</p>
    </details>
  )
}

/**
 * One saved image. Files saved before the plugin kept its file index are not
 * served by the file route, so a failed load falls back to the result's
 * attachment through the chat's own loader.
 */
function Thumb(props: { path: string; attachment: unknown; loadImage?: MediaToolViewProps['loadImage']; alt: string }): ReactNode {
  const [src, setSrc] = useState(fileUrl(props.path))
  const [fellBack, setFellBack] = useState(false)
  const fallback = (): void => {
    if (fellBack || props.attachment === undefined || props.loadImage === undefined) return
    setFellBack(true)
    props.loadImage(props.attachment).then(setSrc, () => {})
  }
  return <img src={src} alt={props.alt} loading="lazy" style={mediaStyle} onError={fallback} />
}

/**
 * Buttons that reuse one saved image: as a reference for a new image, as a
 * video's first frame, or in the chat draft. They act on the chat input on
 * screen and are disabled while none is mounted.
 */
function ImageActions(props: { path: string; t: Translate }): ReactNode {
  const { t, path } = props
  const input = useSyncExternalStore(onInputsChange, activeInput)
  const disabled = input === undefined
  const title = disabled ? t('useUnavailable') : undefined
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      <Button variant="outline" size="sm" disabled={disabled} title={title}
        onClick={() => { input?.compose({ kind: 'image', images: [path] }) }}>{t('useForImage')}</Button>
      <Button variant="outline" size="sm" disabled={disabled} title={title}
        onClick={() => { input?.compose({ kind: 'video', firstFrame: path }) }}>{t('useForVideo')}</Button>
      <Button variant="outline" size="sm" disabled={disabled} title={title}
        onClick={() => { input?.setDraft(t('useInChatDraft', { path })) }}>{t('useInChat')}</Button>
    </div>
  )
}

/** Thumbnails of saved images; a click opens the file in DSH's preview, or the image itself. */
function Images(props: {
  paths: readonly string[]
  attachments: readonly unknown[]
  loadImage?: MediaToolViewProps['loadImage']
  open?: ((path: string) => void) | undefined
  t: Translate
}): ReactNode {
  if (props.paths.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '6px 0' }}>
      {props.paths.map((path, index) => (
        <figure key={path} style={{ margin: 0, maxWidth: 'min(100%, 360px)' }}>
          <a href={fileUrl(path)} target="_blank" rel="noreferrer" title={path}
            onClick={(e) => { if (props.open !== undefined) { e.preventDefault(); props.open(path) } }}>
            <Thumb path={path} attachment={props.attachments[index]} loadImage={props.loadImage} alt={props.t('generatedImageAlt')} />
          </a>
          <ImageActions path={path} t={props.t} />
        </figure>
      ))}
    </div>
  )
}

interface JobState {
  status: string
  model?: string
  error?: string
  files: { path: string; mediaType: string }[]
}

/** A video job's outcome, checked until it ends while the row is shown. */
function JobVideo(props: { jobId: string; t: Translate }): ReactNode {
  const { t } = props
  const [job, setJob] = useState<JobState>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      fetch(`api/media-gen.job?id=${encodeURIComponent(props.jobId)}`, { credentials: 'same-origin' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return await response.json() as JobState
        })
        .then((next) => {
          if (!live) return
          setJob(next)
          setFailed(false)
          if (next.status === 'pending' || next.status === 'in_progress' || (next.status === 'completed' && next.files.length === 0)) {
            timer = setTimeout(check, JOB_POLL_MS)
          }
        }, () => { if (live) setFailed(true) })
    }
    check()
    return () => { live = false; if (timer !== undefined) clearTimeout(timer) }
  }, [props.jobId])
  if (failed && job === undefined) return null
  if (job === undefined) return null
  if (job.files.length > 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '6px 0' }}>
        {job.files.map(f => <video key={f.path} controls preload="metadata" src={fileUrl(f.path)} title={f.path} style={mediaStyle} />)}
      </div>
    )
  }
  if (job.status === 'pending' || job.status === 'in_progress' || job.status === 'completed') {
    return <p style={{ ...quietStyle, margin: '4px 0', fontSize: 13 }}>{t('videoWaiting')}</p>
  }
  return <p style={{ ...errorStyle, margin: '4px 0' }}>{t('videoEnded', { status: job.status, error: job.error ?? '' })}</p>
}

/** Row of `media_generate_image` and `media_generate_video` calls. */
/** Image attachments of a result, in order. */
function attachmentsOf(content: readonly unknown[] | undefined): unknown[] {
  return (content ?? [])
    .filter((block): block is { type: 'image'; attachment: unknown } => (block as { type?: unknown }).type === 'image')
    .map(block => block.attachment)
}

export function MediaToolView(props: MediaToolViewProps): ReactNode {
  const { t, block } = props
  const video = props.toolName === 'media_generate_video'
  const settled = 'kind' in block && block.kind !== undefined
  const prompt = promptOf(block.call?.argsRaw ?? block.argsRaw)
  const text = textOf(block.content)
  const model = (block.meta as { model?: unknown } | null | undefined)?.model
  const title = t(video ? 'videoTitle' : 'imageTitle')
  if (!settled) {
    return <div><Head title={title} detail={t('generating')} /><Prompt text={prompt} t={t} /></div>
  }
  if (block.isError === true) {
    return (
      <div>
        <Head title={title} />
        <p style={{ ...errorStyle, margin: '2px 0' }}>{text.split('\n')[0]}</p>
        <Prompt text={prompt} t={t} />
      </div>
    )
  }
  const jobId = video ? videoJobOf(block.meta, text) : undefined
  return (
    <div>
      <Head title={title} detail={typeof model === 'string' ? model : undefined} />
      {video
        ? jobId === undefined ? null : <JobVideo jobId={jobId} t={t} />
        : <Images paths={imagesOf(block.meta, text)} attachments={attachmentsOf(block.content)} loadImage={props.loadImage} open={props.openFile} t={t} />}
      <Prompt text={prompt} t={t} />
    </div>
  )
}

/**
 * Under a closed turn's reply: each image the turn generated, small, with the
 * reuse buttons, so they are at hand without opening the tool row.
 */
export function MediaTurnTail(props: TurnTailOwner & { t: Translate }): ReactNode {
  const { t } = props
  const paths = turnImages(props)
  if (paths.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0' }}>
      {paths.map(path => (
        <div key={path} style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
          <a href={fileUrl(path)} target="_blank" rel="noreferrer" title={path}
            onClick={(e) => { e.preventDefault(); props.openFile(path) }}>
            <img src={fileUrl(path)} alt={t('generatedImageAlt')} loading="lazy"
              style={{ ...mediaStyle, width: 40, height: 40, objectFit: 'cover', borderRadius: 4 }} />
          </a>
          <div style={{ minWidth: 0 }}>
            <div style={{ ...quietStyle, fontSize: 12 }}>{path.split(/[\\/]/u).at(-1)}</div>
            <ImageActions path={path} t={t} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Row of `/image` and `/video` commands: the line, then the images or the video. */
export function MediaCommandView(props: MediaCommandViewProps): ReactNode {
  const { t, node } = props
  const line = `/${node.name ?? ''} ${(node.args ?? '').trim()}`.trim()
  const outcome = node.outcome
  if (outcome === null) return <div><Head title={line} detail={t('generating')} /></div>
  const text = outcome.text ?? ''
  if (outcome.kind === 'error') {
    return <div><Head title={line} /><p style={{ ...errorStyle, margin: '2px 0' }}>{text}</p></div>
  }
  const images = node.name === 'image' ? imagePathsOf(text) : []
  const jobId = node.name === 'video' ? jobIdOf(text) : undefined
  return (
    <div>
      <Head title={line} />
      {images.length > 0
        ? <Images paths={images} attachments={[]} t={t} />
        : jobId !== undefined
          ? <JobVideo jobId={jobId} t={t} />
          : <p style={{ whiteSpace: 'pre-wrap', margin: '2px 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>{text}</p>}
    </div>
  )
}
