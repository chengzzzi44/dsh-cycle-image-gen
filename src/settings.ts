/**
 * The plugin's configuration schema: the Loader-validated `Config` export and
 * the `image-gen` namespace a DSH Web settings surface edits over it.
 *
 * The row stays the composition base, so an existing `cordis.patch.yml`
 * deployment keeps working unchanged and the user layer holds only what a
 * person overrode on the settings page. The tool re-reads the resolved section
 * per call, so a committed change reaches the next image without a restart.
 *
 * @module recycle-image-gen/settings
 */

import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_EDIT_ENDPOINT_PATH,
  DEFAULT_ENDPOINT_PATH,
  DEFAULT_MAX_IMAGES_PER_CALL,
  DEFAULT_MAX_INPUT_IMAGE_BYTES,
  DEFAULT_MODEL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SIZE,
} from './config.ts'

/** Settings namespace this plugin registers, and the key its browser card claims. */
export const IMAGE_GEN_SETTINGS_NAMESPACE = 'image-gen'

/**
 * Schema of the `image-gen` section, and of the Loader row's `config`.
 *
 * Every config field is declared with the default `resolveConfig` would apply,
 * so both readers see the complete effective configuration instead of an
 * undeclared field. The absolute-URL and leading-slash rules are part of the
 * schema, so a wrong value is refused while the plugin loads or the settings
 * write is typed, rather than failing the next image call. `extraHeaders`
 * carries `secret`, because those values are commonly an authorization token
 * and the wire view of a settings section never carries a secret.
 */
export const ImageGenConfigSchema = z.object({
  /** Relay prefix up to and including the version segment, for example `https://relay.example.com/v1`. */
  baseUrl: z.string().pattern(/^https?:\/\//u),
  /** Path appended to `baseUrl` for a generation request. */
  endpointPath: z.string().pattern(/^\//u).default(DEFAULT_ENDPOINT_PATH),
  /** Path appended to `baseUrl` for an edit request, which carries a reference image. */
  editEndpointPath: z.string().pattern(/^\//u).default(DEFAULT_EDIT_ENDPOINT_PATH),
  /** Largest reference image accepted for upload, in bytes. */
  maxInputImageBytes: z.natural().default(DEFAULT_MAX_INPUT_IMAGE_BYTES),
  /** Image model id sent to the relay. */
  model: z.string().default(DEFAULT_MODEL),
  /** Credential reference holding the relay key. */
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  /** Size used when a call omits `size`. */
  defaultSize: z.string().default(DEFAULT_SIZE),
  /** Quality used when a call omits `quality`; absent sends no quality field. */
  defaultQuality: z.string(),
  /** Whole-request budget in milliseconds, including the image download. */
  requestTimeoutMs: z.natural().default(DEFAULT_REQUEST_TIMEOUT_MS),
  /** Upper bound accepted for one call's `n`. */
  maxImagesPerCall: z.natural().default(DEFAULT_MAX_IMAGES_PER_CALL),
  /** Absolute directory receiving one copy of every generated image. */
  outputDir: z.string(),
  /** Relay-specific request body fields. */
  extraBody: z.dict(z.any()),
  /** Relay-specific request headers; secret, because these commonly carry a token. */
  extraHeaders: z.dict(z.string()).role('secret'),
})

/**
 * Cordis plugin config schema. The Loader validates a row's `config` against
 * this export and fills every default before `apply` runs; the same schema is
 * the base layer of the `image-gen` settings section.
 */
export const Config = ImageGenConfigSchema
