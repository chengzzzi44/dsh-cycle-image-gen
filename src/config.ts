/**
 * Plugin configuration: the deployment-varying values, all of them settable
 * from `cordis.yml`.
 *
 * @module recycle-image-gen/config
 */

/** Raw `config` object as it arrives from the Loader, before defaults. */
export interface ImageGenConfig {
  /**
   * Full URL prefix up to and including the version segment of the relay, for
   * example `https://relay.example.com/v1`. Unset registers the tool in an
   * unusable state that reports this field on use.
   */
  baseUrl?: string
  /** Path appended to `baseUrl` for the generation request. */
  endpointPath?: string
  /** Path appended to `baseUrl` for an edit request, which carries a reference image. */
  editEndpointPath?: string
  /** Largest reference image accepted for upload, in bytes. */
  maxInputImageBytes?: number
  /** Image model id sent to the relay. */
  model?: string
  /**
   * Credential reference holding the relay API key. Resolved through the
   * credentials service first, then the launching process environment.
   */
  apiKeyEnv?: string
  /** Size used when a call omits `size`. */
  defaultSize?: string
  /** Quality used when a call omits `quality`; omitted from the request when unset. */
  defaultQuality?: string
  /** Whole-request budget in milliseconds, including the image download. */
  requestTimeoutMs?: number
  /** Upper bound accepted for one call's `n`. */
  maxImagesPerCall?: number
  /**
   * Directory receiving one copy of every generated image. An absolute path is
   * used verbatim; a relative path resolves against the calling session's
   * workspace, which is where the Web sidebar and file tools may read it. The
   * attachment store always keeps the durable copy; this copy exists so a
   * person can open or share the file directly.
   */
  outputDir?: string
  /** Extra keys merged into the request body, for relay-specific parameters. */
  extraBody?: Record<string, unknown>
  /** Extra request headers, for relay-specific authentication schemes. */
  extraHeaders?: Record<string, string>
}

/** The configuration after validation and defaulting. */
export interface ResolvedImageGenConfig extends Required<Omit<ImageGenConfig, 'baseUrl' | 'defaultQuality' | 'outputDir' | 'extraBody' | 'extraHeaders'>> {
  baseUrl: string | undefined
  defaultQuality: string | undefined
  outputDir: string | undefined
  extraBody: Record<string, unknown>
  extraHeaders: Record<string, string>
}

/** Default `endpointPath`, the OpenAI-compatible images route. */
export const DEFAULT_ENDPOINT_PATH = '/images/generations'

/** Default `editEndpointPath`, the OpenAI-compatible image-edit route. */
export const DEFAULT_EDIT_ENDPOINT_PATH = '/images/edits'

/** Default cap on one uploaded reference image: 50 MiB, the provider-side edit limit. */
export const DEFAULT_MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024

/** Default credential reference naming the relay key. */
export const DEFAULT_API_KEY_ENV = 'GPT_IMAGE_API_KEY'

/** Default image model id. */
export const DEFAULT_MODEL = 'gpt-image-2.5'

/** Default requested size. */
export const DEFAULT_SIZE = '1024x1024'

/** Default whole-request budget, in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

/** Default and maximum images requested by one call. */
export const DEFAULT_MAX_IMAGES_PER_CALL = 4

/**
 * Reject a config field the caller supplied with the wrong type.
 * @param field - config key, named in the diagnostic.
 * @param value - the supplied value.
 * @param expected - the accepted JavaScript type.
 */
function requireType(field: string, value: unknown, expected: 'string' | 'number' | 'object'): void {
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const ok = expected === 'object' ? actual === 'object' && !Array.isArray(value) : actual === expected
  if (!ok) throw new Error(`recycle-image-gen: config.${field} must be a ${expected}, received ${actual}`)
}

/**
 * Apply defaults and validate the raw config. Every failure is a load-time
 * error naming the offending field, so a typo never survives to the first call.
 * @param raw - the `config` object supplied by the Loader row.
 * @returns the resolved configuration.
 */
export function resolveConfig(raw: ImageGenConfig | undefined): ResolvedImageGenConfig {
  const config = raw ?? {}
  for (const field of ['baseUrl', 'endpointPath', 'editEndpointPath', 'model', 'apiKeyEnv', 'defaultSize', 'defaultQuality', 'outputDir'] as const) {
    if (config[field] !== undefined) requireType(field, config[field], 'string')
  }
  if (config.requestTimeoutMs !== undefined) requireType('requestTimeoutMs', config.requestTimeoutMs, 'number')
  if (config.maxImagesPerCall !== undefined) requireType('maxImagesPerCall', config.maxImagesPerCall, 'number')
  if (config.maxInputImageBytes !== undefined) requireType('maxInputImageBytes', config.maxInputImageBytes, 'number')
  if (config.extraBody !== undefined) requireType('extraBody', config.extraBody, 'object')
  if (config.extraHeaders !== undefined) requireType('extraHeaders', config.extraHeaders, 'object')

  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('recycle-image-gen: config.requestTimeoutMs must be a positive finite number')
  }
  const maxImages = config.maxImagesPerCall ?? DEFAULT_MAX_IMAGES_PER_CALL
  if (!Number.isInteger(maxImages) || maxImages < 1) {
    throw new Error('recycle-image-gen: config.maxImagesPerCall must be a positive integer')
  }
  const endpointPath = config.endpointPath ?? DEFAULT_ENDPOINT_PATH
  if (!endpointPath.startsWith('/')) {
    throw new Error('recycle-image-gen: config.endpointPath must start with "/"')
  }
  const editEndpointPath = config.editEndpointPath ?? DEFAULT_EDIT_ENDPOINT_PATH
  if (!editEndpointPath.startsWith('/')) {
    throw new Error('recycle-image-gen: config.editEndpointPath must start with "/"')
  }
  const maxInputImageBytes = config.maxInputImageBytes ?? DEFAULT_MAX_INPUT_IMAGE_BYTES
  if (!Number.isInteger(maxInputImageBytes) || maxInputImageBytes < 1) {
    throw new Error('recycle-image-gen: config.maxInputImageBytes must be a positive integer')
  }
  if (config.baseUrl !== undefined && !/^https?:\/\//u.test(config.baseUrl)) {
    throw new Error('recycle-image-gen: config.baseUrl must be an absolute http(s) URL')
  }
  return {
    baseUrl: config.baseUrl,
    endpointPath,
    editEndpointPath,
    maxInputImageBytes,
    model: config.model ?? DEFAULT_MODEL,
    apiKeyEnv: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    defaultSize: config.defaultSize ?? DEFAULT_SIZE,
    defaultQuality: config.defaultQuality,
    requestTimeoutMs: timeoutMs,
    maxImagesPerCall: maxImages,
    outputDir: config.outputDir,
    extraBody: { ...config.extraBody },
    extraHeaders: { ...config.extraHeaders },
  }
}
