/**
 * The turn-tail row for generated images: thumbnails under the closing
 * assistant message, outside the Turn's process disclosure.
 *
 * URL resolution goes through the injected `imageUrl`/`peekImageUrl` pair,
 * which the plugin binds to the `uiConversation` service for the session the
 * slot was registered in. That is the same session-authorized loader the chat
 * view hands its message and tool galleries, so this row needs no transport
 * knowledge of its own and no change to any shipped package.
 *
 * @module dsh-cycle-image-gen/client/GeneratedTail
 */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Translate } from './locales.ts'
import type { GeneratedTailEntry, GeneratedTailImage } from './turn-images.ts'

/** Callbacks the plugin's inject face binds for one session. */
export interface GeneratedTailInjected {
  /** Resolve one session-authorized URL for a durable image reference. */
  imageUrl: (attachment: GeneratedTailImage) => Promise<string>
  /** Read a cached URL synchronously when one is already known. */
  peekImageUrl: (attachment: GeneratedTailImage) => string | undefined
}

/** Full props the turn-tail chain composes for this row. */
export interface GeneratedTailProps extends GeneratedTailInjected {
  /** The selector's claim: every image this closing turn generated. */
  matched: readonly GeneratedTailEntry[]
  /** The chat view's file opener, routed to the right Sidebar. */
  openFile: (path: string) => void
  /** The locale seat this plugin's dictionary supplies. */
  t: Translate
}

/** One thumbnail that resolves its own URL and degrades to a label. */
function GeneratedThumbnail({ entry, imageUrl, peekImageUrl, t, onOpen }: {
  entry: GeneratedTailEntry
  imageUrl: GeneratedTailInjected['imageUrl']
  peekImageUrl: GeneratedTailInjected['peekImageUrl']
  t: Translate
  onOpen?: () => void
}) {
  const { attachment } = entry
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    const cached = peekImageUrl(attachment)
    if (cached !== undefined) {
      setUrl(cached)
      setFailed(false)
      return () => { cancelled = true }
    }
    setUrl(null)
    setFailed(false)
    imageUrl(attachment).then(
      (next) => { if (!cancelled) setUrl(next) },
      () => { if (!cancelled) setFailed(true) },
    )
    return () => { cancelled = true }
    // The entry object is rebuilt from turn data on every fold, so the effect
    // keys on the stable attachment identity instead.
  }, [attachment.attachmentId, imageUrl, peekImageUrl])

  if (failed) {
    return <span style={STYLES.fallback}>{t('image.unavailable', { mediaType: attachment.mediaType })}</span>
  }
  if (url === null) return <span style={STYLES.fallback}>{t('image.loading')}</span>
  return (
    <button
      type="button"
      style={{ ...STYLES.thumbButton, ...onOpen === undefined ? {} : STYLES.thumbClickable }}
      title={entry.path ?? t('image.alt')}
      aria-label={entry.path === undefined ? t('image.alt') : t('tail.open', { path: entry.path })}
      onClick={onOpen}
      disabled={onOpen === undefined}
    >
      <img src={url} alt={attachment.name ?? t('image.alt')} style={STYLES.thumb} />
    </button>
  )
}

/**
 * Render one closing turn's generated images as a thumbnail row.
 * @param props - the selector's matched entries, the injected loader pair, the file opener, and the locale seat.
 * @returns the turn-tail row.
 */
export function GeneratedTail({ matched, imageUrl, peekImageUrl, openFile, t }: GeneratedTailProps) {
  // A defensive shape check rather than a contract: this row is optional
  // decoration, so an unresolved inject face renders nothing instead of
  // throwing inside the transcript.
  if (typeof imageUrl !== 'function' || typeof peekImageUrl !== 'function') return null
  if (!Array.isArray(matched) || matched.length === 0) return null
  return (
    <div style={STYLES.root} data-generated-images-row={matched.length}>
      <span style={STYLES.label}>
        {matched.length === 1 ? t('tail.single') : t('tail.many', { count: matched.length })}
      </span>
      <div style={STYLES.lane}>
        {matched.map((entry, index) => (
          <GeneratedThumbnail
            key={`${entry.attachment.attachmentId}:${String(index)}`}
            entry={entry}
            imageUrl={imageUrl}
            peekImageUrl={peekImageUrl}
            t={t}
            {...entry.path === undefined ? {} : { onOpen: () => { openFile(entry.path as string) } }}
          />
        ))}
      </div>
    </div>
  )
}

/** Inline styles only: the plugin ships no stylesheet and owns no CSS pipeline. */
const STYLES = {
  root: { display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' },
  label: { fontSize: 12, opacity: 0.6 },
  lane: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' },
  thumbButton: {
    padding: 0,
    border: '1px solid rgba(128, 128, 128, 0.25)',
    borderRadius: 8,
    background: 'transparent',
    overflow: 'hidden',
    lineHeight: 0,
  },
  thumbClickable: { cursor: 'zoom-in' },
  thumb: { display: 'block', height: 120, width: 'auto', maxWidth: 240, objectFit: 'cover' },
  fallback: { fontSize: 12, opacity: 0.55 },
} satisfies Record<string, CSSProperties>
