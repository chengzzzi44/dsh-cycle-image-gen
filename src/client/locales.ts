/**
 * The plugin's locale dictionaries: every product-visible string the browser
 * half renders, in the two languages the plugin ships.
 *
 * The browser half registers this namespace through `ctx.locale.register` and
 * puts the standard `t` seat on each slot registration with `locale: NS`, so a
 * language switch re-renders the cards without a reload.
 *
 * @module dsh-cycle-image-gen/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'dsh-cycle-image-gen'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'tool.generate': '生成图片',
  'tool.edit': '编辑图片',
  'tool.from': '来自 {source}',
  'tool.generating': '生成中…',
  'tool.empty': '没有返回图片。',
  'tool.failed': '图片请求失败。',
  'image.loading': '图片加载中…',
  'image.unavailable': '图片不可用（{mediaType}）',
  'image.alt': '生成的图片',
  'imageTab.failed': '图片读取失败。',
  'tail.single': '生成的图片',
  'tail.many': '生成的图片（{count} 张）',
  'tail.open': '打开 {path}',
  'card.title': 'dsh-cycle-image-gen',
  'card.description': 'generate_image 使用的接口地址、模型与密钥。',
  'card.url': '接口地址',
  'card.urlHint': '到版本段为止，例如 https://relay.example.com/v1',
  'card.model': '模型',
  'card.modelHint': '发送给中转站的模型 id',
  'card.key': '接口密钥',
  'card.keyHint': '保存在凭据域，不回显',
  'card.keySet': '已配置',
  'card.keyUnset': '未配置',
  'card.unsaved': '未保存',
  'card.expand': '展开设置',
  'card.collapse': '收起设置',
  'card.disclosure': '{action}：{title}',
  'card.readOnly': '本部署的设置为只读。',
  'card.save': '保存',
  'card.saving': '保存中…',
  'card.discard': '放弃修改',
  'card.reset': '恢复默认',
  'card.overridden': '已覆盖',
  'card.saved': '已保存。',
  'card.failed': '保存失败：{detail}',
  'card.noCredentials': '此部署没有提供凭据服务，密钥无法写入。',
  'card.keyEnvLocked': '密钥当前来自启动进程的环境变量，界面不能覆盖它；不再从环境提供后就能在这里填写',
  'card.keyUnavailable': '此部署没有提供可写的凭据服务，密钥请写到环境变量或 $DSH_HOME/.env',
}

/** English dictionary (same key set). */
export const en: Record<LocaleKey, string> = {
  'tool.generate': 'Generate image',
  'tool.edit': 'Edit image',
  'tool.from': 'from {source}',
  'tool.generating': 'Generating…',
  'tool.empty': 'No images were returned.',
  'tool.failed': 'The image request failed.',
  'image.loading': 'Loading image…',
  'image.unavailable': 'Image unavailable ({mediaType})',
  'image.alt': 'Generated image',
  'imageTab.failed': 'The image could not be read.',
  'tail.single': 'Generated image',
  'tail.many': 'Generated images ({count})',
  'tail.open': 'Open {path}',
  'card.title': 'dsh-cycle-image-gen',
  'card.description': 'Endpoint, model, and key used by generate_image.',
  'card.url': 'Endpoint',
  'card.urlHint': 'Up to the version segment, for example https://relay.example.com/v1',
  'card.model': 'Model',
  'card.modelHint': 'Model id sent to the relay',
  'card.key': 'API key',
  'card.keyHint': 'Stored in the credentials domain, never echoed back',
  'card.keySet': 'configured',
  'card.keyUnset': 'unset',
  'card.unsaved': 'Unsaved',
  'card.expand': 'Show settings',
  'card.collapse': 'Hide settings',
  'card.disclosure': '{action}: {title}',
  'card.readOnly': 'This deployment stores settings read-only.',
  'card.save': 'Save',
  'card.saving': 'Saving…',
  'card.discard': 'Discard',
  'card.reset': 'Reset',
  'card.overridden': 'overridden',
  'card.saved': 'Saved.',
  'card.failed': 'Save failed: {detail}',
  'card.noCredentials': 'This deployment serves no credentials domain, so the key cannot be written.',
  'card.keyEnvLocked': 'The key comes from the launching process environment, which this page cannot override; stop providing it there to set one here',
  'card.keyUnavailable': 'This deployment serves no writable credentials domain; store the key in the environment or $DSH_HOME/.env',
}

/** Union of this namespace's dictionary keys. */
export type LocaleKey = keyof typeof zh

/** The `t` seat every registration with `locale: NS` receives. */
export type Translate = (key: LocaleKey, params?: Readonly<Record<string, string | number>>) => string
