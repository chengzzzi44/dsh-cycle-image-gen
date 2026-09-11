/**
 * Keyless client-half self-test.
 *
 * Two independent subjects:
 *
 * 1. The built browser bundle: installed through the shell's
 *    `window.__ModuleLoader__.load` handoff, evaluated, and mounted against a
 *    recording context — the tool view, the turn-tail row, and the settings
 *    card's claim on the `image-gen` namespace its host half serves.
 * 2. The turn-tail fold, bundled on the fly from source and driven with
 *    synthetic events. Its published location value must satisfy every check
 *    the conversation assembler itself applies after the definition returns —
 *    `kind` equals the scope, `key` equals the definition's kind, `turn` is a
 *    non-negative safe integer — because a throw there fails the whole
 *    conversation build. That exact pair (a mismatched key, and `previous`
 *    being null) once took the transcript down, so both are asserted here.
 *    Containment is asserted too: a malformed event must degrade, never throw.
 *
 * Run with `npm run selftest` after `npm run build`.
 */
import { readFile, rm } from 'node:fs/promises'
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { runInThisContext } from 'node:vm'
import { build } from 'esbuild'

/** A 1x1 PNG; the tab loader only moves its bytes. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** DOM-free stand-ins for the bundle's module-table requests. */
const REACT_STUB = {
  useState: () => [null, () => {}],
  useEffect: () => {},
  useMemo: (compute) => compute(),
  useCallback: (callback) => callback,
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const JSX_RUNTIME_STUB = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
const moduleRequire = (specifier) => {
  if (specifier === 'react') return REACT_STUB
  if (specifier === 'react/jsx-runtime') return JSX_RUNTIME_STUB
  throw new Error(`client-selftest: unexpected module-table request "${specifier}"`)
}

// ── 1. the built bundle ────────────────────────────────────────────────────

let registration
globalThis.window = { __ModuleLoader__: { load(value) { registration = value } } }
runInThisContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
assert.equal(registration?.id, 'recycle-image-gen', 'the bundle registers under its package id')

const client = registration.factory(moduleRequire)
assert.equal(client.name, 'recycle-image-gen-client')
assert.deepEqual(client.inject, ['slots', 'locale'], 'the plugin requires the slot registry and the locale service')

/** Dictionaries the locale stub received. */
const dictionaries = []
const locale = {
  register(ns, dicts) {
    dictionaries.push({ ns, dicts })
    return () => {}
  },
}

const mounted = { definitions: [], tail: undefined, toolview: undefined }
const bound = []
const conversation = {
  events: { register(definition) { mounted.definitions.push(definition) } },
  imageUrl: async (sessionId, attachment) => {
    bound.push([sessionId, attachment.attachmentId])
    return `resource://${sessionId}/${attachment.attachmentId}`
  },
  peekImageUrl: () => undefined,
}

/**
 * Minimal client context: services are resolved by name, scoped injections run
 * only while every named service is mounted, and slot registrations land in
 * the sink the caller passes.
 */
const makeCtx = (services, sink = mounted) => ({
  effect(callback) { callback(); return () => {} },
  get: name => services[name],
  inject(names, callback) {
    if (!names.every(name => services[name] !== undefined)) return
    callback(makeCtx(services, sink))
  },
  slots: {
    inject(_name, callback) { callback() },
    register(options, component) {
      if (options.name === 'conversation.chat.turnTail') sink.tail = { options, component }
      if (options.name === 'tool.call.toolview') sink.toolview = { options, component }
      if (options.name === 'settings.plugin.item') sink.item = { options, component }
      if (options.name === 'sidebar.right.pane.tab') sink.tab = { options, component }
      return () => {}
    },
  },
})

client.apply(makeCtx({ locale, uiConversation: conversation }))
assert.equal(dictionaries.length, 1, 'the plugin registers its dictionary namespace once')
assert.equal(dictionaries[0].ns, 'recycle-image-gen', 'the namespace is the one its slots declare')
assert.ok(dictionaries[0].dicts.zh && dictionaries[0].dicts.en, 'both languages are registered')
assert.equal(dictionaries[0].dicts.zh['card.title'], 'recycle-image-gen', 'the settings card is titled with the plugin name')
assert.equal(dictionaries[0].dicts.en['card.title'], 'recycle-image-gen', 'both languages title the card with the plugin name')
assert.equal(mounted.definitions.length, 1, 'the fold registers once')
assert.equal(mounted.toolview?.options.key, 'generate_image', 'the tool card is registered for the wire tool name')
assert.equal(mounted.toolview?.options.locale, 'recycle-image-gen', 'the tool card declares its dictionary')
assert.ok(mounted.tail, 'the turn-tail entry is registered')
assert.equal(mounted.tail.options.locale, 'recycle-image-gen', 'the turn-tail entry declares its dictionary')
assert.equal(typeof mounted.tail.options.select, 'function', 'a chain entry carries its selector')
assert.equal(typeof mounted.tail.options.inject, 'function', 'the loader pair arrives through inject')

// ── portability: a dsh without the Conversation service keeps the tool card ─

const degraded = { toolview: undefined, tail: undefined, item: undefined }
const quiet = console.warn
const warnings = []
console.warn = (...args) => { warnings.push(args) }
try {
  client.apply(makeCtx({ locale }, degraded))
} finally {
  console.warn = quiet
}
assert.equal(degraded.toolview?.options.key, 'generate_image', 'a dsh without the Conversation service still gets the tool card')
assert.equal(degraded.tail, undefined, 'and is not offered a row it cannot render')
assert.equal(degraded.item, undefined, 'and is not offered a settings card it cannot build')
assert.equal(warnings.length, 0, 'a missing optional service costs its surface silently: the scoped injection never runs')

// ── the settings card claims the namespace the host half registers ─────────

const settingsMounted = {}
const boundScopes = []
const scope = {
  getSnapshot: () => ({ status: 'ready', value: {}, user: {}, writable: true, revision: 0 }),
  subscribe: () => () => {},
  mutate: async () => {},
  unset: async () => {},
}
const settingsServices = {
  locale,
  settingsScope: {
    bind(spec) {
      boundScopes.push(spec)
      return scope
    },
  },
}
const settingsCtx = makeCtx(settingsServices, settingsMounted)
client.apply(settingsCtx)
assert.equal(settingsMounted.item?.options.key, 'image-gen', 'the card claims the namespace its host half registers')
assert.deepEqual(boundScopes, [{ namespace: 'image-gen' }], 'the card binds that namespace')
assert.equal(typeof settingsMounted.item.component, 'function', 'the card renders through a component')
assert.equal(settingsMounted.item.options.locale, 'recycle-image-gen', 'the card declares its dictionary')
assert.ok(settingsMounted.item.options.inject().controller, 'the controller rides the registration inject face')

// ── the right-Sidebar image tab ────────────────────────────────────────────

const tabTypes = []
const tabPanes = {}
const reads = []
const imageServices = {
  locale,
  sidebarRightTabs: {
    register(definition) {
      tabTypes.push(definition)
      return () => {}
    },
  },
  'remote.workspaceFiles': {
    readBytes(sessionId, path, range) {
      reads.push({ sessionId, path, range })
      return Promise.resolve({ ok: true, value: { data: PNG_BYTES.toString('base64'), eof: true, bytes: PNG_BYTES.length } })
    },
  },
}
client.apply(makeCtx(imageServices, tabPanes))

assert.equal(tabTypes.length, 1, 'the image tab type registers once')
const [imageType] = tabTypes
assert.equal(imageType.id, 'recycle-image-gen/image', 'the type registers under its own id')
assert.equal(imageType.kind, 'image', 'the type owns its own kind')
assert.equal(imageType.priority, 'extension', 'the image type outranks the shipped text fallback')
const imageAddress = 'dsh-resource://file/session/session-1/generated-images/image-sha256abc.png'
assert.equal(imageType.canOpen(imageAddress), true, 'an image path is claimed')
assert.equal(imageType.canOpen('dsh-resource://file/session/session-1/notes.md'), false, 'a non-image path is declined')
assert.equal(imageType.canOpen('dsh-resource://attachment/sha256:abc'), false, 'a non-file address is declined')
assert.equal(imageType.title(imageAddress), 'image-sha256abc.png', 'the chip shows the address basename')
assert.equal(tabPanes.tab?.options.key, 'recycle-image-gen/image', 'the body registers under the type id')
assert.equal(tabPanes.tab?.options.locale, 'recycle-image-gen', 'the body declares its dictionary')

const loaded = await tabPanes.tab.options.inject().load(imageAddress, 'session-1', new AbortController().signal)
assert.equal(loaded.mediaType, 'image/png', 'the extension names the media type')
assert.ok(Buffer.from(loaded.data).equals(PNG_BYTES), 'the tab loads the exact file bytes')
assert.deepEqual(reads, [{
  sessionId: 'session-1',
  path: 'generated-images/image-sha256abc.png',
  range: { offset: 0 },
}], 'the address path and session reach the workspace-files read')

const absolute = await tabPages(
  'dsh-resource://file/absolute/tmp/elsewhere/image.png',
  'session-9',
)
assert.equal(absolute.sessionId, 'session-9', 'an absolute address is read through the seat session')
assert.equal(absolute.path, '/tmp/elsewhere/image.png', 'an absolute address keeps its leading slash')

/** Load one address and report the read it performed. */
async function tabPages(address, sessionId) {
  reads.length = 0
  await tabPanes.tab.options.inject().load(address, sessionId, new AbortController().signal)
  return reads[0]
}


// ── 2. the turn-tail fold, straight from source ────────────────────────────

const bundled = join(tmpdir(), `recycle-image-gen-turn-images-${String(process.pid)}.mjs`)
await build({
  entryPoints: [new URL('../src/client/turn-images.ts', import.meta.url).pathname],
  outfile: bundled,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { generatedTailDefinition: definition, selectGeneratedTail, GENERATED_TAIL_KIND } =
  await import(pathToFileURL(bundled).href)
await rm(bundled, { force: true })

assert.equal(definition.kind, GENERATED_TAIL_KIND)
assert.equal(mounted.definitions[0].kind, GENERATED_TAIL_KIND, 'the registered definition is this one')

const event = (type, data, seq, surfaceOp) => ({ type, seq, surfaceOp, data })
const IMAGE = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 4, height: 4 }
const resultEvent = (overrides = {}) => event('tool/result', {
  turn: 1,
  step: 1,
  message: {
    content: [{
      isError: false,
      content: [{ type: 'text', text: 'envelope' }, { type: 'image', attachment: IMAGE }],
    }],
    source: { kind: 'tool', callId: 'c1' },
  },
  meta: { files: ['/tmp/generated.png'] },
  ...overrides,
}, 12, 'append')

const start = definition.match(event('turn/start', { turn: 1 }, 10))
assert.equal(start.role, 'start')
let state = definition.start({}, start)
state = definition.update({ state }, definition.match(event('tool/call', { turn: 1, callId: 'c1', name: 'generate_image', arguments: '{}' }, 11)))
state = definition.update({ state }, definition.match(resultEvent()))

// Every check the assembler applies to a returned location value, asserted
// directly. `previous` is null here on purpose: the assembler passes null for
// "no previous value", and an earlier version dereferenced it.
const location = definition.buildLocationData({ state }, 'turn', null)
assert.equal(location.kind, 'turn', 'the published kind equals the scope')
assert.equal(location.key, definition.kind, 'the published key equals the definition kind')
assert.ok(Number.isSafeInteger(location.turn) && location.turn >= 0, 'the published turn is a non-negative safe integer')
assert.equal(location.turn, 1)
assert.equal(location.value.images.length, 1, 'the generated image is folded into turn data')
assert.equal(location.value.images[0].path, '/tmp/generated.png', 'the workspace copy rides along')
assert.equal(location.value.images[0].attachment.attachmentId, 'sha256:abc')
assert.equal(
  definition.buildLocationData({ state }, 'turn', location),
  location,
  'an unchanged fold republishes its previous location value by identity',
)
assert.equal(definition.buildLocationData({ state }, 'step', null), null, 'a non-turn scope publishes nothing')
assert.equal(definition.buildLocationData({ state: undefined }, 'turn', null), null, 'an unstarted fold publishes nothing')

// ── containment: a defect here may cost the row, never the transcript ──────

const originalError = console.error
const reportedErrors = []
console.error = (...args) => { reportedErrors.push(args) }
try {
  assert.doesNotThrow(() => definition.match({}))
  assert.doesNotThrow(() => definition.match({ type: 'turn/start', data: null }))
  assert.doesNotThrow(() => definition.start({}, { event: { type: 'nonsense', data: {} } }))
  assert.doesNotThrow(() => definition.update({ state: undefined }, { event: { type: 'tool/call', data: null } }))
  assert.doesNotThrow(() => definition.buildLocationData({ state: { turn: 1, calls: new Map(), images: [] } }, 'turn', undefined))
  assert.doesNotThrow(() => selectGeneratedTail({ turn: undefined, seq: 0 }))
  const fallback = definition.start({}, { event: { type: 'nonsense', data: {} } })
  assert.ok(Number.isSafeInteger(fallback.turn) && fallback.turn >= 0, 'a contained start still yields a publishable state')
} finally {
  console.error = originalError
}
assert.ok(reportedErrors.length > 0, 'containment reports the first failure instead of hiding it')

// ── the selector's claim ───────────────────────────────────────────────────

const owner = (seq, data) => ({ turn: { data: { get: key => (key === GENERATED_TAIL_KIND ? data : undefined) } }, seq })
const matched = selectGeneratedTail(owner(12, location.value))
assert.equal(matched.length, 1, 'the closing turn claims the tail')
assert.equal(selectGeneratedTail(owner(12, undefined)), null, 'a turn with no images declines')
assert.equal(selectGeneratedTail(owner(11, location.value)), null, 'an image settled after the closing seq is excluded')

// ── attribution and refusal arms ───────────────────────────────────────────

const foldTurn = (turn, name, callId, result) => {
  let next = definition.start({}, definition.match(event('turn/start', { turn }, turn * 10)))
  next = definition.update({ state: next }, definition.match(event('tool/call', { turn, callId, name, arguments: '{}' }, turn * 10 + 1)))
  return definition.update({ state: next }, definition.match(result))
}

const otherTool = foldTurn(2, 'read_image', 'c2', resultEvent({
  turn: 2,
  message: {
    content: [{ isError: false, content: [{ type: 'image', attachment: IMAGE }] }],
    source: { kind: 'tool', callId: 'c2' },
  },
}))
assert.equal(otherTool.images.length, 0, 'an image returned by another tool never reaches this row')

const failed = foldTurn(3, 'generate_image', 'c3', event('tool/result', {
  turn: 3,
  message: {
    content: [{ isError: true, content: [{ type: 'text', text: 'failed' }] }],
    source: { kind: 'tool', callId: 'c3' },
  },
}, 32, 'append'))
assert.equal(failed.images.length, 0, 'a failed call contributes nothing')

assert.equal(definition.match(event('tool/result', {}, 13, 'replace')), null, 'a replacement result is not transcript material')
assert.equal(definition.match(event('assistant/message', { turn: 1 }, 14)), null, 'an unrelated event never matches')

// ── the inject face binds the session loader ───────────────────────────────

const injected = mounted.tail.options.inject('session-7')
assert.equal(await injected.imageUrl(IMAGE), 'resource://session-7/sha256:abc', 'the injected loader is bound to the slot session')
assert.deepEqual(bound, [['session-7', 'sha256:abc']])
assert.equal(injected.peekImageUrl(IMAGE), undefined)

console.log('client-selftest ok: bundle registration, settings card claim, assembler invariants, containment, fold, selector claim, and refusals all behave')
