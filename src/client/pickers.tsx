/**
 * Model pickers: the plugin's settings page and the chat input's media
 * control (generation card and per-session models). Selections from the input go through the `/media-model`
 * command, so the Host validates and records them the same way.
 * @module dsh-media-gen/src/client/pickers
 */

import { IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { findModel, loadModels, loadSessionChoices, offeredOf, optionsOf, type MediaKind, type ModelListing, type SessionChoices } from './api.ts'
import { ComposeCard, type ComposeButtonProps } from './card.tsx'
import type { Translate } from './locales.ts'

// Native controls take DSH's surface and label colors; Chromium draws a
// select's option list in them, so the list stays readable in both themes.
const selectStyle: CSSProperties = {
  font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
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
      <ChatModelsRow kind="image" label={t('chatImageModels')} current={value.chatImageModels} disabled={disabled} t={t}
        onChange={ids => { write('chatImageModels', ids.length === 0 ? undefined : ids) }} />
      <ChatModelsRow kind="video" label={t('chatVideoModels')} current={value.chatVideoModels} disabled={disabled} t={t}
        onChange={ids => { write('chatVideoModels', ids.length === 0 ? undefined : ids) }} />
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

/**
 * Choose which models the chat input offers. Nothing checked offers every
 * listed model; a search box narrows long provider listings.
 */
function ChatModelsRow(props: { kind: MediaKind; label: string; current: unknown; disabled: boolean; t: Translate; onChange(ids: string[]): void }): ReactNode {
  const { listing, error } = useListing(props.kind)
  const [query, setQuery] = useState('')
  const [onlyChecked, setOnlyChecked] = useState(false)
  const checked = Array.isArray(props.current) ? props.current.filter((id): id is string => typeof id === 'string') : []
  const needle = query.trim().toLowerCase()
  const models = optionsOf(listing, undefined)
    .filter(m => !onlyChecked || checked.includes(m.id))
    .filter(m => needle === '' || m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle))
  const toggle = (id: string, on: boolean) => {
    props.onChange(on ? [...checked, id] : checked.filter(other => other !== id))
  }
  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span>{props.label}</span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
          {checked.length === 0 ? props.t('chatModelsAll') : props.t('chatModelsCount', { count: String(checked.length) })}
        </span>
      </div>
      {error !== undefined
        ? <p role="alert">{props.t('loadFailed', { message: error })}</p>
        : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
              <input type="search" style={{ ...selectStyle, maxWidth: 'none', flex: 1 }} placeholder={props.t('chatModelsSearch')}
                value={query} onChange={(e) => { setQuery(e.target.value) }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={onlyChecked} onChange={(e) => { setOnlyChecked(e.target.checked) }} />
                {props.t('chatModelsOnlyChecked')}
              </label>
              <button type="button" disabled={props.disabled || checked.length === 0} onClick={() => { props.onChange([]) }}
                style={{ ...selectStyle, cursor: 'pointer' }}>{props.t('chatModelsClear')}</button>
            </div>
            <div role="group" aria-label={props.label}
              style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))', borderRadius: 6, padding: '4px 8px' }}>
              {listing === undefined ? <span>{props.t('loading')}</span> : models.map(m => (
                <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                  <input type="checkbox" disabled={props.disabled} checked={checked.includes(m.id)} onChange={(e) => { toggle(m.id, e.target.checked) }} />
                  <span>{m.name}</span>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>{m.id}</span>
                </label>
              ))}
            </div>
          </>
        )}
    </div>
  )
}

// ---------------------------------------------------------------- chat input

/** Props the chat-input control receives: its slot injection plus DSH's session-standard props. */
export type InputControlProps = ComposeButtonProps

type Pane = 'root' | MediaKind

/** Trigger chrome matching DSH's own chips in the input's tool row (ui-model-selection `.trigger`). */
const triggerStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, height: 28, padding: '0 4px 0 8px', border: 'none',
  borderRadius: 'var(--dsw-radius-sm)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit', fontSize: 13, lineHeight: '20px', whiteSpace: 'nowrap', cursor: 'pointer',
}

const MODEL_PREFIX = 'model:'

/**
 * One compact chip in the chat input. Its menu opens the generation card and
 * picks this session's image and video models, so the tool row keeps its
 * single-line layout.
 */
export function InputControl(props: InputControlProps): ReactNode {
  const { t } = props
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [showAll, setShowAll] = useState(false)
  const [card, setCard] = useState(false)
  const [choices, setChoices] = useState<SessionChoices>()
  const [error, setError] = useState<string>()
  const image = useListing('image')
  const video = useListing('video')
  const reload = useCallback((signal?: AbortSignal) => {
    loadSessionChoices(props.sessionId, signal).then(setChoices, () => { /* the menu stays on its last state */ })
  }, [props.sessionId])
  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal)
    return () => { controller.abort() }
  }, [reload])

  const listingOf = (kind: MediaKind) => (kind === 'image' ? image : video).listing
  const chosenOf = (kind: MediaKind) => choices?.[kind]?.model ?? ''
  const nameOf = (kind: MediaKind, id: string) => findModel(listingOf(kind), id)?.name ?? id
  const fallbackLabel = (kind: MediaKind) => {
    const fallback = choices?.defaults[kind]
    return fallback === null || fallback === undefined ? t('noDefault') : t('sessionDefault', { model: nameOf(kind, fallback) })
  }
  const currentLabel = (kind: MediaKind) => (chosenOf(kind) === '' ? fallbackLabel(kind) : nameOf(kind, chosenOf(kind)))

  const close = () => { setOpen(false); setPane('root'); setShowAll(false) }
  const pick = (kind: MediaKind, id: string): void => {
    setError(undefined)
    props.command(`/media-model ${kind} ${id === '' ? 'default' : id}`)
      .then(() => { reload() }, (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); reload() })
  }
  const row = (label: string, value: string) => (
    <span style={{ display: 'flex', gap: 16, justifyContent: 'space-between', minWidth: 0, width: '100%' }}>
      <span>{label}</span>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{value}</span>
    </span>
  )
  const modelItems = (kind: MediaKind): MenuEntry[] => {
    const listing = listingOf(kind)
    if (listing === undefined) return [{ id: 'loading', label: t('loading'), disabled: true }]
    const subset = choices?.chatModels?.[kind]
    const limited = !showAll && subset !== undefined && subset.length > 0
    const entries: MenuEntry[] = offeredOf(listing, limited ? subset : undefined, [chosenOf(kind), choices?.defaults[kind]])
      .map(m => ({ id: MODEL_PREFIX + m.id, label: m.name }))
    // The configured subset keeps the menu short; every listed model stays one step away.
    return limited ? [...entries, { type: 'separator', id: 'more' }, { id: 'all', label: t('allModels') }] : entries
  }
  const items: MenuEntry[] = pane === 'root'
    ? [
        { id: 'compose', label: t('compose') },
        { type: 'separator', id: 'models' },
        { id: 'pane:image', label: row(t('image'), currentLabel('image')) },
        { id: 'pane:video', label: row(t('video'), currentLabel('video')) },
      ]
    : [
        { id: 'back', label: `‹ ${t(pane)}` },
        { type: 'separator', id: 'list' },
        { id: MODEL_PREFIX, label: fallbackLabel(pane) },
        ...modelItems(pane),
      ]
  const select = (id: string): void => {
    if (id === 'compose') {
      close()
      setCard(true)
    } else if (id === 'pane:image' || id === 'pane:video') {
      setPane(id === 'pane:image' ? 'image' : 'video')
    } else if (id === 'back') {
      setPane('root')
      setShowAll(false)
    } else if (id === 'all') {
      setShowAll(true)
    } else if (id.startsWith(MODEL_PREFIX) && pane !== 'root') {
      pick(pane, id.slice(MODEL_PREFIX.length))
      close()
    }
  }

  return (
    <>
      <Menu
        open={open}
        onClose={close}
        items={items}
        selectedId={pane === 'root' ? undefined : MODEL_PREFIX + chosenOf(pane)}
        onSelect={select}
        side="top"
        portal
        anchor={(
          <button type="button" style={triggerStyle} aria-haspopup="menu" aria-expanded={open}
            title={error === undefined ? t('pickerTitle') : t('switchFailed', { message: error })}
            onClick={() => { if (open) close(); else setOpen(true) }}>
            <span>{t('trigger')}</span>
            <IconChevronDownOutlineRegular width={12} height={12} />
          </button>
        )}
      />
      {card ? <ComposeCard {...props} onClose={() => { setCard(false); reload() }} /> : null}
    </>
  )
}
