/**
 * The `generate_image` tool: an OpenAI-compatible images call whose results
 * become durable attachments.
 *
 * The node half of the dual-face plugin. Its only runtime import outside
 * `node:` builtins is `@deepseek-ai/schemastery`, the settings section's schema
 * library; it never imports a harness package at runtime. The tool definition,
 * the attachment store, and the credential service are all reached through
 * structural contracts on `ctx`, so the plugin survives version skew with the
 * installed harness. Cordis validates the Loader row's `config` against the
 * exported `Config` schema before `apply` runs. The browser half lives in
 * `./client/index.tsx`.
 *
 * @module dsh-cycle-image-gen
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveConfig, type ImageGenConfig, type ResolvedImageGenConfig } from './config.ts'
import { IMAGE_GEN_SETTINGS_NAMESPACE, ImageGenConfigSchema } from './settings.ts'
import { requestImages, sniffMediaType, type DecodedImage, type ImageMediaType, type InputImage } from './relay.ts'

export type { ImageGenConfig, ResolvedImageGenConfig } from './config.ts'
export { resolveConfig } from './config.ts'
export { Config } from './settings.ts'

/** File extension for each accepted media type. */
const EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/** The model-facing tool name; the browser card is keyed by this exact string. */
export const TOOL_NAME = 'generate_image'

/** One durably committed generated image, as it crosses the tool boundary. */
export interface GeneratedImageValue {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
  /** Absolute host path of the copy written under `config.outputDir`, when configured. */
  path?: string
  /** Input dimensions before storage normalization; present only when storage reduced the image. */
  originalDimensions?: { width: number; height: number }
}

/** The canonical value `generate_image` returns. */
export interface GenerateImageValue {
  model: string
  prompt: string
  images: GeneratedImageValue[]
  /** Path of the reference image an edit was based on; absent for text-to-image. */
  source?: string
}

/** Durable reference the attachment store returns. */
interface AttachmentRefLike extends GeneratedImageValue {}

/** Structural view of the attachment service this plugin uses. */
interface AttachmentStoreLike {
  imageLimits: { mediaTypes: readonly ImageMediaType[] }
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<AttachmentRefLike>
}

/** Structural view of the credential service. */
interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** Structural view of the optional settings service this plugin registers its section into. */
interface SettingsLike {
  installSection(
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: {
      setSource(current: () => ImageGenConfig): void
      onChange(): void
    },
  ): void
}

/** Structural view of the plugin context this plugin uses. */
interface PluginContextLike {
  logger?: { info(message: string): void; warn(message: string): void }
  get(name: string): unknown
  inject(names: readonly string[], callback: (ctx: PluginContextLike) => void): void
  tools: { register(definition: unknown): unknown }
}

/** Structural view of the immutable execution context. */
interface ToolRunContextLike {
  signal: AbortSignal
  /**
   * The agent on whose behalf the call runs. Its session header carries the
   * workspace root a relative `outputDir` resolves against; absent on a
   * non-agent caller.
   */
  agent?: {
    session?: {
      header?: {
        cwd?: string
      }
    }
  }
}

/** The resolved generation arguments. */
interface GenerationArguments {
  prompt: string
  size?: string
  quality?: string
  background?: string
  n: number
  imagePath?: string
  maskPath?: string
}

/** JSON Schema for the tool's arguments. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: {
      type: 'string',
      description: 'What to draw. Be specific about subject, style, composition, lighting, and any text that must appear.',
    },
    size: {
      type: 'string',
      description: 'Output size as WIDTHxHEIGHT, for example 1024x1024. Must be one the relay supports; omitted uses the deployment default.',
    },
    quality: {
      type: 'string',
      description: 'Render quality the relay accepts, for example low, medium, or high. Omitted uses the relay default.',
    },
    background: {
      type: 'string',
      enum: ['transparent', 'opaque'],
      description: 'Background handling. Transparent requires an output format that carries alpha, such as PNG or WebP.',
    },
    n: {
      type: 'integer',
      description: 'How many images to generate. Each one costs a separate provider charge.',
    },
    image: {
      type: 'string',
      description: 'Path to an existing image to edit. Pass the path the conversation gave you for that image, '
        + 'including the read-only normalized copy reported for an image the user attached, or a path returned by an earlier generate_image call. '
        + 'When set, the request edits this image instead of generating from scratch.',
    },
    mask: {
      type: 'string',
      description: 'Path to a PNG mask selecting the region to edit. Requires "image". '
        + 'Fully transparent pixels mark the area to regenerate; opaque pixels are kept.',
    },
  },
} as const

/** JSON Schema for the canonical return value. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'prompt', 'images'],
  properties: {
    model: { type: 'string' },
    prompt: { type: 'string' },
    source: { type: 'string' },
    images: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          name: { type: 'string' },
          path: { type: 'string' },
          originalDimensions: {
            type: 'object',
            additionalProperties: false,
            required: ['width', 'height'],
            properties: {
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
          },
        },
      },
    },
  },
} as const

/**
 * Validate the model-supplied arguments. A raw JSON-Schema tool owns its own
 * input validation, so every rejection is named here rather than surfaced as a
 * downstream provider error.
 * @param raw - the frozen arguments object.
 * @param config - resolved configuration, supplying the `n` bound.
 * @returns the validated arguments.
 * @throws {Error} naming the offending field.
 */
function parseArguments(raw: unknown, config: ResolvedImageGenConfig): GenerationArguments {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${TOOL_NAME}: arguments must be a JSON object`)
  }
  const args = raw as Record<string, unknown>
  const prompt = args.prompt
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error(`${TOOL_NAME}: "prompt" must be a non-empty string`)
  }
  const optionalString = (field: string): string | undefined => {
    const value = args[field]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${TOOL_NAME}: "${field}" must be a non-empty string when present`)
    }
    return value
  }
  const size = optionalString('size')
  const quality = optionalString('quality')
  const background = optionalString('background')
  const imagePath = optionalString('image')
  const maskPath = optionalString('mask')
  if (maskPath !== undefined && imagePath === undefined) {
    throw new Error(`${TOOL_NAME}: "mask" requires "image"; a mask selects a region of the reference image`)
  }
  if (background !== undefined && background !== 'transparent' && background !== 'opaque') {
    throw new Error(`${TOOL_NAME}: "background" must be "transparent" or "opaque"`)
  }
  const requested = args.n
  if (requested !== undefined && (typeof requested !== 'number' || !Number.isInteger(requested))) {
    throw new Error(`${TOOL_NAME}: "n" must be an integer`)
  }
  const n = requested ?? 1
  if (n < 1 || n > config.maxImagesPerCall) {
    throw new Error(`${TOOL_NAME}: "n" must be between 1 and ${config.maxImagesPerCall}`)
  }
  return {
    prompt,
    n,
    ...size === undefined ? {} : { size },
    ...quality === undefined ? {} : { quality },
    ...background === undefined ? {} : { background },
    ...imagePath === undefined ? {} : { imagePath },
    ...maskPath === undefined ? {} : { maskPath },
  }
}

/**
 * Read and validate one reference image from the filesystem.
 *
 * A path is the only handle a model can pass through JSON arguments, and the
 * conversation already reports one for every image the model can see: the
 * request projection writes a normalized read-only copy path beside each
 * attached image, and a generated image reports the copy this plugin wrote.
 * @param path - the model-supplied path.
 * @param config - resolved configuration, supplying the upload cap.
 * @param field - argument name, named in diagnostics.
 * @param signal - caller cancellation.
 * @returns the exact bytes plus their sniffed media type.
 * @throws {Error} naming the field and the path on any refusal.
 */
async function readInputImage(
  path: string,
  config: ResolvedImageGenConfig,
  field: 'image' | 'mask',
  signal: AbortSignal,
): Promise<InputImage> {
  let bytes: Uint8Array
  try {
    bytes = await readFile(path, { signal })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${TOOL_NAME}: cannot read the "${field}" file "${path}": ${message}`, { cause: error })
  }
  if (bytes.byteLength > config.maxInputImageBytes) {
    throw new Error(
      `${TOOL_NAME}: the "${field}" file "${path}" is ${bytes.byteLength} bytes,`
      + ` above the configured maxInputImageBytes of ${config.maxInputImageBytes}`,
    )
  }
  const mediaType = sniffMediaType(bytes)
  if (mediaType === undefined) {
    throw new Error(`${TOOL_NAME}: the "${field}" file "${path}" is not a PNG, JPEG, WebP, or GIF image`)
  }
  return { data: bytes, mediaType }
}

/**
 * Resolve the relay credential: the credential service first, which covers the
 * launching environment and the deployment's `.env`, then the process
 * environment directly when no credential seam is mounted.
 * @param ctx - plugin context used to reach the optional credential service.
 * @param reference - configured credential reference.
 * @returns the credential value.
 * @throws {Error} naming the reference when no value is stored anywhere.
 */
async function resolveApiKey(ctx: PluginContextLike, reference: string): Promise<string> {
  const credentials = ctx.get('credentials') as CredentialsLike | undefined
  if (credentials !== undefined) {
    const hit = await credentials.resolve(reference)
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
  }
  const ambient = process.env[reference]
  if (ambient !== undefined && ambient.length > 0) return ambient
  throw new Error(
    `${TOOL_NAME}: no credential for "${reference}"; store it through the credentials service or export ${reference} in the environment that launched dsh`
    + ', or point config.apiKeyEnv at a reference that holds it',
  )
}

/** Refuse a media type this deployment's attachment store does not accept. */
function assertDeploymentAccepts(store: AttachmentStoreLike, mediaType: ImageMediaType): void {
  if (!store.imageLimits.mediaTypes.includes(mediaType)) {
    throw new Error(`${TOOL_NAME}: this deployment does not accept ${mediaType} images`)
  }
}

/** Restate an attachment-store refusal as an actionable tool error. */
function attachmentFailure(error: unknown, mediaType: ImageMediaType): Error {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === 'IMAGE_TOO_LARGE' || code === 'IMAGE_DIMENSION_TOO_LARGE' || code === 'IMAGE_TOO_MANY_PIXELS') {
    return new Error(
      `${TOOL_NAME}: the generated ${mediaType} exceeds this deployment's image storage limits (${String(code)}); request a smaller size`,
      { cause: error },
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${TOOL_NAME}: storing the generated ${mediaType} failed: ${message}`, { cause: error })
}

/**
 * Resolve the configured copy directory for one call.
 *
 * A relative `outputDir` is resolved against the calling session's workspace
 * (`exec.agent.session.header.cwd`, the same root the built-in file tools and
 * the Web sidebar use), so copies land where the workspace surfaces may read
 * them. An absolute `outputDir` is used verbatim, and a call with no agent
 * falls back to the process working directory.
 * @param configured - the configured `outputDir`.
 * @param exec - the execution context carrying the calling agent.
 * @returns the absolute directory this call writes copies into.
 */
function resolveOutputDir(configured: string, exec: ToolRunContextLike): string {
  if (isAbsolute(configured)) return configured
  return resolve(exec.agent?.session?.header?.cwd ?? process.cwd(), configured)
}

/**
 * Write the workspace copy of one image.
 *
 * The name carries a digest of the exact attachment id, so one image always
 * writes one path (a retry overwrites its own file) and two different images
 * never share one. A short readable prefix keeps the file recognizable by eye.
 * @param directory - configured absolute output directory.
 * @param ref - the durable reference the bytes were committed under.
 * @param data - exact image bytes.
 * @returns the absolute path written.
 */
async function writeWorkspaceCopy(directory: string, ref: AttachmentRefLike, data: Uint8Array): Promise<string> {
  await mkdir(directory, { recursive: true })
  // The attachment id is opaque and need not be filename-safe: the local store
  // mints `sha256:<hex>`, and a colon is illegal in a Windows filename. The
  // digest is taken over the exact id, so sanitizing can never merge two ids.
  const digest = createHash('sha256').update(ref.attachmentId).digest('hex').slice(0, 32)
  const readable = ref.attachmentId.replace(/[^0-9a-z]/giu, '').slice(0, 8) || 'image'
  const path = join(directory, `image-${readable}-${digest}${EXTENSIONS[ref.mediaType]}`)
  await writeFile(path, data)
  return path
}

/** Model-facing envelope introducing one generation batch. */
function batchEnvelope(value: GenerateImageValue): string {
  const lines = [
    '<generated_image>',
    `<model>${value.model}</model>`,
    `<count>${value.images.length}</count>`,
    `<prompt>${value.prompt}</prompt>`,
  ]
  if (value.source !== undefined) lines.push(`<edited_from>${value.source}</edited_from>`)
  lines.push(
    '<content>',
    `The image${value.images.length === 1 ? ' is' : 's are'} returned below and ${value.images.length === 1 ? 'is' : 'are'} already visible to the user in the conversation.`,
    '</content>',
    '</generated_image>',
  )
  return lines.join('\n')
}

/** Model-facing envelope describing one returned image. */
function imageEnvelope(image: GeneratedImageValue): string {
  const lines = [
    '<image>',
    `<type>${image.mediaType}</type>`,
    `<dimensions>${image.width}x${image.height} px</dimensions>`,
    `<bytes>${image.bytes}</bytes>`,
    `<attachment>${image.attachmentId}</attachment>`,
  ]
  if (image.path !== undefined) lines.push(`<path>${image.path}</path>`)
  lines.push('</image>')
  return lines.join('\n')
}

/** The durable reference an `image` content block carries. */
function imageBlockAttachment(image: GeneratedImageValue): Record<string, unknown> {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
    ...image.originalDimensions === undefined ? {} : { originalDimensions: { ...image.originalDimensions } },
  }
}

/**
 * Build the complete tool definition.
 * @param ctx - the context that owns the registered tool, used per call.
 * @param store - the mounted attachment store.
 * @param configOf - reads the configuration in force for this call, which a committed settings write replaces between calls.
 * @returns the tool definition handed to `ctx.tools.register`.
 */
function generateImageTool(
  ctx: PluginContextLike,
  store: AttachmentStoreLike,
  configOf: () => ResolvedImageGenConfig,
): unknown {
  return {
    name: TOOL_NAME,
    description: 'Generate or edit images through the configured image model. '
      + 'Without "image" it draws one or more images from the prompt. '
      + 'With "image" it edits that reference image instead, which is how you restyle, extend, retouch, or make a variation of a picture the user attached or an image generated earlier. '
      + 'Either way the resulting images are returned to you and shown to the user, each stored durably with a local file path when the deployment configures one. '
      + 'Use this whenever the user asks for a picture, illustration, logo, icon, or any other generated or edited image.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: GenerateImageValue): unknown[] {
        const blocks: unknown[] = [{ type: 'text', text: batchEnvelope(value) }]
        for (const image of value.images) {
          blocks.push({ type: 'text', text: imageEnvelope(image) })
          blocks.push({ type: 'image', attachment: imageBlockAttachment(image) })
        }
        return blocks
      },
      presentationMeta(_args: unknown, value: GenerateImageValue): Record<string, unknown> {
        const files = value.images.map(image => image.path).filter((path): path is string => path !== undefined)
        return {
          model: value.model,
          ...value.source === undefined ? {} : { source: value.source },
          ...files.length === 0 ? {} : { files },
        }
      },
    },
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<GenerateImageValue> {
      const config = configOf()
      const args = parseArguments(raw, config)
      const apiKey = await resolveApiKey(ctx, config.apiKeyEnv)
      // The reference images are read before the request so a missing or
      // oversized file fails without spending a provider call.
      const inputs = args.imagePath === undefined
        ? undefined
        : [await readInputImage(args.imagePath, config, 'image', exec.signal)]
      const mask = args.maskPath === undefined
        ? undefined
        : await readInputImage(args.maskPath, config, 'mask', exec.signal)
      const outcome = await requestImages(config, apiKey, {
        prompt: args.prompt,
        n: args.n,
        ...args.size === undefined ? {} : { size: args.size },
        ...args.quality === undefined ? {} : { quality: args.quality },
        ...args.background === undefined ? {} : { background: args.background },
        ...inputs === undefined ? {} : { inputs },
        ...mask === undefined ? {} : { mask },
      }, exec.signal)
      const outputDir = config.outputDir === undefined ? undefined : resolveOutputDir(config.outputDir, exec)
      const images: GeneratedImageValue[] = []
      for (const decoded of outcome.images as DecodedImage[]) {
        assertDeploymentAccepts(store, decoded.mediaType)
        let ref: AttachmentRefLike
        try {
          // Persist before returning: the image block must reference a durably
          // committed object by the time the tool/result event is appended.
          ref = await store.saveImage({
            data: decoded.data,
            mediaType: decoded.mediaType,
            name: `generated-${images.length + 1}${EXTENSIONS[decoded.mediaType]}`,
          })
        } catch (error: unknown) {
          throw attachmentFailure(error, decoded.mediaType)
        }
        const path = outputDir === undefined
          ? undefined
          : await writeWorkspaceCopy(outputDir, ref, decoded.data)
        images.push({
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
          ...path === undefined ? {} : { path },
          ...ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } },
        })
      }
      return {
        model: outcome.model,
        prompt: args.prompt,
        images,
        ...args.imagePath === undefined ? {} : { source: args.imagePath },
      }
    },
    presentCall(raw: unknown): unknown {
      const prompt = typeof raw === 'object' && raw !== null ? (raw as { prompt?: unknown }).prompt : undefined
      const title = typeof prompt === 'string' && prompt.length > 0
        ? `Generate image: ${prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt}`
        : 'Generate image'
      return { card: 'generic', title }
    },
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-cycle-image-gen'

/** Services required before the tool can register. */
export const inject = ['tools']

/**
 * Register the `generate_image` tool, and the `image-gen` settings section a
 * Web settings surface edits.
 *
 * Registration waits for the attachment store, because a tool that cannot
 * durably commit image bytes could not return an `image` block at all. An
 * unconfigured `baseUrl` does not suppress registration: the tool stays
 * visible and reports the missing field on use, which keeps a default
 * composition bootable while still failing loud at the earliest point the
 * value is actually needed. The settings service is read optionally, so a
 * deployment that mounts none keeps the Loader row as the whole configuration.
 * @param ctx - the plugin context, carrying the tool registry.
 * @param config - the `config` object of this plugin's Loader row, already validated and defaulted by Cordis from the exported `Config` schema; the settings section layers over it.
 */
export function apply(ctx: PluginContextLike, config: ImageGenConfig = {}): void {
  const entry = config
  // The settings section writes through this thunk: the Loader row stays the
  // composition base, so a deployment that configures nothing new keeps the
  // configuration it always had, while a committed settings change replaces it
  // for every later call.
  let source: () => ImageGenConfig = () => entry
  let resolved = resolveConfig(entry)
  const adopt = (): void => {
    try {
      resolved = resolveConfig(source())
    } catch (error: unknown) {
      // The write already committed, so a section this plugin cannot act on
      // keeps the last good configuration and names what to fix rather than
      // failing the commit that carried it.
      ctx.logger?.warn(
        'dsh-cycle-image-gen: keeping the previous image configuration — '
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as SettingsLike | undefined
    if (settings === undefined) return
    settings.installSection(ctx, IMAGE_GEN_SETTINGS_NAMESPACE, ImageGenConfigSchema, entry, {
      setSource: (current) => { source = current },
      onChange: adopt,
    })
  })
  if (resolved.baseUrl === undefined) {
    ctx.logger?.warn(
      'dsh-cycle-image-gen: config.baseUrl is not set, so generate_image will refuse every call; '
      + 'set it on the image-gen card under Settings -> Plugins, or in the profile cordis.patch.yml',
    )
  }
  ctx.inject(['attachments'], (attachmentCtx) => {
    const store = attachmentCtx.get('attachments') as AttachmentStoreLike | undefined
    if (store === undefined) {
      // The injection above guarantees the service, so an absent value means
      // the registry resolved something else under this key: fail loud rather
      // than publish a tool that cannot commit image bytes.
      throw new Error('dsh-cycle-image-gen: the attachments service activated but did not resolve')
    }
    attachmentCtx.tools.register(generateImageTool(ctx, store, () => resolved))
    ctx.logger?.info(
      `dsh-cycle-image-gen: registered ${TOOL_NAME} (model ${resolved.model}, endpoint ${resolved.baseUrl ?? 'unset'})`,
    )
  })
}
