/**
 * Turn-scoped generated-image fold for the chat turn tail.
 *
 * Everything the shipped `tool-call` node renders is folded into the Turn's
 * process disclosure, so a generated image ends up behind the "N tool calls"
 * toggle. The turn tail is the one chat surface outside that fold that a
 * plugin may claim, so this definition republishes each `generate_image`
 * result as turn data and the tail entry renders it there.
 *
 * The client bundle cannot import a harness package, so the event shapes are
 * narrowed structurally and the wire tool name is restated.
 *
 * @module dsh-cycle-image-gen/client/turn-images
 */

/** Wire tool name the host half registers; also the browser card's key. */
const GENERATE_TOOL = 'generate_image'

/**
 * The definition's kind. The conversation assembler validates that a published
 * location value's `key` equals the publishing definition's `kind`, so this one
 * constant is both; naming them separately is what let them drift.
 */
export const GENERATED_TAIL_KIND = 'dsh-cycle-image-gen-tail'

/** Durable image reference as it crosses the wire inside an `image` content block. */
export interface GeneratedTailImage {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** One generated image with its settlement seq and optional workspace copy. */
export interface GeneratedTailEntry {
  /** Log seq of the `tool/result` that settled this image. */
  seq: number
  attachment: GeneratedTailImage
  /** Absolute workspace copy the host half reported, when the deployment configures one. */
  path?: string
}

/** Turn data published under {@link GENERATED_TAIL_KIND}. */
export interface GeneratedTailTurnData {
  readonly images: readonly GeneratedTailEntry[]
}

/** Fold state: the published data plus the call ledger needed to attribute results. */
interface GeneratedTailState extends GeneratedTailTurnData {
  readonly turn: number
  /** `callId` to wire tool name, so a result can be attributed without a name on its own event. */
  readonly calls: ReadonlyMap<string, string>
}

/** Minimal structural view of one session event this fold reads. */
interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly surfaceOp?: unknown
  readonly data: unknown
}

/** Turn data publication the conversation location index stores. */
interface TurnLocationData {
  readonly kind: 'turn'
  readonly turn: number
  readonly key: string
  readonly value: GeneratedTailTurnData
}

/** One fold step's declaration, mirroring the conversation node contract. */
interface FoldMatch {
  readonly id: string
  readonly role: 'start' | 'update'
  readonly event: SessionEventLike
}

/** Narrow one unvalidated wire value to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a required string field, declining the whole record when absent. */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Narrow one wire attachment reference, declining on anything malformed. */
function attachmentReference(value: unknown): GeneratedTailImage | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const attachmentId = stringField(record, 'attachmentId')
  const mediaType = stringField(record, 'mediaType')
  const { bytes, width, height, name } = record
  if (attachmentId === undefined || mediaType === undefined) return undefined
  if (typeof bytes !== 'number' || typeof width !== 'number' || typeof height !== 'number') return undefined
  return {
    attachmentId,
    mediaType,
    bytes,
    width,
    height,
    ...typeof name === 'string' ? { name } : {},
  }
}

/** Every durable image reference carried by one tool result's content, in order. */
function resultImages(content: unknown): GeneratedTailImage[] {
  if (!Array.isArray(content)) return []
  const images: GeneratedTailImage[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.type !== 'image') continue
    const reference = attachmentReference(record.attachment)
    if (reference !== undefined) images.push(reference)
  }
  return images
}

/** Whether a fold failure has already been reported, so containment logs once. */
let reported = false

/**
 * Run one fold entry point so a defect in it cannot propagate.
 *
 * Containment is deliberate and load-bearing. The conversation assembler runs
 * every registered definition while building the transcript, and it rejects a
 * malformed publication by throwing — which fails the whole conversation build
 * and leaves the user with no transcript at all. A defect in this optional row
 * must therefore cost only the row. The first failure is reported, so
 * containment never hides a symptom entirely.
 *
 * The assembler's own checks on the returned location value (`kind` equals the
 * scope, `key` equals this definition's kind, `turn` is a safe integer) run
 * after this function returns and cannot be contained here; those invariants
 * are asserted in the client self-test instead.
 * @param fallback - value to use when the operation fails.
 * @param operation - the fold step to run.
 * @returns the operation's result, or the fallback.
 */
function contain<T>(fallback: T, operation: () => T): T {
  try {
    return operation()
  } catch (error: unknown) {
    if (!reported) {
      reported = true
      console.error(
        'dsh-cycle-image-gen: the generated-image turn-tail fold failed, so that row is disabled for this session;'
        + ' the conversation itself is unaffected',
        error,
      )
    }
    return fallback
  }
}

/** Workspace copy paths the host half persisted in the result's presentation metadata. */
function metaFiles(meta: unknown): string[] {
  const files = asRecord(meta)?.files
  if (!Array.isArray(files)) return []
  return files.filter((file): file is string => typeof file === 'string' && file.length > 0)
}

/**
 * Turn-local fold of `generate_image` results.
 *
 * It publishes no view node: the tail selector reads the turn data it
 * accumulates. Failed results contribute nothing, and a call whose name is not
 * the wire tool name is skipped, so an image returned by another tool (a
 * `read_image`, say) never reaches this row.
 *
 * Every entry point is contained so this optional row can never fail the
 * conversation build; see {@link contain}.
 */
export const generatedTailDefinition = {
  kind: GENERATED_TAIL_KIND,
  match(event: SessionEventLike): FoldMatch | null {
    return contain(null, () => {
      const data = asRecord(event.data)
      const turn = data?.turn
      if (typeof turn !== 'number') return null
      if (event.type === 'turn/start') return { id: String(turn), role: 'start', event }
      if (event.type === 'tool/call') return { id: String(turn), role: 'update', event }
      // Only an append-origin result is transcript material; a replacement copy
      // is model-only and would re-report an image the user already saw.
      if (event.type === 'tool/result' && event.surfaceOp === 'append') {
        return { id: String(turn), role: 'update', event }
      }
      return null
    })
  },
  start(_context: unknown, match: FoldMatch): GeneratedTailState {
    return contain({ turn: 0, calls: new Map(), images: [] }, () => {
      const data = asRecord(match.event.data)
      const turn = data?.turn
      // The assembler validates the published turn as a non-negative safe
      // integer, so refuse anything else at the source rather than publishing it.
      if (match.event.type !== 'turn/start' || typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0) {
        throw new Error('dsh-cycle-image-gen-tail start requires a turn/start event carrying a non-negative safe-integer turn')
      }
      return { turn, calls: new Map(), images: [] }
    })
  },
  update(context: { state: GeneratedTailState }, match: FoldMatch): GeneratedTailState {
    return contain(context.state, () => {
      const state = context.state
      if (match.event.type === 'tool/call') {
        const data = asRecord(match.event.data)
        const callId = data === undefined ? undefined : stringField(data, 'callId')
        const name = data === undefined ? undefined : stringField(data, 'name')
        if (callId === undefined || name === undefined) return state
        const calls = new Map(state.calls)
        calls.set(callId, name)
        return { ...state, calls }
      }
      if (match.event.type !== 'tool/result') return state
      const data = asRecord(match.event.data)
      const message = data === undefined ? undefined : asRecord(data.message)
      const source = message === undefined ? undefined : asRecord(message.source)
      const callId = source === undefined ? undefined : stringField(source, 'callId')
      if (message === undefined || callId === undefined) return state
      if (state.calls.get(callId) !== GENERATE_TOOL) return state
      const block = Array.isArray(message.content) ? asRecord(message.content[0]) : undefined
      if (block === undefined || block.isError === true) return state
      const attachments = resultImages(block.content)
      if (attachments.length === 0) return state
      const files = metaFiles(data?.meta)
      const seq = typeof match.event.seq === 'number' ? match.event.seq : 0
      return {
        ...state,
        images: [
          ...state.images,
          ...attachments.map((attachment, index) => ({
            seq,
            attachment,
            ...files[index] === undefined ? {} : { path: files[index] },
          })),
        ],
      }
    })
  },
  buildLocationData(
    context: { state: GeneratedTailState | undefined },
    scope: string,
    previous: TurnLocationData | null | undefined,
  ): TurnLocationData | null {
    return contain(null, () => {
      const state = context.state
      if (scope !== 'turn' || state === undefined) return null
      // The assembler passes null for "no previous value" and rejects a
      // published key that differs from this definition's kind, so both the
      // null guard and the shared constant are load-bearing.
      if (previous !== undefined
        && previous !== null
        && previous.turn === state.turn
        && previous.key === GENERATED_TAIL_KIND
        && previous.value.images === state.images) return previous
      return { kind: 'turn', turn: state.turn, key: GENERATED_TAIL_KIND, value: { images: state.images } }
    })
  },
}

/** Owner currency the tail selector reads: the Turn location and the closing seq. */
export interface GeneratedTailOwner {
  readonly turn: { readonly data: { get(key: string): unknown } }
  readonly seq: number
}

/**
 * Claim the turn-tail chain for one closing turn that generated images.
 *
 * Images settled after the closing assistant seq belong to a later turn and are
 * excluded, matching how the produced-files row scopes itself.
 * @param owner - closing-turn identity and file opener.
 * @returns the images to render, or null to pass the chain to the next entry.
 */
export function selectGeneratedTail(owner: GeneratedTailOwner): readonly GeneratedTailEntry[] | null {
  return contain(null, () => {
    const data = owner.turn.data.get(GENERATED_TAIL_KIND)
    const images = (data as GeneratedTailTurnData | undefined)?.images
    if (!Array.isArray(images)) return null
    const visible = images.filter(entry => entry.seq <= owner.seq)
    return visible.length === 0 ? null : visible
  })
}
