/**
 * The image tab's body: one workspace image, or the reason it is not showing.
 *
 * The image is read through the type's injected loader and held as an object URL
 * for the tab's lifetime, so the pane shows the exact bytes on disk rather than
 * a re-encode. The address is the tab's whole identity: it names the session
 * whose workspace is read and the image inside it.
 *
 * @module recycle-image-gen/client/ImagePreview
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Translate } from './locales.ts'

/** The tab information hook the Sidebar supplies to one tab body. */
export type UseTabInfoLike = () => {
  tab: {
    /** The resource address this tab displays. */
    address: string
    /** The tab record's lifetime. */
    signal: AbortSignal
  }
}

/** The type's injected loader, as the body receives it. */
export interface ImagePreviewInjected {
  /**
   * Read one addressed image completely.
   * @param address - the tab's resource address.
   * @param sessionId - the seat's session, which an absolute address is read through.
   * @param signal - the tab record's lifetime.
   * @returns the exact bytes and their media type.
   */
  load(address: string, sessionId: string, signal: AbortSignal): Promise<{ data: Uint8Array, mediaType: string }>
}

/** The body's composed props: the tab, the injected loader, and copy. */
export interface ImagePreviewProps extends ImagePreviewInjected {
  useTabInfo: UseTabInfoLike
  sessionId: string
  t: Translate
}

/** Copy one view into an `ArrayBuffer`-backed part the Blob constructor accepts. */
function blobPart(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength)
  new Uint8Array(copy).set(data)
  return copy
}

/**
 * Render one addressed image.
 * @param props - the tab information, the injected loader, and copy.
 * @returns the image, a progress line, or the failure line.
 */
export function ImagePreview({ useTabInfo, sessionId, load, t }: ImagePreviewProps): ReactNode {
  const { tab } = useTabInfo()
  const address = tab.address
  // The tab object is rebuilt on every render, so the effect keys on the address
  // and session alone and reads the loader and the record signal through a ref:
  // depending on either identity would re-read on every render.
  const latest = useRef({ load, signal: tab.signal })
  latest.current = { load, signal: tab.signal }
  const [url, setUrl] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | undefined
    setUrl(null)
    setFailure(null)
    const { load: read, signal } = latest.current
    read(address, sessionId, signal).then(
      ({ data, mediaType }) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(new Blob([blobPart(data)], { type: mediaType }))
        setUrl(objectUrl)
      },
      (error: unknown) => {
        if (cancelled) return
        const detail = error instanceof Error ? error.message : String(error)
        console.warn('recycle-image-gen: the image tab could not read', address, error)
        setFailure(detail)
      },
    )
    return () => {
      cancelled = true
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [address, sessionId])

  if (failure !== null) {
    return (
      <div style={STYLES.note}>
        <div>{t('imageTab.failed')}</div>
        <div style={STYLES.detail}>{failure}</div>
      </div>
    )
  }
  if (url === null) return <div style={STYLES.note}>{t('image.loading')}</div>
  return (
    <div style={STYLES.root}>
      <img src={url} alt={t('image.alt')} style={STYLES.image} />
    </div>
  )
}

/** Inline styles only: the plugin ships no stylesheet and owns no CSS pipeline. */
const STYLES = {
  root: { display: 'flex', justifyContent: 'center', padding: 12 },
  image: {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    borderRadius: 8,
    border: '1px solid rgba(128, 128, 128, 0.25)',
  },
  note: { padding: 12, fontSize: 12, opacity: 0.65 },
  detail: { paddingTop: 4, fontSize: 11, opacity: 0.6, wordBreak: 'break-all' },
} satisfies Record<string, CSSProperties>
