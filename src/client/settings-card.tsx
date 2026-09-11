/**
 * The `image-gen` card inside Settings -> Plugins -> Plugin configuration: a
 * collapsible card whose header names the plugin and discloses the relay URL,
 * the model id, and the relay key in place.
 *
 * The card is rendered by whatever settings surface owns the
 * `settings.plugin.item` slot it registers into, and it matches that section's
 * card chrome: the header is the disclosure button, staged edits outlive
 * collapsing (so the header marks a card holding unsaved edits), a save
 * collapses the card once the Host confirms it, and a deployment that serves
 * no `image-gen` section shows no trace of the card at all. It renders no
 * chrome of the surrounding section and owns its own controls and copy. Colors
 * come from the shell's `--dsw-alias-*` tokens with static fallbacks, so the
 * card follows the active theme without importing a presentation package.
 *
 * @module recycle-image-gen/client/settings-card
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Translate } from './locales.ts'
import type { FieldView, ImageGenSettingsController, SettingsCardView } from './settings-controller.ts'

/** The notice line under the fields. */
function noticeText(view: SettingsCardView, t: Translate): string {
  const notice = view.notice
  if (notice === undefined) return ''
  if (notice.kind === 'ok') return t('card.saved')
  if (notice.code === 'no-credentials') return t('card.noCredentials')
  return t('card.failed', { detail: notice.detail ?? '' })
}

/**
 * Render the image-gen settings card.
 * @param props.controller - the state behind the card.
 * @param props.t - the locale seat this plugin's dictionary supplies.
 * @returns the card, or nothing while this deployment serves no `image-gen` section.
 */
export function SettingsCard({ controller, t }: {
  controller: ImageGenSettingsController
  t: Translate
}) {
  const view = useSyncExternalStore(controller.subscribe, controller.view)
  const [open, setOpen] = useState(false)
  const saveStarted = useRef(false)
  // Collapse only after Host-confirmed settlement: a rejected write keeps its
  // diagnostics and retained drafts visible for correction.
  useEffect(() => {
    if (view.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!view.dirty && view.notice?.kind !== 'error') setOpen(false)
  }, [view.dirty, view.notice, view.saving])
  // Opening the card re-probes the credentials domain: the Client assembly
  // mounts `remote.credentials` during boot, so the first probe can predate it.
  useEffect(() => {
    if (open) controller.refreshCredentials()
  }, [open, controller])
  // A deployment that does not serve the namespace shows no trace of the card,
  // rather than a disabled card the user cannot act on.
  if (view.status !== 'ready') return null
  const notice = noticeText(view, t)
  return (
    <li style={{ ...styles.card, ...open ? styles.cardOpen : {} }}>
      <button
        type="button"
        style={styles.header}
        aria-expanded={open}
        aria-label={t('card.disclosure', { action: open ? t('card.collapse') : t('card.expand'), title: t('card.title') })}
        onClick={() => { setOpen(!open) }}
      >
        <span style={styles.headText}>
          <span style={styles.name}>{t('card.title')}</span>
          <span style={styles.description}>{t('card.description')}</span>
        </span>
        {view.dirty ? <span style={styles.pending}>{t('card.unsaved')}</span> : null}
        <Chevron open={open} />
      </button>
      {open
        ? (
          <div style={styles.body}>
            {!view.writable ? <p style={styles.readOnly} role="status">{t('card.readOnly')}</p> : null}
            <TextField
              id="recycle-image-gen-base-url"
              label={t('card.url')}
              hint={t('card.urlHint')}
              field={view.baseUrl}
              disabled={!view.writable}
              t={t}
              onEdit={text => { controller.edit('baseUrl', text) }}
              onReset={() => { void controller.reset('baseUrl') }}
            />
            <TextField
              id="recycle-image-gen-model"
              label={t('card.model')}
              hint={t('card.modelHint')}
              field={view.model}
              disabled={!view.writable}
              t={t}
              onEdit={text => { controller.edit('model', text) }}
              onReset={() => { void controller.reset('model') }}
            />
            <div style={styles.row}>
              <label style={styles.label} htmlFor="recycle-image-gen-key">
                {t('card.key')}
                <span style={styles.badge}>{view.keyConfigured ? t('card.keySet') : t('card.keyUnset')}</span>
              </label>
              <input
                id="recycle-image-gen-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                style={{ ...styles.input, ...view.keyWritable ? {} : styles.inputDisabled }}
                value={view.apiKey.text}
                placeholder={t('card.keyHint')}
                disabled={!view.keyWritable}
                onChange={event => { controller.editKey(event.target.value) }}
              />
              <div style={styles.hintRow}>
                <span style={view.keyLock === undefined ? styles.hint : styles.locked}>
                  {view.keyLock === 'env'
                    ? `${t('card.keyEnvLocked')} · ${view.ref}`
                    : view.keyLock === 'unavailable'
                      ? `${t('card.keyUnavailable')} · ${view.ref}`
                      : `${t('card.keyHint')} · ${view.ref}`}
                </span>
              </div>
            </div>
            <div style={styles.footer}>
              {notice === ''
                ? null
                : (
                  <p
                    style={view.notice?.kind === 'error' ? styles.failed : styles.saved}
                    role="status"
                  >
                    {notice}
                  </p>
                )}
              <button
                type="button"
                style={styles.discard}
                disabled={!view.dirty || view.saving}
                onClick={() => { controller.discard() }}
              >
                {t('card.discard')}
              </button>
              <button
                type="button"
                style={styles.save}
                disabled={!view.canSave}
                onClick={() => { void controller.save() }}
              >
                {view.saving ? t('card.saving') : t('card.save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}

/** The disclosure chevron, drawn here because a plugin bundle carries no icon package. */
function Chevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      aria-hidden="true"
      focusable="false"
      style={{ ...styles.chevron, ...open ? styles.chevronOpen : {} }}
    >
      <path
        d="M4 6.5 8 10.5l4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** One staged text field: label, input, hint, and its reset control. */
function TextField({ id, label, hint, field, disabled, t, onEdit, onReset }: {
  id: string
  label: string
  hint: string
  field: FieldView
  disabled: boolean
  t: Translate
  onEdit: (text: string) => void
  onReset: () => void
}): ReactNode {
  return (
    <div style={styles.row}>
      <label style={styles.label} htmlFor={id}>
        {label}
        {field.overridden && <span style={styles.badge}>{t('card.overridden')}</span>}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        style={{ ...styles.input, ...disabled ? styles.inputDisabled : {} }}
        value={field.text}
        placeholder={hint}
        disabled={disabled}
        onChange={event => { onEdit(event.target.value) }}
      />
      <div style={styles.hintRow}>
        <span style={styles.hint}>{hint}</span>
        <button
          type="button"
          style={disabled || !field.overridden ? styles.resetDisabled : styles.reset}
          disabled={disabled || !field.overridden}
          onClick={onReset}
        >
          {t('card.reset')}
        </button>
      </div>
    </div>
  )
}

/** Colors read the shell's theme tokens, with fallbacks for a surface that defines none. */
const styles: Record<string, CSSProperties> = {
  card: {
    listStyle: 'none',
    border: '0.5px solid var(--dsw-alias-border-l4, #d9d9d9)',
    borderRadius: 16,
    background: 'var(--dsw-alias-bg-layer-3, transparent)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    fontFamily: 'var(--dsw-font-family, inherit)',
  },
  cardOpen: {
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    borderColor: 'var(--dsw-alias-label-dimmed, #b0b6bd)',
  },
  header: {
    width: '100%',
    appearance: 'none',
    border: 0,
    background: 'none',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 16px',
    borderRadius: 12,
  },
  headText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  name: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary, inherit)' },
  description: { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, #8a9099)' },
  chevron: { flex: 'none', color: 'var(--dsw-alias-label-tertiary, #8a9099)', transition: 'transform .16s' },
  chevronOpen: { transform: 'rotate(180deg)' },
  pending: {
    flex: 'none',
    padding: '1px 8px',
    borderRadius: 999,
    border: '0.5px solid var(--dsw-alias-border-l2, #d9d9d9)',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-secondary, #5c636b)',
  },
  body: {
    borderTop: '0.5px solid var(--dsw-alias-border-l2, #d9d9d9)',
    margin: '0 16px',
    paddingBottom: 8,
    display: 'flex',
    flexDirection: 'column',
  },
  readOnly: {
    margin: '12px 0 0',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-tertiary, #8a9099)',
  },
  row: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 },
  label: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 },
  badge: {
    padding: '0 6px',
    borderRadius: 8,
    border: '0.5px solid var(--dsw-alias-border-l2, #d9d9d9)',
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary, #8a9099)',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
    background: 'var(--dsw-alias-bg-base, transparent)',
    color: 'inherit',
    font: 'inherit',
    fontSize: 13,
  },
  inputDisabled: { opacity: 0.6, cursor: 'not-allowed' },
  hintRow: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' },
  hint: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, #8a9099)' },
  locked: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-warn-label, #b26a00)' },
  reset: {
    appearance: 'none',
    border: 'none',
    background: 'none',
    padding: 0,
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-link, #1677ff)',
    cursor: 'pointer',
  },
  resetDisabled: {
    appearance: 'none',
    border: 'none',
    background: 'none',
    padding: 0,
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-tertiary, #8a9099)',
    cursor: 'default',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '12px 0 4px',
    marginTop: 12,
    borderTop: '0.5px solid var(--dsw-alias-border-l2, #d9d9d9)',
  },
  failed: {
    flex: 1,
    minWidth: 0,
    margin: 0,
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-error, #d4380d)',
  },
  saved: {
    flex: 1,
    minWidth: 0,
    margin: 0,
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-state-success-primary, #1a7f37)',
  },
  discard: {
    appearance: 'none',
    border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
    borderRadius: 8,
    padding: '5px 14px',
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1.5,
    background: 'none',
    color: 'var(--dsw-alias-label-secondary, #5c636b)',
    cursor: 'pointer',
  },
  save: {
    appearance: 'none',
    border: '1px solid transparent',
    borderRadius: 8,
    padding: '5px 14px',
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1.5,
    background: 'var(--dsw-alias-label-primary, #1f2329)',
    color: 'var(--dsw-alias-bg-layer-3, #fff)',
    cursor: 'pointer',
  },
}
