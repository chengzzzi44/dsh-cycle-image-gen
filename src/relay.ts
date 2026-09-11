/**
 * Client for an OpenAI-compatible images endpoint. This module owns the wire
 * request, the response decode, and the bytes-to-media-type check; it never
 * touches the attachment store or the tool registry.
 *
 * @module recycle-image-gen/relay
 */

import type { ResolvedImageGenConfig } from './config.ts'

/** The raster formats the attachment service accepts. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** One decoded image returned by the relay. */
export interface DecodedImage {
  /** Exact encoded bytes. */
  data: Uint8Array
  /** Media type verified from the bytes themselves. */
  mediaType: ImageMediaType
  /** Provider-rewritten prompt, when the relay returns one. */
  revisedPrompt?: string
}

/** The settled outcome of one generation request. */
export interface GenerationOutcome {
  /** Model id the relay reported, falling back to the requested one. */
  model: string
  /** Decoded images in response order. */
  images: DecodedImage[]
  /** Provider usage record, passed through for diagnostics. */
  usage?: unknown
}

/** One reference image uploaded with an edit request. */
export interface InputImage {
  /** Exact bytes of the reference image. */
  data: Uint8Array
  /** Media type verified from the bytes themselves. */
  mediaType: ImageMediaType
}

/** One generation request after the tool resolved its arguments. */
export interface GenerationRequest {
  prompt: string
  size?: string
  quality?: string
  background?: string
  n: number
  /**
   * Reference images. A non-empty list routes the request to the edit endpoint
   * as `multipart/form-data`; an empty or absent list uses the JSON generation
   * endpoint.
   */
  inputs?: readonly InputImage[]
  /** Optional mask restricting the edit region; meaningful only with `inputs`. */
  mask?: InputImage
}

/** File extension for each accepted media type. */
const EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/** Longest provider error body carried into a thrown message. */
const MAX_ERROR_BODY = 2_000

/**
 * Join a configured base URL with an endpoint path.
 * @param baseUrl - prefix ending at the version segment, without a trailing slash.
 * @param endpointPath - path beginning with `/`.
 * @returns the absolute request URL.
 */
export function generationUrl(baseUrl: string, endpointPath: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${endpointPath}`
}

/**
 * Identify the media type from the file signature, which stays authoritative
 * over any content type the relay declares.
 * @param data - decoded image bytes.
 * @returns the detected media type, or undefined for other bytes.
 */
export function sniffMediaType(data: Uint8Array): ImageMediaType | undefined {
  const starts = (offset: number, bytes: readonly number[]): boolean => {
    if (data.byteLength < offset + bytes.length) return false
    return bytes.every((byte, index) => data[offset + index] === byte)
  }
  const ascii = (offset: number, text: string): boolean => {
    if (data.byteLength < offset + text.length) return false
    for (let index = 0; index < text.length; index += 1) {
      if (data[offset + index] !== text.charCodeAt(index)) return false
    }
    return true
  }
  if (starts(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return undefined
}

/** Read a bounded response body for diagnostics. */
async function boundedText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text
  } catch {
    // The body is already gone or unreadable; the status alone still routes.
    return ''
  }
}

/** Extract the provider's own message from an error body when it is JSON. */
function providerMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const error = (parsed as { error?: unknown }).error
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string') return message
    }
    const message = (parsed as { message?: unknown }).message
    return typeof message === 'string' ? message : undefined
  } catch {
    // A non-JSON body is reported verbatim by the caller.
    return undefined
  }
}

/** Turn a non-2xx response into an actionable error naming the request that failed. */
async function requestFailure(response: Response, context: { url: string, model: string }): Promise<Error> {
  const body = await boundedText(response)
  const detail = providerMessage(body) ?? body
  const parts = [
    `recycle-image-gen: the relay returned HTTP ${response.status} ${response.statusText}`.trim()
    + ` for model "${context.model}" at ${context.url}`,
  ]
  if (detail.length > 0) parts.push(detail)
  if (response.status === 401 || response.status === 403) {
    parts.push('The credential is missing, expired, or not accepted by this relay; check config.apiKeyEnv and the stored value.')
  }
  if (response.status === 404) {
    parts.push('A 404 usually means the configured endpoint path does not exist on the relay; check config.endpointPath and config.editEndpointPath.')
  }
  if (response.status === 502 || response.status === 503) {
    parts.push('A gateway error usually means the relay rejected the request upstream; an unknown model id is the common cause, so compare config.model against the ids the relay lists.')
  }
  return new Error(parts.join(' — '))
}

/** Decode one `data[]` entry, downloading it when the relay answered with a URL. */
async function decodeEntry(
  entry: Record<string, unknown>,
  requestSignal: AbortSignal,
): Promise<DecodedImage> {
  let bytes: Uint8Array
  if (typeof entry.b64_json === 'string' && entry.b64_json.length > 0) {
    bytes = Buffer.from(entry.b64_json, 'base64')
  } else if (typeof entry.url === 'string' && entry.url.length > 0) {
    // The image URL is fetched without the relay credential: it routinely
    // points at a different host, and sending the key there would leak it.
    const download = await fetch(entry.url, { signal: requestSignal })
    if (!download.ok) {
      throw new Error(`recycle-image-gen: the relay returned an image URL that failed to download (HTTP ${download.status})`)
    }
    bytes = new Uint8Array(await download.arrayBuffer())
  } else {
    throw new Error('recycle-image-gen: the relay returned a data entry with neither "b64_json" nor "url"')
  }
  const mediaType = sniffMediaType(bytes)
  if (mediaType === undefined) {
    throw new Error('recycle-image-gen: the relay returned bytes that are not a PNG, JPEG, WebP, or GIF image')
  }
  const revised = entry.revised_prompt
  return {
    data: bytes,
    mediaType,
    ...typeof revised === 'string' && revised.length > 0 ? { revisedPrompt: revised } : {},
  }
}

/**
 * Copy image bytes into a plain `ArrayBuffer` for a multipart part.
 *
 * `BlobPart` accepts only an `ArrayBuffer`-backed view, while the bytes handed
 * to this module are typed over `ArrayBufferLike`; the copy makes the
 * distinction real instead of asserting it away.
 * @param data - exact image bytes.
 * @returns an `ArrayBuffer` holding the same bytes.
 */
function blobPart(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength)
  new Uint8Array(copy).set(data)
  return copy
}

/**
 * Build the multipart body for an edit request.
 * @param config - resolved plugin configuration.
 * @param request - the resolved generation arguments.
 * @param quality - effective quality, already falling back to the configured default.
 * @param size - effective size, already falling back to the configured default.
 * @param inputs - reference images; never empty on this path.
 * @returns the multipart form carrying the reference images.
 */
function editForm(
  config: ResolvedImageGenConfig,
  request: GenerationRequest,
  quality: string | undefined,
  size: string,
  inputs: readonly InputImage[],
): FormData {
  const form = new FormData()
  form.set('model', config.model)
  form.set('prompt', request.prompt)
  form.set('n', String(request.n))
  form.set('size', size)
  if (quality !== undefined) form.set('quality', quality)
  if (request.background !== undefined) form.set('background', request.background)
  // A multipart field carries text, so a structured `extraBody` entry has no
  // representation here; only the JSON generation path can send one.
  for (const [key, value] of Object.entries(config.extraBody)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      form.set(key, String(value))
    }
  }
  for (const [index, input] of inputs.entries()) {
    form.append('image', new Blob([blobPart(input.data)], { type: input.mediaType }), `input-${index + 1}${EXTENSIONS[input.mediaType]}`)
  }
  if (request.mask !== undefined) {
    form.append('mask', new Blob([blobPart(request.mask.data)], { type: request.mask.mediaType }), `mask${EXTENSIONS[request.mask.mediaType]}`)
  }
  return form
}

/**
 * Headers for the multipart path. `fetch` must own the content type so the
 * boundary matches the body it serializes, so a configured `content-type` is
 * dropped rather than corrupting the request.
 * @param extraHeaders - configured additional headers.
 * @param apiKey - relay credential.
 * @returns the request headers.
 */
function multipartHeaders(extraHeaders: Record<string, string>, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` }
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (key.toLowerCase() === 'content-type') continue
    headers[key] = value
  }
  return headers
}

/**
 * Perform one generation or edit request and decode every returned image.
 *
 * A missing `baseUrl` is a caller error the tool reports before reaching here.
 * @param config - resolved plugin configuration.
 * @param apiKey - relay credential.
 * @param request - the resolved generation arguments.
 * @param signal - caller cancellation; combined with the configured timeout.
 * @returns the decoded images plus the model id the relay reported.
 * @throws {Error} on transport failure, a non-2xx status, or an undecodable response.
 */
export async function requestImages(
  config: ResolvedImageGenConfig,
  apiKey: string,
  request: GenerationRequest,
  signal: AbortSignal | undefined,
): Promise<GenerationOutcome> {
  if (config.baseUrl === undefined) {
    throw new Error('recycle-image-gen: config.baseUrl is not set, so no relay endpoint is known')
  }
  const quality = request.quality ?? config.defaultQuality
  const size = request.size ?? config.defaultSize
  const inputs = request.inputs ?? []
  const editing = inputs.length > 0

  // `AbortSignal.any` keeps the caller's cancellation and the timeout
  // independent: whichever fires first aborts the request, and the caller's
  // signal is never consumed by this call.
  const timeout = AbortSignal.timeout(config.requestTimeoutMs)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  const endpoint = editing ? config.editEndpointPath : config.endpointPath
  const url = generationUrl(config.baseUrl, endpoint)
  const response = editing
    ? await fetch(url, {
      method: 'POST',
      headers: multipartHeaders(config.extraHeaders, apiKey),
      body: editForm(config, request, quality, size, inputs),
      signal: requestSignal,
    })
    : await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
        ...config.extraHeaders,
      },
      body: JSON.stringify({
        model: config.model,
        prompt: request.prompt,
        n: request.n,
        size,
        ...config.extraBody,
        ...quality === undefined ? {} : { quality },
        ...request.background === undefined ? {} : { background: request.background },
      }),
      signal: requestSignal,
    })
  if (!response.ok) throw await requestFailure(response, { url, model: config.model })

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error: unknown) {
    throw new Error('recycle-image-gen: the relay returned a body that is not JSON', { cause: error })
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('recycle-image-gen: the relay returned a body that is not a JSON object')
  }
  const record = payload as Record<string, unknown>
  const data = record.data
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('recycle-image-gen: the relay returned no "data" array of images')
  }
  const images: DecodedImage[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('recycle-image-gen: the relay returned a non-object entry in "data"')
    }
    images.push(await decodeEntry(entry as Record<string, unknown>, requestSignal))
  }
  const reported = record.model
  return {
    model: typeof reported === 'string' && reported.length > 0 ? reported : config.model,
    images,
    ...record.usage === undefined ? {} : { usage: record.usage },
  }
}
