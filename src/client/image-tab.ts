/**
 * The right-Sidebar tab type that displays one workspace image.
 *
 * `openFile` addresses a file as a `dsh-resource://file/…` resource and lets the
 * Sidebar pick the tab type that claims it. The shipped text preview claims
 * every file address at the fallback band and refuses anything it cannot read
 * as text, so an image opened there fails. This type registers at the extension
 * band, claims only image paths, and reads the bytes through the workspace-files
 * Remote — which is how a generated image's workspace copy becomes viewable
 * beside the conversation.
 *
 * @module recycle-image-gen/client/image-tab
 */

/** This type's identity in the tab system: the key its body registers under. */
export const IMAGE_TAB_ID = 'recycle-image-gen/image'

/** The tab kind this package owns. */
export const IMAGE_TAB_KIND = 'image'

/** Longest image this tab loads into memory, in bytes. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

/** Media type per accepted extension. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** A parsed `dsh-resource://file/…` address. */
export interface FileAddress {
  /** Session named by a `session` address; absent for an `absolute` one. */
  sessionId?: string
  /** The path to hand the workspace-files endpoint. */
  path: string
}

/**
 * Parse the `dsh-resource://file/…` grammar this type is addressed with, using
 * the same segment decoding as the address builder.
 * @param address - the resource address.
 * @returns the scope's session and path, or undefined for anything else.
 */
export function parseFileAddress(address: string): FileAddress | undefined {
  try {
    const url = new URL(address)
    if (url.protocol !== 'dsh-resource:' || url.host !== 'file') return undefined
    const [, scope, ...rest] = url.pathname.split('/')
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (id === undefined || id === '' || segments.length === 0) return undefined
      return { sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
    }
    if (scope === 'absolute') {
      const unc = rest[0] === '' && rest.length > 1
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
      if (segments.length === 0 || segments[0] === '') return undefined
      if (unc) return { path: `//${segments.join('/')}` }
      return { path: `/${segments.join('/')}` }
    }
    return undefined
  } catch {
    // `new URL` throws on a non-URL and `decodeURIComponent` on a malformed
    // escape; both mean "not a file address".
    return undefined
  }
}

/**
 * The media type one path's extension names.
 * @param path - a file path.
 * @returns the media type, or undefined for a non-image extension.
 */
export function imageMediaTypeOf(path: string): string | undefined {
  const match = /\.([A-Za-z0-9]+)$/u.exec(path)
  return match === null ? undefined : MEDIA_TYPES[match[1]?.toLowerCase() ?? '']
}

/**
 * The tab chip text for one address: its decoded last segment.
 * @param address - a resource address.
 * @returns the basename, or the address when it has none.
 */
export function basenameOf(address: string): string {
  const name = address.slice(address.lastIndexOf('/') + 1)
  if (name === '') return address
  try {
    return decodeURIComponent(name)
  } catch {
    // A malformed escape is still a name; showing it raw beats refusing the address.
    return name
  }
}

/** The registry definition this plugin contributes. */
export interface ImageTabDefinitionLike {
  id: string
  kind: string
  patterns: readonly string[]
  priority: string
  canOpen(address: string): boolean
  title(address: string): string
}

/**
 * The image type's registry definition: every file address whose path names an
 * image, at the extension band so it outranks the shipped text fallback.
 * @returns the definition to register.
 */
export function imageTabDefinition(): ImageTabDefinitionLike {
  return {
    id: IMAGE_TAB_ID,
    kind: IMAGE_TAB_KIND,
    patterns: ['dsh-resource://file/**'],
    priority: 'extension',
    canOpen: address => {
      const parsed = parseFileAddress(address)
      return parsed !== undefined && imageMediaTypeOf(parsed.path) !== undefined
    },
    title: basenameOf,
  }
}

/** Structural view of the workspace-files Remote namespace this tab reads through. */
export interface WorkspaceFilesRemoteLike {
  readBytes(
    sessionId: string,
    path: string,
    range: { offset?: number },
    signal?: AbortSignal,
  ): Promise<{ ok?: boolean, value?: { data?: string, eof?: boolean, bytes?: number } }>
}

/** Decode one base64 window into bytes. */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * Read one workspace image completely through the paged byte read.
 *
 * The endpoint caps each window, so this walks windows until the file reports
 * EOF. A file past {@link MAX_IMAGE_BYTES} is refused rather than accumulated.
 * @param remote - the workspace-files Remote namespace.
 * @param sessionId - the session whose workspace confines the read.
 * @param path - workspace path, absolute or relative to the workspace root.
 * @param signal - the tab record's lifetime.
 * @returns the exact bytes plus the media type its extension names.
 * @throws {Error} when the path is not an image, the read fails, or the file is too large.
 */
export async function loadWorkspaceImage(
  remote: WorkspaceFilesRemoteLike,
  sessionId: string,
  path: string,
  signal: AbortSignal,
): Promise<{ data: Uint8Array, mediaType: string }> {
  const mediaType = imageMediaTypeOf(path)
  if (mediaType === undefined) {
    throw new Error(`recycle-image-gen: "${path}" is not an image path this tab can display`)
  }
  const chunks: Uint8Array[] = []
  let offset = 0
  let total = 0
  for (;;) {
    const result = await remote.readBytes(sessionId, path, { offset }, signal)
    if (result.ok === false || result.value === undefined) {
      const failure = (result as { error?: { code?: string, message?: string } }).error
      const detail = failure?.message ?? failure?.code ?? 'read failed'
      throw new Error(`${detail} (workspace path "${path}")`)
    }
    const chunk = decodeBase64(result.value.data ?? '')
    if (chunk.length === 0) break
    chunks.push(chunk)
    total += chunk.length
    if (result.value.eof === true) break
    if (total > MAX_IMAGE_BYTES) {
      throw new Error(`recycle-image-gen: "${path}" is larger than the ${MAX_IMAGE_BYTES}-byte viewer limit`)
    }
    offset += chunk.length
  }
  const data = new Uint8Array(total)
  let written = 0
  for (const chunk of chunks) {
    data.set(chunk, written)
    written += chunk.length
  }
  return { data, mediaType }
}
