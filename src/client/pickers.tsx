/**
 * Model pickers: the plugin's settings page and the per-session picker in
 * the chat input. Selections from the input go through the `/media-model`
 * command, so the Host validates and records them the same way.
 * @module dsh-media-gen/src/client/pickers
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { loadModels, loadSessionChoices, optionsOf, type MediaKind, type ModelListing, type SessionChoices } from './api.ts'
import type { Translate } from './locales.ts'

const selectStyle: CSSProperties = {
  font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid var(--border, rgba(127,127,127,.35))',
  borderRadius: 6, padding: '2px 6px', maxWidth: 220,
}

/** Load one kind's listing, with refresh. */
function useListing(kind: MediaKind): { listing?: ModelListing; error?: string; refresh(): void } {
  const [listing, setListing] = useState<ModelListing>()
  const [error, setError] = useState<string>()
  const load = useCallback((refresh: boolean) => {
    setError(undefined)
    loadModels(kind, refresh).then(setListing, (e: unknown) => { setError(e instanceof Error ? e.message : String(e)) })
  }, [kind])
  useEffect(() => { load(false) }, [load])
  return { ...listing === undefined ? {} : { listing }, ...error === undefined ? {} : { error }, refresh: () => { load(true) } }
}

// ---------------------------------------------------------------- settings page

/** Snapshot fields the settings page reads. */
interface FormState {
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown> | undefined
  revision: number | undefined
  writable: boolean
}

/** Owner props of DSH's `plugins.row.config` slot. */
export type ConfigViewProps = ({ view: 'summary' } | {
  view: 'page'
  form: {
    state: FormState
    mutate(ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[], revision?: number): Promise<boolean>
  }
}) & { t: Translate }

/** The plugin's configuration page on DSH's Plugins screen. */
export function SettingsView(props: ConfigViewProps): ReactNode {
  if (props.view === 'summary') return props.t('summary')
  return <SettingsPage {...props} />
}

function SettingsPage({ form, t }: Extract<ConfigViewProps, { view: 'page' }>): ReactNode {
  const [failed, setFailed] = useState(false)
  const value = form.state.value ?? {}
  const disabled = !form.state.writable || form.state.status !== 'ready'
  const write = (field: string, next: unknown): void => {
    const op = next === undefined || next === '' ? { op: 'unset' as const, path: [field] } : { op: 'set' as const, path: [field], value: next }
    setFailed(false)
    form.mutate([op], form.state.revision).then(ok => { setFailed(!ok) }, () => { setFailed(true) })
  }
  const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0' }
  const number = (field: string, min: number, max: number) => (
    <input
      type="number" min={min} max={max} disabled={disabled} style={{ ...selectStyle, width: 80 }}
      value={typeof value[field] === 'number' ? value[field] : ''}
      onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= min && n <= max) write(field, n) }}
    />
  )
  const flag = (field: string) => (
    <input type="checkbox" disabled={disabled} checked={value[field] === true} onChange={(e) => { write(field, e.target.checked) }} />
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <ModelRow kind="image" label={t('imageModel')} current={value.defaultImageModel} disabled={disabled} t={t} onChange={id => { write('defaultImageModel', id) }} />
      <ModelRow kind="video" label={t('videoModel')} current={value.defaultVideoModel} disabled={disabled} t={t} onChange={id => { write('defaultVideoModel', id) }} />
      <label style={row}>{t('maxImagesPerCall')}{number('maxImagesPerCall', 1, 10)}</label>
      <label style={row}>{t('maxVideoSeconds')}{number('maxVideoSeconds', 1, 120)}</label>
      <label style={row}>{t('requireApproval')}{flag('requireApproval')}</label>
      <label style={row}>{t('notifyOnVideoCompletion')}{flag('notifyOnVideoCompletion')}</label>
      {failed ? <p role="alert" style={{ color: 'var(--danger, #d33)' }}>{t('saveFailed')}</p> : null}
    </div>
  )
}

function ModelRow(props: { kind: MediaKind; label: string; current: unknown; disabled: boolean; t: Translate; onChange(id: string | undefined): void }): ReactNode {
  const { listing, error, refresh } = useListing(props.kind)
  const current = typeof props.current === 'string' ? props.current : ''
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0' }}>
      <span>{props.label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {error !== undefined
          ? <span role="alert">{props.t('loadFailed', { message: error })}</span>
          : (
            <select style={selectStyle} disabled={props.disabled || listing === undefined} value={current}
              onChange={(e) => { props.onChange(e.target.value === '' ? undefined : e.target.value) }}>
              <option value="">{listing === undefined ? props.t('loading') : props.t('noDefault')}</option>
              {optionsOf(listing, current).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
        <button type="button" onClick={refresh} title={props.t('refresh')} aria-label={props.t('refresh')}
          style={{ ...selectStyle, cursor: 'pointer', padding: '2px 8px' }}>↻</button>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- chat input

/** Props the chat-input picker receives through its slot injection. */
export interface InputPickerProps {
  t: Translate
  sessionId: string
  /** Run a slash command line in this session. */
  command(line: string): Promise<void>
}

/** Compact image and video model pickers for the chat input. */
export function InputPicker(props: InputPickerProps): ReactNode {
  const [choices, setChoices] = useState<SessionChoices>()
  const [error, setError] = useState<string>()
  const reload = useCallback((signal?: AbortSignal) => {
    loadSessionChoices(props.sessionId, signal).then(setChoices, () => { /* the picker stays on its last state */ })
  }, [props.sessionId])
  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal)
    return () => { controller.abort() }
  }, [reload])
  const pick = (kind: MediaKind, id: string): void => {
    setError(undefined)
    props.command(`/media-model ${kind} ${id === '' ? 'default' : id}`)
      .then(() => { reload() }, (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); reload() })
  }
  return (
    <span title={error === undefined ? props.t('pickerTitle') : props.t('switchFailed', { message: error })}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <KindSelect kind="image" label={props.t('image')} choices={choices} t={props.t} onPick={pick} />
      <KindSelect kind="video" label={props.t('video')} choices={choices} t={props.t} onPick={pick} />
    </span>
  )
}

function KindSelect(props: { kind: MediaKind; label: string; choices: SessionChoices | undefined; t: Translate; onPick(kind: MediaKind, id: string): void }): ReactNode {
  const { listing } = useListing(props.kind)
  const chosen = props.choices?.[props.kind]?.model ?? ''
  const fallback = props.choices?.defaults[props.kind]
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ opacity: 0.7 }}>{props.label}</span>
      <select style={{ ...selectStyle, maxWidth: 160 }} value={chosen} disabled={props.choices === undefined}
        onChange={(e) => { props.onPick(props.kind, e.target.value) }}>
        <option value="">{fallback === null || fallback === undefined ? props.t('noDefault') : props.t('sessionDefault', { model: fallback })}</option>
        {optionsOf(listing, chosen).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </label>
  )
}
