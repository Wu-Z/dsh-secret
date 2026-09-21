/**
 * A one-line Chinese description for a credential name.
 *
 * The store holds names and values only, so neither surface has anything
 * human-readable to show. Descriptions are therefore DERIVED: a small table for
 * well-known public services, then a suffix rule that turns any other
 * name into a readable phrase. Nothing here is authoritative — it is a label,
 * never a fact any code relies on, and an unrecognized name yields no label
 * rather than a guess.
 */

/** Names worth spelling out properly. */
const KNOWN = {
  DEEPSEEK_API_KEY: 'DeepSeek 平台 API 密钥（模型调用）',
  MOONSHOT_API_KEY: 'Moonshot（月之暗面）API 密钥',
  OPENAI_API_KEY: 'OpenAI API 密钥',
}

/** Suffix → what such a credential holds. First match wins. */
const SUFFIXES = [
  [/_API_KEY$/, 'API 密钥'],
  [/_KEY$/, '密钥'],
  [/_ACCESS_TOKEN$/, '访问令牌'],
  [/_BOT_TOKEN$/, '机器人令牌'],
  [/_TOKEN$/, '令牌'],
  [/_PASSWORD$/, '密码'],
  [/_PASSWD$/, '密码'],
  [/_PASS$/, '密码'],
  [/_SECRET$/, '密钥'],
  [/_PRIVATE_KEY$/, '私钥'],
  [/_SSH_KEY$/, 'SSH 私钥'],
  [/_HOSTNAME$/, '主机名'],
  [/_HOST$/, '主机地址'],
  [/_USERNAME$/, '用户名'],
  [/_USER$/, '用户名'],
  [/_ENDPOINT$/, '接口地址'],
  [/_URL$/, '访问地址'],
  [/_PORT$/, '端口'],
  [/_DATABASE$/, '数据库名'],
  [/_DB$/, '数据库'],
  [/_EMAIL$/, '邮箱'],
  [/_ACCOUNT$/, '账号'],
  [/_ID$/, '标识'],
]

/** Prefix spellings worth capitalizing correctly. */
const BRANDS = {
  DEEPSEEK: 'DeepSeek', MOONSHOT: 'Moonshot', VPS: 'VPS', DSH: 'DSH',
  OPENAI: 'OpenAI', GITHUB: 'GitHub', ANTHROPIC: 'Anthropic', WEIXIN: '微信',
}

/**
 * Describe one credential name in Chinese.
 *
 * @param name - the credential (environment-variable) name.
 * @returns the description, or `''` when the name carries no recognized shape.
 */
export function describeRef(name) {
  const ref = String(name ?? '').trim()
  if (ref === '') return ''
  const known = KNOWN[ref]
  if (known !== undefined) return known
  for (const [pattern, label] of SUFFIXES) {
    if (!pattern.test(ref)) continue
    const owner = ref.replace(pattern, '')
    if (owner === '') return label
    const words = owner.split('_').filter(Boolean).map(word => BRANDS[word] ?? word)
    // "FOO 的 API 密钥" reads right with a space before a Latin label, while
    // "BAR 的机器人令牌" does not want one before a Chinese one.
    return `${words.join(' ')}${/^[A-Za-z]/.test(label) ? ' 的 ' : ' 的'}${label}`
  }
  return ''
}
