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
  findModel, loadEstimate, loadModels, loadSessionChoices, optionsOf,
  type Estimate, type ModelListing, type SessionChoices,
} from './api.ts'
import { agentRequest, directCommand, EMPTY_VALUES, type CardValues } from './card-model.ts'
import type { Translate } from './locales.ts'

const fieldStyle: CSSProperties = {
  font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid var(--border, rgba(127,127,127,.35))',
  borderRadius: 6, padding: '4px 8px', width: '100%', boxSizing: 'border-box',
}
const rowStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '8em 1fr', alignItems: 'center', gap: 8, margin: '6px 0' }

/** Props the card's slot entry receives. */
export interface ComposeButtonProps {
  t: Translate
  sessionId: string
  inputActions: { setDraft(text: string): void; submit(): void }
  command(line: string): Promise<void>
}

/** Toolbar button that opens the generation card. */
export function ComposeButton(props: ComposeButtonProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="toolbar" size="sm" onClick={() => { setOpen(true) }} title={props.t('composeTitle')}>{props.t('compose')}</Button>
      {open ? <ComposeCard {...props} onClose={() => { setOpen(false) }} /> : null}
    </>
  )
}

function formatCost(t: Translate, estimate: Estimate | undefined): string {
  const cost = estimate?.cost
  if (cost === null || cost === undefined) return t('estimateUnknown')
  const n = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(v)
  return t('estimate', { cost: cost.min === cost.max ? t('costOne', { amount: n(cost.min) }) : t('costRange', { min: n(cost.min), max: n(cost.max) }) })
}

function ComposeCard(props: ComposeButtonProps & { onClose(): void }): ReactNode {
  const { t } = props
  const [values, setValues] = useState<CardValues>(EMPTY_VALUES)
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
        ...values.kind === 'video' ? { duration: values.duration, audio: values.audio } : {},
      }, controller.signal).then(
        (value) => { setEstimate({ value, loading: false }) },
        (e: unknown) => { if (!controller.signal.aborted) setEstimate({ error: e instanceof Error ? e.message : String(e), loading: false }) },
      )
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [values.kind, values.model, values.aspect, values.resolution, values.duration, values.audio, props.sessionId])

  const models = useMemo(() => optionsOf(listing, values.model), [listing, values.model])
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
              onClick={() => { send(() => { props.inputActions.setDraft(agentRequest(values, t, findModel(listing, values.model)?.name)); props.inputActions.submit() }) }}>
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
            onClick={() => { set({ ...EMPTY_VALUES, kind, content: values.content }) }}>
            {t(kind)}
          </Button>
        ))}
      </div>
      <label style={{ display: 'block', margin: '6px 0' }}>
        <span>{t('content')}</span>
        <textarea data-modal-autofocus rows={4} style={{ ...fieldStyle, resize: 'vertical', marginTop: 4 }} placeholder={t('contentHint')}
          value={values.content} onChange={(e) => { set({ content: e.target.value }) }} />
      </label>
      <label style={rowStyle}>
        <span>{t('model')}</span>
        <select style={fieldStyle} value={values.model} onChange={(e) => { set({ model: e.target.value, aspect: '', resolution: '', duration: '', audio: '' }) }}>
          <option value="">{fallback === undefined ? t('noDefault') : t('sessionDefault', { model: fallback })}</option>
          {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
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
