/**
 * State behind the `image-gen` settings card: the relay URL and model staged
 * over this plugin's settings section, and the relay key, which is the one
 * control that does not live in the section.
 *
 * The key's literal never rides a response. The card learns only whether one
 * is configured, reads that through the credentials domain addressed by the
 * reference the section names, and writes it back the same way. Every service
 * arrives structurally through `ctx.get` and every entry point is guarded, so
 * a dsh without the settings surface costs this card and nothing else the
 * plugin registers.
 *
 * @module dsh-cycle-image-gen/client/settings-controller
 */

/** Settings namespace the host half registers; the card claims this slot key. */
export const IMAGE_GEN_SETTINGS_NAMESPACE = 'image-gen'

/** Credential reference addressed when the section names none. */
const DEFAULT_API_KEY_REF = 'GPT_IMAGE_API_KEY'

/** The section fields this card stages. */
export const SETTINGS_FIELDS = ['baseUrl', 'model'] as const

/** One section field this card stages. */
export type SettingsField = (typeof SETTINGS_FIELDS)[number]

/** One path-addressed settings edit, as the bound scope accepts it. */
interface SettingsOp {
  op: 'set' | 'unset'
  path: string[]
  value?: string
}

/** The bound namespace's snapshot; every member is optional because a deployment may serve a partial section. */
interface ScopeSnapshotLike {
  status?: string
  value?: { baseUrl?: unknown; model?: unknown; apiKeyEnv?: unknown }
  user?: Record<string, unknown> | undefined
  revision?: number | undefined
  writable?: boolean
}

/** The bound namespace's read and write face. */
export interface SettingsScopeLike {
  getSnapshot(): ScopeSnapshotLike
  subscribe(listener: () => void): () => void
  mutate(ops: readonly SettingsOp[], expectedRevision?: number): Promise<void>
  unset(field: string): Promise<void>
}

/** Answer of one `credentials.describe` call. */
interface CredentialsDescribeLike {
  ok?: boolean
  value?: Record<string, { configured?: boolean; source?: string; writable?: boolean } | undefined>
}

/** The credentials Remote namespace this card reads and writes the key through. */
export interface CredentialsRemoteLike {
  describe(refs: readonly string[]): Promise<CredentialsDescribeLike>
  set(ref: string, value: string): Promise<unknown>
}

/** The `remote` service face this card uses: only its Host-event subscription. */
export interface RemoteEventsLike {
  $on?(event: string, listener: (ref: string) => void): unknown
}

/** Why the key control cannot be written from the card. */
export type KeyLock = 'env' | 'unavailable'

/** Why a save failed, in terms the card maps to localized copy. */
export type SettingsFailure = 'no-credentials' | 'failed'

/** What the card reports after a save attempt. */
export type SettingsNotice =
  | { kind: 'ok' }
  | { kind: 'error'; code: SettingsFailure; detail?: string }

/** One staged field as the card renders it. */
export interface FieldView {
  /** What the input shows: the staged draft, otherwise the resolved value. */
  text: string
  /** Whether the user layer overrides the resolved value, so a reset returns to the composition base. */
  overridden: boolean
}

/** Every fact the card renders. */
export interface SettingsCardView {
  /** `loading` before the first accepted section, `unavailable` when this deployment serves none. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Whether the settings document accepts writes. */
  writable: boolean
  /** Relay endpoint field. */
  baseUrl: FieldView
  /** Model field. */
  model: FieldView
  /** The staged key, which starts blank on every load. */
  apiKey: FieldView
  /** Whether the Host reports a credential configured for {@link ref}. */
  keyConfigured: boolean
  /** Whether the credentials domain accepts a write; false disables the key control. */
  keyWritable: boolean
  /** Why the key control is closed, absent while it accepts a write. */
  keyLock?: KeyLock
  /** Credential reference the key is read from and written to. */
  ref: string
  /** Whether anything staged differs from what the section holds. */
  dirty: boolean
  /** Whether a save would write anything at all. */
  canSave: boolean
  /** Whether a save is in flight. */
  saving: boolean
  /** Outcome of the last save or reset, absent while none happened. */
  notice?: SettingsNotice
}

/** Minimal snapshot store: React's `useSyncExternalStore` needs a stable snapshot reference. */
class SnapshotStore<T> {
  private readonly listeners = new Set<() => void>()
  /** @param value - the first snapshot. */
  constructor(private value: T) {}
  /** @returns the current snapshot. */
  readonly get = (): T => this.value
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each replacement.
   * @returns the disposer removing this listener.
   */
  readonly subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  /**
   * Replace the snapshot and notify every listener.
   * @param value - the new snapshot.
   */
  set(value: T): void {
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }
}

/** Read one section value as the text a field shows. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Read one failure as the detail a notice carries. */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Raised when this dsh serves no credentials domain, so the card can name that instead of reporting a bare failure. */
class MissingCredentialsError extends Error {
  constructor() {
    super('dsh-cycle-image-gen: this dsh serves no credentials domain')
    this.name = 'MissingCredentialsError'
  }
}

/**
 * Bridge the bound `image-gen` scope and the credentials domain onto the card.
 *
 * The section's own fields are staged and written in one mutation fenced by the
 * revision the draft began at, so a form that drifted from the document is
 * refused instead of overwriting a concurrent change. The key is staged with
 * them but written through the credentials domain, which is a separate store
 * with its own refusal.
 */
export class ImageGenSettingsController {
  private readonly store: SnapshotStore<SettingsCardView>
  private draft: Partial<Record<SettingsField, string>> = {}
  private keyDraft = ''
  /** Revision the current draft began at; `undefined` stages nothing. */
  private fence: number | undefined
  private saving = false
  private notice: SettingsNotice | undefined
  private credential: { configured: boolean; writable: boolean; lock?: KeyLock }
    = { configured: false, writable: false, lock: 'unavailable' }
  private readonly offScope: () => void
  private readonly offCredentials: (() => void) | undefined

  /**
   * @param scope - the bound settings scope for the `image-gen` namespace.
   * @param resolveCredentials - reads the credentials Remote namespace at call
   * time: the Client assembly mounts `remote.credentials` as its own service,
   * and it can appear after this plugin starts.
   * @param onCredentialsUpdated - subscribes to the Host's credential invalidations.
   */
  constructor(
    private readonly scope: SettingsScopeLike,
    private readonly resolveCredentials: () => CredentialsRemoteLike | undefined,
    onCredentialsUpdated?: (listener: (ref: string) => void) => unknown,
  ) {
    this.store = new SnapshotStore(this.projection())
    this.offScope = scope.subscribe(() => { this.publish() })
    const off = onCredentialsUpdated?.((ref) => {
      // A key can be written from another surface; the section does not change
      // when it is, so without this the badge keeps reporting a replaced state.
      if (ref === this.ref()) void this.readCredential()
    })
    this.offCredentials = typeof off === 'function' ? off as () => void : undefined
    void this.readCredential()
  }

  /** Re-probe the credentials domain; the card calls this whenever it opens. */
  refreshCredentials(): void {
    void this.readCredential()
  }

  /** @returns the current snapshot. */
  readonly view = (): SettingsCardView => this.store.get()

  /**
   * Observe snapshot replacements, for the renderer's `useSyncExternalStore`.
   * @param listener - invoked after each replacement.
   * @returns the disposer removing this listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** @returns the disposer observing the namespace, the credentials domain, and the mirror. */
  dispose(): void {
    this.offScope()
    this.offCredentials?.()
  }

  /**
   * Stage one section field.
   * @param field - field being edited.
   * @param text - the value on screen.
   */
  edit(field: SettingsField, text: string): void {
    // The fence is taken at the first edit, so a save carries the revision this
    // draft was composed against rather than whatever arrived meanwhile.
    this.fence ??= this.scope.getSnapshot().revision
    this.draft[field] = text
    this.notice = undefined
    this.publish()
  }

  /**
   * Stage the relay key.
   * @param text - the value on screen, which starts blank and never leaves the page unencrypted.
   */
  editKey(text: string): void {
    this.keyDraft = text
    this.notice = undefined
    this.publish()
  }

  /** Drop every staged value. */
  discard(): void {
    this.draft = {}
    this.keyDraft = ''
    this.fence = undefined
    this.notice = undefined
    this.publish()
  }

  /**
   * Clear one field's override so it re-inherits the composition base.
   * @param field - field to reset.
   */
  async reset(field: SettingsField): Promise<void> {
    if (this.scope.getSnapshot().writable !== true) return
    try {
      await this.scope.unset(field)
      delete this.draft[field]
      this.notice = undefined
    } catch (error: unknown) {
      this.notice = { kind: 'error', code: 'failed', detail: detailOf(error) }
    }
    this.publish()
  }

  /** Write every staged value: the section fields in one mutation, then the key. */
  async save(): Promise<void> {
    if (this.saving) return
    const snapshot = this.scope.getSnapshot()
    const ops = this.stagedOps()
    const key = this.keyDraft
    if (ops.length > 0 && snapshot.writable !== true) return
    if (ops.length === 0 && key.length === 0) return
    this.saving = true
    this.notice = undefined
    this.publish()
    try {
      if (ops.length > 0) await this.scope.mutate(ops, this.fence)
      if (key.length > 0) await this.writeKey(key)
      this.draft = {}
      this.keyDraft = ''
      this.fence = undefined
      this.notice = { kind: 'ok' }
    } catch (error: unknown) {
      // The draft survives a failure, so what is on screen is exactly what a
      // retry writes; the fence is dropped so a stale revision cannot refuse
      // the retry a second time.
      this.fence = undefined
      this.notice = error instanceof MissingCredentialsError
        ? { kind: 'error', code: 'no-credentials' }
        : { kind: 'error', code: 'failed', detail: detailOf(error) }
    }
    this.saving = false
    this.publish()
  }

  /**
   * Write the staged key, then re-read whether the Host now holds one.
   * @param value - the staged credential literal.
   */
  private async writeKey(value: string): Promise<void> {
    const credentials = this.resolveCredentials()
    if (credentials === undefined) throw new MissingCredentialsError()
    await credentials.set(this.ref(), value)
    await this.readCredential()
  }

  /** Ask the credentials domain about the reference the section currently names. */
  private async readCredential(): Promise<void> {
    const credentials = this.resolveCredentials()
    const ref = this.ref()
    if (credentials === undefined) {
      this.credential = { configured: false, writable: false, lock: 'unavailable' }
      this.publish()
      return
    }
    try {
      const answer = await credentials.describe([ref])
      // A reference that changed while this read was in flight is no answer for
      // the one now in force, so its stale facts are dropped rather than shown.
      if (ref !== this.ref()) return
      const entry = answer.ok === false ? undefined : answer.value?.[ref]
      // An unknown reference stays writable: the Host is what refuses a write,
      // rather than this card guessing a refusal.
      const writable = entry?.writable !== false
      this.credential = {
        configured: entry?.configured === true,
        writable,
        // Only the inherited process environment is unwritable: this process
        // cannot edit it, so the card says that instead of offering a dead input.
        ...!writable && entry?.source === 'env' ? { lock: 'env' as const } : {},
      }
    } catch {
      // A credentials surface this dsh does not serve leaves the control closed
      // instead of reporting a key nobody checked as unset.
      this.credential = { configured: false, writable: false, lock: 'unavailable' }
    }
    this.publish()
  }

  /** The credential reference the section names, or the plugin's default. */
  private ref(): string {
    const declared = textOf(this.scope.getSnapshot().value?.apiKeyEnv)
    return declared.length > 0 ? declared : DEFAULT_API_KEY_REF
  }

  /** The edits that would change what the section holds. */
  private stagedOps(): SettingsOp[] {
    const snapshot = this.scope.getSnapshot()
    const ops: SettingsOp[] = []
    for (const field of SETTINGS_FIELDS) {
      const staged = this.draft[field]
      if (staged === undefined || staged === textOf(snapshot.value?.[field])) continue
      // An emptied field is a reset: storing the empty string would leave a
      // value the plugin cannot use, while `unset` returns it to the base.
      ops.push(staged.length === 0 ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: staged })
    }
    return ops
  }

  /** Recompute the rendered snapshot from the scope, the drafts, and the credentials answer. */
  private publish(): void {
    this.store.set(this.projection())
  }

  /** Build the rendered snapshot. */
  private projection(): SettingsCardView {
    const snapshot = this.scope.getSnapshot()
    const user = snapshot.user ?? {}
    const field = (name: SettingsField): FieldView => ({
      text: this.draft[name] ?? textOf(snapshot.value?.[name]),
      overridden: name in user,
    })
    const ops = this.stagedOps()
    const hasKey = this.keyDraft.length > 0
    const writable = snapshot.writable === true
    return {
      status: snapshot.status === 'ready' ? 'ready' : snapshot.status === 'loading' ? 'loading' : 'unavailable',
      writable,
      baseUrl: field('baseUrl'),
      model: field('model'),
      apiKey: { text: this.keyDraft, overridden: false },
      keyConfigured: this.credential.configured,
      keyWritable: this.credential.writable,
      ...this.credential.lock === undefined ? {} : { keyLock: this.credential.lock },
      ref: this.ref(),
      dirty: ops.length > 0 || hasKey,
      canSave: !this.saving && ((ops.length > 0 && writable) || (hasKey && this.credential.writable)),
      saving: this.saving,
      ...this.notice === undefined ? {} : { notice: this.notice },
    }
  }
}
