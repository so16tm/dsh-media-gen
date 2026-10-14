/**
 * Generation card: a dialog opened from the chat input that collects the
 * basics (content, model, size, length, audio) and either hands them to the
 * agent as a request, which then writes the prompt for the model, or sends
 * the content unchanged through `/image` or `/video`.
 * @module dsh-media-gen/src/client/card
 */

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  findModel, loadEstimate, loadModels, loadSessionChoices, offeredOf, takesInputs,
  type Estimate, type ModelListing, type SessionChoices,
} from './api.ts'
import { agentRequest, directCommand, EMPTY_VALUES, inputImagesOf, switchKind, type CardValues } from './card-model.ts'
import type { Translate } from './locales.ts'

// Native controls take DSH's surface and label colors; Chromium draws a
// select's option list in them, so the list stays readable in both themes.
const fieldStyle: CSSProperties = {
  font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
  borderRadius: 6, padding: '4px 8px', width: '100%', boxSizing: 'border-box',
}
const rowStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '8em 1fr', alignItems: 'center', gap: 8, margin: '6px 0' }

/** What the card needs from the chat input it opens from. */
export interface ComposeButtonProps {
  t: Translate
  sessionId: string
  inputActions: { setDraft(text: string): void; submit(): void }
  command(line: string): Promise<void>
}

function formatCost(t: Translate, estimate: Estimate | undefined): string {
  const cost = estimate?.cost
  if (cost === null || cost === undefined) return t('estimateUnknown')
  const n = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(v)
  return t('estimate', { cost: cost.min === cost.max ? t('costOne', { amount: n(cost.min) }) : t('costRange', { min: n(cost.min), max: n(cost.max) }) })
}

/** The generation card dialog. */
export function ComposeCard(props: ComposeButtonProps & { onClose(): void; initial?: Partial<CardValues> | undefined }): ReactNode {
  const { t } = props
  const [values, setValues] = useState<CardValues>(() => ({ ...EMPTY_VALUES, ...props.initial }))
  const [listing, setListing] = useState<ModelListing>()
  const [choices, setChoices] = useState<SessionChoices>()
  const [estimate, setEstimate] = useState<{ value?: Estimate; error?: string; loading: boolean }>({ loading: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const set = (patch: Partial<CardValues>) => { setValues(v => ({ ...v, ...patch })) }

  useEffect(() => {
    let live = true
    setListing(undefined)
    loadModels(values.kind).then((l) => { if (live) setListing(l) }, () => {})
    return () => { live = false }
  }, [values.kind])
  useEffect(() => {
    const controller = new AbortController()
    loadSessionChoices(props.sessionId, controller.signal).then(setChoices, () => {})
    return () => { controller.abort() }
  }, [props.sessionId])

  const fallback = values.kind === 'image'
    ? choices?.image?.model ?? choices?.defaults.image ?? undefined
    : choices?.video?.model ?? choices?.defaults.video ?? undefined
  const effective = values.model === '' ? fallback : values.model
  const capabilities = findModel(listing, effective)?.options ?? {}

  // The estimate follows every change; the Host also validates the values against the model.
  useEffect(() => {
    const controller = new AbortController()
    setEstimate({ loading: true })
    const timer = setTimeout(() => {
      loadEstimate({
        kind: values.kind, sessionId: props.sessionId, model: values.model, aspect: values.aspect, resolution: values.resolution,
        ...values.kind === 'video'
          ? { duration: values.duration, audio: values.audio, first: values.firstFrame }
          : { image: values.images },
      }, controller.signal).then(
        (value) => { setEstimate({ value, loading: false }) },
        (e: unknown) => { if (!controller.signal.aborted) setEstimate({ error: e instanceof Error ? e.message : String(e), loading: false }) },
      )
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [values.kind, values.model, values.aspect, values.resolution, values.duration, values.audio, values.images, values.firstFrame, props.sessionId])

  const inputs = inputImagesOf(values)
  // With input images, only models that can take them are offered; the chosen one stays so the estimate can say why it fails.
  const models = useMemo(
    () => offeredOf(listing, choices?.chatModels?.[values.kind], [values.model, fallback])
      .filter(m => inputs.length === 0 || m.id === values.model || takesInputs(values.kind, m)),
    [listing, choices, values.kind, values.model, fallback, inputs.length],
  )
  const removeInput = (path: string) => {
    set(values.kind === 'image' ? { images: values.images.filter(p => p !== path) } : { firstFrame: '' })
  }
  const ready = values.content.trim().length > 0 && !busy
  const send = (action: () => Promise<void> | void) => {
    setBusy(true)
    setError(undefined)
    Promise.resolve().then(action).then(props.onClose, (e: unknown) => {
      setError(t('sendFailed', { message: e instanceof Error ? e.message : String(e) }))
      setBusy(false)
    })
  }
  const select = (label: string, value: string, onChange: (v: string) => void, options: readonly string[] | undefined, render = (v: string) => v) => (
    <label style={rowStyle}>
      <span>{label}</span>
      <select style={fieldStyle} value={value} onChange={(e) => { onChange(e.target.value) }} disabled={options !== undefined && options.length === 0}>
        <option value="">{t('unspecified')}</option>
        {(options ?? []).map(v => <option key={v} value={v}>{render(v)}</option>)}
      </select>
    </label>
  )

  return (
    <Modal
      open
      onClose={props.onClose}
      title={t('composeTitle')}
      closeLabel={t('close')}
      footer={(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="outline" disabled={!ready} title={t('askAgentHint')}
              onClick={() => { send(() => { props.inputActions.setDraft(agentRequest({ ...values, model: effective ?? '' }, t, findModel(listing, effective)?.name)); props.inputActions.submit() }) }}>
              {t('askAgent')}
            </Button>
            <Button variant="primary" disabled={!ready || estimate.error !== undefined || estimate.loading} title={t('generateDirectHint')}
              onClick={() => { send(() => props.command(directCommand(values))) }}>
              {t('generateDirect')}
            </Button>
          </div>
        </div>
      )}
    >
      <div role="radiogroup" style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {(['image', 'video'] as const).map(kind => (
          <Button key={kind} variant={values.kind === kind ? 'primary' : 'outline'} size="sm" role="radio" aria-checked={values.kind === kind}
            onClick={() => { setValues(v => switchKind(v, kind)) }}>
            {t(kind)}
          </Button>
        ))}
      </div>
      <label style={{ display: 'block', margin: '6px 0' }}>
        <span>{t('content')}</span>
        <textarea data-modal-autofocus rows={4} style={{ ...fieldStyle, resize: 'vertical', marginTop: 4 }} placeholder={t('contentHint')}
          value={values.content} onChange={(e) => { set({ content: e.target.value }) }} />
      </label>
      {inputs.length === 0 ? null : (
        <div style={{ ...rowStyle, alignItems: 'start' }}>
          <span>{t(values.kind === 'image' ? 'inputImages' : 'firstFrame')}</span>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            {inputs.map(path => (
              <li key={path} style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                <span title={path} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{path}</span>
                <Button variant="outline" size="sm" onClick={() => { removeInput(path) }}>{t('removeInput')}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <label style={rowStyle}>
        <span>{t('model')}</span>
        <select style={fieldStyle} value={values.model} onChange={(e) => { set({ model: e.target.value, aspect: '', resolution: '', duration: '', audio: '' }) }}>
          <option value="">{fallback === undefined ? t('noDefault') : t('sessionDefault', { model: fallback })}</option>
          {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      {inputs.length > 0 && models.length === 0 && listing !== undefined
        ? <p role="note" style={{ margin: '4px 0', opacity: 0.8 }}>{t('noInputModels')}</p>
        : null}
      {select(t('aspect'), values.aspect, v => { set({ aspect: v }) }, capabilities.aspectRatios)}
      {select(t('resolution'), values.resolution, v => { set({ resolution: v }) }, capabilities.resolutions)}
      {values.kind === 'video'
        ? (
          <>
            {select(t('duration'), values.duration, v => { set({ duration: v }) }, capabilities.durations?.map(String), v => t('seconds', { n: v }))}
            <label style={rowStyle}>
              <span>{t('audio')}</span>
              <select style={fieldStyle} value={values.audio} disabled={capabilities.audio === false}
                onChange={(e) => { set({ audio: e.target.value as CardValues['audio'] }) }}>
                <option value="">{t('unspecified')}</option>
                <option value="on">{t('requestAudioOn')}</option>
                <option value="off">{t('requestAudioOff')}</option>
              </select>
            </label>
          </>
        )
        : null}
      <p style={{ margin: '8px 0 0', opacity: 0.8 }} role="status">
        {estimate.loading ? t('estimating') : estimate.error !== undefined ? estimate.error : formatCost(t, estimate.value)}
      </p>
      {error === undefined ? null : <p role="alert" style={{ color: 'var(--danger, #d33)' }}>{error}</p>}
    </Modal>
  )
}
