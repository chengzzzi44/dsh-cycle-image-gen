/**
 * Browser half of the dual-face plugin: the keyed `tool.call.toolview` card for
 * `generate_image`.
 *
 * The card derives everything from the settled wire call — the result's own
 * `image` content blocks carry the durable references, and the session-supplied
 * `loadImage` turns one reference into a session-authorized URL. Declaring the
 * `tool.call.images` child slot is deliberately avoided: it is a `single` slot
 * already declared by the shipped `read_image` view, and a second declarer
 * throws at load. Loading the URL directly through the owner-supplied loader
 * keeps this card additive.
 *
 * Claiming the keyed view suppresses the generic row for every `generate_image`
 * result, so this component covers all of the tool's shapes: running, failed,
 * settled with images, and settled without any.
 *
 * The same half registers the `image-gen` card into the Plugins settings
 * section, so the relay endpoint, the model, and the key can be set from the
 * Web interface instead of `cordis.patch.yml`.
 *
 * @module recycle-image-gen/client
 */

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { GeneratedTail } from './GeneratedTail.tsx'
import { ImagePreview } from './ImagePreview.tsx'
import { SettingsCard } from './settings-card.tsx'
import { NS, en, zh, type Translate } from './locales.ts'
import {
  IMAGE_TAB_ID, imageTabDefinition, loadWorkspaceImage, parseFileAddress, type WorkspaceFilesRemoteLike,
} from './image-tab.ts'
import {
  IMAGE_GEN_SETTINGS_NAMESPACE, ImageGenSettingsController,
  type CredentialsRemoteLike, type RemoteEventsLike, type SettingsScopeLike,
} from './settings-controller.ts'
import { generatedTailDefinition, selectGeneratedTail, type GeneratedTailImage } from './turn-images.ts'

/** Wire tool name the keyed view claims; must match the node half's `TOOL_NAME`. */
const TOOL_NAME = 'generate_image'

/** Durable image reference as it arrives inside a result's `image` block. */
interface AttachmentReference {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** One wire content block, narrowed field by field. */
interface ContentBlockLike {
  type?: unknown
  text?: unknown
  attachment?: unknown
}

/** Settled tool result as the conversation store exposes it. */
interface ToolResultBlockLike {
  kind: string
  isError?: boolean
  content?: readonly ContentBlockLike[]
  meta?: unknown
  call?: { name?: string; argsRaw?: string } | null
}

/** Session-authorized durable image URL loader, with an optional synchronous cache read. */
type LoadImage = ((attachment: AttachmentReference) => Promise<string>) & {
  peek?: (attachment: AttachmentReference) => string | undefined
}

/** The owner props this card consumes from the atomic Tool view share. */
interface ToolViewProps {
  block: unknown
  loadImage?: LoadImage
  openFile?: (path: string) => void
  /** The locale seat this plugin's dictionary supplies. */
  t: Translate
}

/** Client slot registry surface used by this plugin. */
interface SlotsLike {
  inject(name: string, callback: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): unknown
}

/**
 * Structural view of the optional Conversation service. Every member is
 * optional: another dsh version may expose only some of this surface, and the
 * plugin decides what it can do from what is actually present.
 */
interface ConversationServiceLike {
  events?: { register?(definition: unknown): unknown }
  imageUrl?(sessionId: string, attachment: GeneratedTailImage): Promise<string>
  peekImageUrl?(sessionId: string, attachment: GeneratedTailImage): string | undefined
}

/** Client context surface used by this plugin. */
interface ClientContextLike {
  slots: SlotsLike
  /** Register one cleanup on this context's fiber. */
  effect(callback: () => () => void, label: string): unknown
  /** Strict service read; optional surfaces are read through scoped injections instead. */
  get(name: string): unknown
  /** Optional: the loader's scoped injection, absent on a context this plugin does not own. */
  inject?(names: readonly string[], callback: (ctx: ClientContextLike) => void): unknown
}

/** Structural view of the locale service this plugin registers its dictionaries with. */
interface LocaleLike {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
}

/** Structural view of the right-Sidebar tab registry. */
interface SidebarRightTabsLike {
  register(definition: unknown): () => void
}

/** Structural view of the service a settings card binds its namespace through. */
interface ScopeBinderLike {
  bind(spec: { namespace: string }): SettingsScopeLike
}

/** Whether the block carries a settled result rather than an in-flight call. */
function isSettled(block: unknown): block is ToolResultBlockLike {
  return typeof block === 'object' && block !== null && 'kind' in block
}

/** Narrow one wire attachment reference, declining on anything malformed. */
function attachmentReference(value: unknown): AttachmentReference | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  const { attachmentId, mediaType, bytes, width, height, name } = candidate
  if (typeof attachmentId !== 'string' || attachmentId === '') return null
  if (typeof mediaType !== 'string' || mediaType === '') return null
  if (typeof bytes !== 'number' || typeof width !== 'number' || typeof height !== 'number') return null
  return {
    attachmentId,
    mediaType,
    bytes,
    width,
    height,
    ...typeof name === 'string' ? { name } : {},
  }
}

/** Every durable image reference the result carries, in result order. */
function imageReferences(content: unknown): AttachmentReference[] {
  if (!Array.isArray(content)) return []
  const references: AttachmentReference[] = []
  for (const block of content as ContentBlockLike[]) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type !== 'image') continue
    const reference = attachmentReference(block.attachment)
    if (reference !== null) references.push(reference)
  }
  return references
}

/** Join the result's text blocks, which carry the failure explanation on error. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as ContentBlockLike[]) {
    if (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** Absolute copy paths persisted in the result metadata. */
function metaFiles(meta: unknown): string[] {
  if (typeof meta !== 'object' || meta === null) return []
  const files = (meta as { files?: unknown }).files
  if (!Array.isArray(files)) return []
  return files.filter((file): file is string => typeof file === 'string')
}

/** Reference-image path persisted in the result metadata for an edit. */
function metaSource(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const source = (meta as { source?: unknown }).source
  return typeof source === 'string' && source.length > 0 ? source : undefined
}

/** Parse the call's raw arguments without letting malformed wire JSON throw. */
function callArguments(block: unknown): { prompt?: string; model?: string } {
  const raw = isSettled(block)
    ? block.call?.argsRaw
    : typeof block === 'object' && block !== null
      ? (block as { argsRaw?: unknown }).argsRaw
      : undefined
  if (typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const { prompt } = parsed as { prompt?: unknown }
    return typeof prompt === 'string' ? { prompt } : {}
  } catch {
    // Malformed or truncated wire JSON is display-only input; the card simply
    // omits the prompt rather than failing the render.
    return {}
  }
}

/** One generated image: resolves its URL through the session loader and renders it. */
function GeneratedImage({ reference, loadImage, path, onOpen, t }: {
  reference: AttachmentReference
  loadImage?: LoadImage
  path?: string
  onOpen?: (path: string) => void
  t: Translate
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    const cached = loadImage?.peek?.(reference)
    if (cached !== undefined) {
      setUrl(cached)
      setFailed(false)
      return () => { cancelled = true }
    }
    if (loadImage === undefined) {
      setFailed(true)
      return () => { cancelled = true }
    }
    setUrl(null)
    setFailed(false)
    loadImage(reference).then(
      (next) => { if (!cancelled) setUrl(next) },
      () => { if (!cancelled) setFailed(true) },
    )
    return () => { cancelled = true }
    // The reference object is rebuilt from wire content on every render, so the
    // effect keys on the stable attachment identity instead.
  }, [reference.attachmentId, loadImage])

  if (failed) return <div style={STYLES.imageFallback}>{t('image.unavailable', { mediaType: reference.mediaType })}</div>
  if (url === null) return <div style={STYLES.imageFallback}>{t('image.loading')}</div>
  return (
    <img
      src={url}
      alt={reference.name ?? t('image.alt')}
      style={{ ...STYLES.image, ...path === undefined || onOpen === undefined ? {} : STYLES.imageClickable }}
      onClick={path === undefined || onOpen === undefined ? undefined : () => onOpen(path)}
    />
  )
}

/** The settled or in-flight card body for one `generate_image` call. */
function GeneratedImageCard(props: ToolViewProps) {
  const { block, loadImage, openFile, t } = props
  const settled = isSettled(block)
  const references = useMemo(() => imageReferences(settled ? block.content : undefined), [block, settled])
  const files = useMemo(() => metaFiles(settled ? block.meta : undefined), [block, settled])
  const source = useMemo(() => metaSource(settled ? block.meta : undefined), [block, settled])
  const args = useMemo(() => callArguments(block), [block])
  const isError = settled && block.isError === true
  const failure = useMemo(() => (isError ? resultText(block.content) : ''), [block, isError])

  return (
    <div style={STYLES.shell}>
      <div style={STYLES.head}>
        <span style={STYLES.title}>{source === undefined ? t('tool.generate') : t('tool.edit')}</span>
        {args.prompt !== undefined && <span style={STYLES.prompt}>{args.prompt}</span>}
      </div>
      {source !== undefined && <div style={STYLES.source}>{t('tool.from', { source })}</div>}
      {isError ? (
        <div style={STYLES.error}>{failure.length > 0 ? failure : t('tool.failed')}</div>
      ) : !settled ? (
        <div style={STYLES.note}>{t('tool.generating')}</div>
      ) : references.length === 0 ? (
        <div style={STYLES.note}>{t('tool.empty')}</div>
      ) : (
        <div style={STYLES.gallery}>
          {references.map((reference, index) => {
            const file = files[index]
            return (
              <div key={reference.attachmentId} style={STYLES.figure}>
                <GeneratedImage
                  reference={reference}
                  t={t}
                  {...loadImage === undefined ? {} : { loadImage }}
                  {...file === undefined ? {} : { path: file }}
                  {...openFile === undefined ? {} : { onOpen: openFile }}
                />
                <div style={STYLES.caption}>
                  {reference.width}x{reference.height} · {reference.mediaType}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Inline styles only: the plugin ships no stylesheet and owns no CSS pipeline. */
const STYLES = {
  shell: { display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 },
  title: { fontSize: 13, fontWeight: 600, opacity: 0.9 },
  prompt: { fontSize: 12, opacity: 0.65, overflowWrap: 'anywhere' },
  source: { fontSize: 11, opacity: 0.55, overflowWrap: 'anywhere' },
  note: { fontSize: 12, opacity: 0.6 },
  error: { fontSize: 12, color: 'var(--dsw-color-danger, #d4380d)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  gallery: { display: 'flex', flexWrap: 'wrap', gap: 12 },
  figure: { display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 360 },
  image: {
    display: 'block',
    maxWidth: '100%',
    maxHeight: 360,
    borderRadius: 8,
    border: '1px solid rgba(128, 128, 128, 0.25)',
  },
  imageClickable: { cursor: 'zoom-in' },
  imageFallback: { fontSize: 12, opacity: 0.6, padding: '12px 0' },
  caption: { fontSize: 11, opacity: 0.55 },
} satisfies Record<string, CSSProperties>

/** Client plugin name used by loader diagnostics. */
export const name = 'recycle-image-gen-client'

/** The services this presentation plugin requires. */
export const inject = ['slots', 'locale']

/**
 * Register the browser half: this plugin's dictionaries, the keyed Tool view
 * that renders one `generate_image` call, the turn-tail row, the `image-gen`
 * settings card, and the right-Sidebar image tab an opened copy lands in.
 *
 * Each optional surface is reached through a scoped injection, so a dsh that
 * lacks that service keeps everything else this plugin registers; the tool card
 * itself needs only the slot registry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContextLike): void {
  const locale = ctx.get('locale') as LocaleLike | undefined
  if (locale === undefined) {
    // `locale` is a declared injection, so a context without it means the
    // composition is malformed: fail loud rather than render dictionary keys.
    throw new Error('recycle-image-gen: the client context has no locale service to register dictionaries with')
  }
  ctx.effect(() => locale.register(NS, { zh, en }), 'recycle-image-gen: dictionaries')
  registerTurnTail(ctx)
  registerSettingsCard(ctx)
  registerImageTab(ctx)
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: TOOL_NAME,
    locale: NS,
  }, GeneratedImageCard))
}

/**
 * Register the right-Sidebar tab type that displays a workspace image.
 *
 * The tab registry and the workspace-files Remote are reached through a scoped
 * injection, so a dsh without them keeps everything else this plugin registers;
 * opening an image copy then falls back to the shipped text preview, which
 * refuses it.
 * @param ctx - registrant context.
 */
function registerImageTab(ctx: ClientContextLike): void {
  const inject = ctx.inject
  if (typeof inject !== 'function') return
  inject.call(ctx, ['sidebarRightTabs', 'remote.workspaceFiles'], (tabCtx: ClientContextLike) => {
    const tabs = tabCtx.get('sidebarRightTabs') as SidebarRightTabsLike | undefined
    const remote = tabCtx.get('remote.workspaceFiles') as WorkspaceFilesRemoteLike | undefined
    if (tabs === undefined || typeof tabs.register !== 'function' || remote === undefined) return
    try {
      tabCtx.effect(() => tabs.register(imageTabDefinition()), 'recycle-image-gen: image tab type')
      tabCtx.slots.inject('sidebar.right.pane.tab', () => tabCtx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: IMAGE_TAB_ID,
        locale: NS,
        inject: () => ({
          load: async (address: string, sessionId: string, signal: AbortSignal) => {
            const parsed = parseFileAddress(address)
            if (parsed === undefined) throw new Error(`recycle-image-gen: not a file address "${address}"`)
            return loadWorkspaceImage(remote, parsed.sessionId ?? sessionId, parsed.path, signal)
          },
        }),
      }, ImagePreview))
    } catch (error: unknown) {
      // A sidebar surface this plugin does not recognize must cost the tab,
      // never the tool card registered by the same apply.
      console.warn('recycle-image-gen: the image tab could not be registered, so image copies open in the text preview instead', error)
    }
  })
}

/**
 * Register the `image-gen` card into the Plugins settings section.
 *
 * The settings scope is reached through a scoped injection rather than a
 * declared one, so a dsh without the settings surface loses this card and
 * nothing else the plugin registers. The card registers on that scoped context,
 * so a settings-scope reload replaces the card instead of colliding with the
 * one the outer context would still own.
 * @param ctx - registrant context.
 */
function registerSettingsCard(ctx: ClientContextLike): void {
  const inject = ctx.inject
  if (typeof inject !== 'function') return
  inject.call(ctx, ['settingsScope'], (settingsCtx: ClientContextLike) => {
    const binder = settingsCtx.get('settingsScope') as ScopeBinderLike | undefined
    if (binder === undefined || typeof binder.bind !== 'function') return
    // The credentials namespace is its own service (`remote.credentials`); the
    // `remote` service itself carries only the Host-event and host-facts faces.
    // Both are read optionally, and the namespace is re-read per call because
    // the Client assembly mounts it during boot, possibly after this plugin.
    const remote = settingsCtx.get('remote') as RemoteEventsLike | undefined
    const controller = new ImageGenSettingsController(
      binder.bind({ namespace: IMAGE_GEN_SETTINGS_NAMESPACE }),
      () => settingsCtx.get('remote.credentials') as CredentialsRemoteLike | undefined,
      credentialWatch(remote),
    )
    settingsCtx.effect(() => () => { controller.dispose() }, 'recycle-image-gen: settings controller')
    settingsCtx.slots.inject('settings.plugin.item', () => settingsCtx.slots.register({
      name: 'settings.plugin.item',
      key: IMAGE_GEN_SETTINGS_NAMESPACE,
      locale: NS,
      inject: () => ({ controller }),
    }, SettingsCard))
  })
}

/**
 * Bind the `remote` service's Host-event subscription to the credential
 * invalidation the settings card watches.
 * @param remote - the remote service, absent on a dsh that serves no settings transport.
 * @returns a subscriber taking only the listener, or undefined when the service is absent.
 */
function credentialWatch(
  remote: RemoteEventsLike | undefined,
): ((listener: (ref: string) => void) => unknown) | undefined {
  const on = remote?.$on
  if (typeof on !== 'function') return undefined
  return listener => on.call(remote, 'credentials/reference-updated', listener)
}

/**
 * Register the turn-tail row once the Conversation service it renders through
 * is mounted. Waiting on the service rather than reading it at apply time means
 * a composition that mounts `uiConversation` later still gets the row, and one
 * that never mounts it costs only the row.
 * @param ctx - registrant context.
 */
function registerTurnTail(ctx: ClientContextLike): void {
  const inject = ctx.inject
  if (typeof inject !== 'function') return
  inject.call(ctx, ['uiConversation'], (conversationCtx: ClientContextLike) => {
    const conversation = conversationCtx.get('uiConversation') as ConversationServiceLike | null | undefined
    const events = conversation?.events
    const registerEvent = events?.register
    const imageUrl = conversation?.imageUrl
    const peekImageUrl = conversation?.peekImageUrl
    if (conversation === null || conversation === undefined
      || events === undefined || typeof registerEvent !== 'function'
      || typeof imageUrl !== 'function' || typeof peekImageUrl !== 'function') {
      console.warn(
        'recycle-image-gen: the mounted uiConversation service does not expose the turn-tail surface this row needs'
        + ' (events.register / imageUrl / peekImageUrl), so generated images render in the tool card only',
      )
      return
    }
    try {
      // The members are captured and called through their owner so a partial
      // surface on another dsh version degrades to the tool card instead of
      // throwing here.
      registerEvent.call(events, generatedTailDefinition)

      // The turn tail is a chain: only the first selector that accepts the
      // closing turn renders, so an entry registered earlier (the produced-files
      // row) claims its turns before this selector is consulted.
      conversationCtx.slots.inject('conversation.chat.turnTail', () => conversationCtx.slots.register({
        name: 'conversation.chat.turnTail',
        select: selectGeneratedTail,
        locale: NS,
        // A strict session slot hands its inject factory the resolved sessionId,
        // so the loader pair is bound here rather than threaded through.
        inject: (sessionId: string) => ({
          imageUrl: (attachment: GeneratedTailImage) => imageUrl.call(conversation, sessionId, attachment),
          peekImageUrl: (attachment: GeneratedTailImage) => peekImageUrl.call(conversation, sessionId, attachment),
        }),
      }, GeneratedTail))
    } catch (error: unknown) {
      // A conversation surface this plugin does not recognize must cost the row,
      // never the tool card registered by the same apply.
      console.warn('recycle-image-gen: the turn-tail surface on this dsh rejected the registration, so generated images render in the tool card only', error)
    }
  })
}
