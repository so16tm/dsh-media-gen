/**
 * VideoPreview (browser): plays MP4, WebM, and QuickTime files in DSH's
 * right-sidebar document preview, which has no built-in video renderer.
 * @module dsh-media-gen/src/client/video
 */

import { useEffect, useState, type ReactNode } from 'react'

/** Preview implementation id, shared by its metadata and its keyed body. */
export const VIDEO_PREVIEW_ID = 'dsh-media-gen/video'

/** Suffixes played by the preview, with the media type given to their bytes. */
export const VIDEO_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
}

/** Document content as DSH hands it to a `bytes-complete` renderer. */
export type DocumentContent =
  | { readonly kind: 'bytes'; readonly data: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'text' | 'renderer' }

/** The subset of DSH's document-body props this renderer reads. */
export interface VideoBodyProps {
  readonly resourceAddress: string
  readonly content: DocumentContent
  readonly t: (key: 'failed' | 'loading', params?: Record<string, string>) => string
}

/**
 * Pick the media type from a resource address's final suffix.
 * @param address - DSH resource address or path; may be URL-encoded.
 */
export function videoMediaType(address: string): string | undefined {
  let path = address.split(/[?#]/u)[0] ?? ''
  try {
    path = decodeURIComponent(path)
  } catch {
    // An undecodable address still has a readable suffix.
  }
  const suffix = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return VIDEO_TYPES[suffix]
}

/**
 * Play complete video bytes from a Blob URL that lives as long as the body.
 * @param props - document content and resource identity.
 */
export function VideoBody(props: VideoBodyProps): ReactNode {
  const { content, resourceAddress, t } = props
  const data = content.kind === 'bytes' ? content.data : undefined
  const mediaType = videoMediaType(resourceAddress)
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (data === undefined || mediaType === undefined) return
    const objectUrl = URL.createObjectURL(new Blob([data], { type: mediaType }))
    setUrl(objectUrl)
    setFailed(false)
    return () => { URL.revokeObjectURL(objectUrl) }
  }, [data, mediaType])

  if (failed || mediaType === undefined) return <p style={{ padding: 16, color: 'var(--text-secondary, inherit)' }}>{t('failed')}</p>
  if (url === undefined) return <p style={{ padding: 16, color: 'var(--text-secondary, inherit)' }}>{t('loading')}</p>
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 12, height: '100%', boxSizing: 'border-box' }}>
      <video
        controls
        playsInline
        src={url}
        onError={() => { setFailed(true) }}
        style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8, background: '#000' }}
      />
    </div>
  )
}
