/**
 * Keyless self-test: drives the built plugin against a local fake relay.
 *
 * It mounts the plugin through a minimal structural context, captures the
 * registered tool definition, and exercises both request paths end to end:
 * text-to-image (JSON to the generation endpoint) and image-to-image
 * (`multipart/form-data` to the edit endpoint). Request encoding, credential
 * resolution, base64 decode, format sniffing, attachment commit, the canonical
 * value, the model-facing render, and presentation metadata are all asserted,
 * together with the settings section a settings-mounting deployment registers
 * and the live re-resolution a committed section value drives. No harness, no
 * model, and no real credential are involved.
 *
 * Run with `npm run selftest` after `npm run build`.
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'

/** A 1x1 PNG; only the signature is read by the plugin's own format check. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')

/** Requests the fake relay received, for assertion. */
const received = []

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => { chunks.push(chunk) })
  request.on('end', () => {
    if (request.headers.authorization !== 'Bearer test-key') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'bad key' } }))
      return
    }
    const raw = Buffer.concat(chunks)
    const contentType = String(request.headers['content-type'] ?? '')
    received.push({
      url: request.url,
      contentType,
      raw,
      json: contentType.includes('application/json') ? JSON.parse(raw.toString('utf8')) : undefined,
      text: raw.toString('latin1'),
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      model: 'gpt-image-2.5',
      data: [
        { b64_json: PNG_BASE64, revised_prompt: 'a red square' },
        { b64_json: PNG_BASE64 },
      ],
    }))
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

process.env.TEST_IMAGE_KEY = 'test-key'

/** Attachment store stub recording every committed image. */
const committed = []
const store = {
  imageLimits: {
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
  async saveImage(input) {
    committed.push(input)
    return {
      attachmentId: `sha256-${committed.length}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    }
  },
}

/** The tool definition the plugin registers. */
let registered

const { apply, Config } = await import('../lib/index.js')

/** Optional services the plugin asked for, in order. */
const requested = []

/** Minimal context standing in for the Cordis plugin context. */
const ctx = {
  logger: { info() {}, warn() {} },
  get: name => (name === 'attachments' ? store : undefined),
  inject: (names, callback) => {
    requested.push(...names)
    // The settings service is optional: this deployment mounts none, so the
    // injection activates against a context that resolves nothing for it and
    // the Loader row stays the whole configuration.
    callback(ctx)
  },
  tools: { register(definition) { registered = definition } },
}

const workdir = await mkdtemp(join(tmpdir(), 'recycle-image-gen-selftest-'))
const reference = join(workdir, 'reference.png')
await writeFile(reference, PNG_BYTES)
const notAnImage = join(workdir, 'notes.txt')
await writeFile(notAnImage, 'plain text')

apply(ctx, {
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model: 'gpt-image-2.5',
  apiKeyEnv: 'TEST_IMAGE_KEY',
  outputDir: join(workdir, 'output'),
})

assert.deepEqual(requested, ['settings', 'attachments'], 'the optional settings service is asked for before the attachment store')

assert.ok(Config?.dict?.baseUrl, 'the Loader config schema is exported for Cordis to validate against')
assert.ok(Config.dict.endpointPath, 'the Loader config schema declares the endpoint path')

assert.equal(registered?.name, 'generate_image', 'the tool registers under its wire name')
assert.deepEqual(registered.parameters.required, ['prompt'], 'only the prompt is mandatory')
assert.ok(registered.parameters.properties.image, 'the image parameter is advertised to the model')
assert.ok(registered.parameters.properties.mask, 'the mask parameter is advertised to the model')

// ── text to image ──────────────────────────────────────────────────────────

const generated = await registered.execute(
  { prompt: 'a red square', size: '512x512', n: 2 },
  { signal: AbortSignal.timeout(5000) },
)

assert.equal(received.length, 1, 'exactly one relay request')
assert.equal(received[0].url, '/v1/images/generations', 'the generation path composes onto baseUrl')
assert.ok(received[0].contentType.includes('application/json'), 'text-to-image is a JSON request')
assert.equal(received[0].json.prompt, 'a red square')
assert.equal(received[0].json.n, 2)
assert.equal(received[0].json.size, '512x512')
assert.equal(received[0].json.model, 'gpt-image-2.5')

assert.equal(generated.model, 'gpt-image-2.5', 'the relay-reported model is returned')
assert.equal(generated.images.length, 2, 'both returned images are committed')
assert.equal(committed.length, 2, 'the attachment store saw both images')
assert.equal(committed[0].mediaType, 'image/png', 'the media type is sniffed from the bytes')
assert.equal(generated.source, undefined, 'text-to-image reports no reference image')
assert.ok(generated.images[0].path?.endsWith('.png'), 'a workspace copy path is reported when outputDir is set')

const content = registered.output.render({}, generated)
assert.deepEqual(content.map(block => block.type), ['text', 'text', 'image', 'text', 'image'])
assert.equal(content[2].attachment.attachmentId, 'sha256-1')
assert.equal(content[4].attachment.attachmentId, 'sha256-2')
assert.ok(!content[0].text.includes('<edited_from>'), 'the text-to-image envelope names no source')

const meta = registered.output.presentationMeta({}, generated)
assert.equal(meta.model, 'gpt-image-2.5')
assert.equal(meta.files.length, 2, 'both workspace copies are recorded in presentation metadata')
assert.equal(meta.source, undefined)

// ── image to image ─────────────────────────────────────────────────────────

const edited = await registered.execute(
  { prompt: 'make it blue', image: reference, n: 1 },
  { signal: AbortSignal.timeout(5000) },
)

assert.equal(received.length, 2, 'a second relay request was made')
const edit = received[1]
assert.equal(edit.url, '/v1/images/edits', 'a reference image routes to the edit endpoint')
assert.ok(edit.contentType.startsWith('multipart/form-data; boundary='), 'the edit request is multipart with a fetch-owned boundary')
assert.match(edit.text, /name="prompt"/u, 'the prompt field is present')
assert.ok(edit.text.includes('make it blue'), 'the prompt value is present')
assert.match(edit.text, /name="model"/u)
assert.match(edit.text, /name="n"/u)
assert.match(edit.text, /filename="input-1\.png"/u, 'the reference image is uploaded under an extension-bearing filename')
assert.ok(edit.raw.includes(PNG_BYTES.subarray(0, 8)), 'the reference bytes ride the multipart body')

assert.equal(edited.source, reference, 'the canonical value reports the reference image')
assert.equal(edited.images.length, 2)
const editedContent = registered.output.render({}, edited)
assert.ok(editedContent[0].text.includes(`<edited_from>${reference}</edited_from>`), 'the envelope names the edited source')
assert.equal(registered.output.presentationMeta({}, edited).source, reference, 'the card can show the source')

const referenceCopy = await readFile(edited.images[0].path)
assert.ok(referenceCopy.equals(PNG_BYTES), 'the workspace copy holds the exact returned bytes')

// ── refusals ───────────────────────────────────────────────────────────────

const before = received.length

const tooMany = await registered.execute({ prompt: 'x', n: 99 }, { signal: AbortSignal.timeout(5000) })
  .then(() => null, error => error)
assert.match(tooMany.message, /between 1 and 4/u, 'an out-of-range n is refused')
assert.equal(received.length, before, 'a refused call spends no provider request')

const maskAlone = await registered.execute({ prompt: 'x', mask: reference }, { signal: AbortSignal.timeout(5000) })
  .then(() => null, error => error)
assert.match(maskAlone.message, /"mask" requires "image"/u, 'a mask without a reference image is refused')

const missing = await registered.execute({ prompt: 'x', image: join(workdir, 'nope.png') }, { signal: AbortSignal.timeout(5000) })
  .then(() => null, error => error)
assert.match(missing.message, /cannot read the "image" file/u, 'a missing reference file is refused')

const wrongFormat = await registered.execute({ prompt: 'x', image: notAnImage }, { signal: AbortSignal.timeout(5000) })
  .then(() => null, error => error)
assert.match(wrongFormat.message, /not a PNG, JPEG, WebP, or GIF/u, 'a non-image reference file is refused')

assert.equal(received.length, before, 'no refusal reached the relay')

// ── the settings section ───────────────────────────────────────────────────

/** The section registration one settings-mounting deployment hands back. */
let captured

/** The tool definition that deployment registers. */
let settingsTool

/** A deployment that mounts the settings service, with its own tool registry. */
const settingsCtx = {
  logger: { info() {}, warn() {} },
  get: name => (name === 'settings'
    ? { installSection(owner, ns, schema, entry, hooks) { captured = { ns, schema, entry, hooks } } }
    : name === 'attachments' ? store : undefined),
  inject: (names, callback) => { callback(settingsCtx) },
  tools: { register(definition) { settingsTool = definition } },
}

apply(settingsCtx, { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'from-row', apiKeyEnv: 'TEST_IMAGE_KEY' })

assert.equal(captured.ns, 'image-gen', 'the section registers under the namespace its settings card claims')
assert.ok(captured.schema.dict.baseUrl, 'the section schema declares the endpoint the card edits')
assert.ok(captured.schema.dict.model, 'the section schema declares the model the card edits')
assert.equal(captured.schema.dict.extraHeaders.meta.role, 'secret', 'relay headers never ride a settings response')
assert.equal(captured.entry.model, 'from-row', 'the Loader row is the section base layer')

// The plugin reads the section through the source thunk it was handed, so a
// committed change is what the next call uses — no restart, no re-registration.
captured.hooks.setSource(() => ({
  baseUrl: `http://127.0.0.1:${port}/v2`,
  model: 'from-settings',
  apiKeyEnv: 'TEST_IMAGE_KEY',
}))
captured.hooks.onChange()
await settingsTool.execute({ prompt: 'a blue square', n: 1 }, { signal: AbortSignal.timeout(5000) })
assert.equal(received.at(-1).url, '/v2/images/generations', 'the committed endpoint is what the next call uses')
assert.equal(received.at(-1).json.model, 'from-settings', 'the committed model is what the next call uses')

// A section this plugin cannot act on keeps the last good configuration rather
// than failing the commit that carried it.
captured.hooks.setSource(() => ({ baseUrl: 'not-an-absolute-url', apiKeyEnv: 'TEST_IMAGE_KEY' }))
captured.hooks.onChange()
await settingsTool.execute({ prompt: 'again', n: 1 }, { signal: AbortSignal.timeout(5000) })
assert.equal(received.at(-1).url, '/v2/images/generations', 'an unusable section keeps the last good endpoint')
assert.equal(received.at(-1).json.model, 'from-settings', 'an unusable section keeps the last good model')

server.close()
console.log('selftest ok: text-to-image, image-to-image, attachment commit, render, metadata, refusals, and the settings section all behave')
