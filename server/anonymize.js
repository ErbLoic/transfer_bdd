import { createHmac, randomBytes } from 'node:crypto'

// Méthodes proposées pour chaque colonne :
// - exclude : colonne non copiée ;
// - null    : valeur vidée (la colonne devient nullable dans la cible) ;
// - hash    : empreinte HMAC, identique pour une même valeur (jointures et unicité préservées) ;
// - mask    : premier caractère conservé, le reste masqué ;
// - fake    : valeur fictive réaliste, déterministe (même entrée → même sortie).
export const METHODS = ['exclude', 'null', 'hash', 'mask', 'fake']

const TEXT_TYPES = ['varchar', 'text', 'uuid', 'json']
const DAY = 86400000

// Une clé aléatoire par transfert : rien ne permet de retrouver les valeurs d'origine après coup.
export function createAnonymizer() {
  const key = randomBytes(32)
  const digest = (value) => createHmac('sha256', key).update(Buffer.isBuffer(value) ? value : String(value)).digest()
  const hex = (value, length = 64) => digest(value).toString('hex').slice(0, length)
  const fit = (text, column) => column.type === 'varchar' && column.length ? text.slice(0, column.length) : text
  const number = (value, max) => Number(digest(value).readBigUInt64BE(0) % BigInt(max))

  const pseudo = (value, column) => {
    switch (column.type) {
      case 'boolean': return digest(value)[0] % 2 === 1
      case 'smallint': return number(value, 32767)
      case 'integer': return number(value, 2147483647)
      case 'bigint': return number(value, Number.MAX_SAFE_INTEGER)
      case 'decimal': {
        const scale = column.scale ?? 0
        const digits = Math.max(1, Math.min(15, (column.precision ?? 18) - scale))
        const integer = number(value, 10 ** digits)
        return scale ? `${integer}.${String(number(`${value}:f`, 10 ** Math.min(scale, 6))).padStart(Math.min(scale, 6), '0')}` : String(integer)
      }
      case 'float': case 'double': return number(value, 1000000) / 100
      case 'date': return new Date(Date.UTC(1970, 0, 1) + number(value, 365 * 50) * DAY).toISOString().slice(0, 10)
      case 'timestamp': case 'timestamptz': return new Date(Date.UTC(1970, 0, 1) + number(value, 365 * 50 * 86400) * 1000).toISOString().replace('T', ' ').replace('Z', '')
      case 'time': return new Date(number(value, 86400) * 1000).toISOString().slice(11, 19)
      case 'binary': return digest(value)
      case 'uuid': { const h = hex(value, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}` }
      case 'json': return JSON.stringify(hex(value, 16))
      default: return null
    }
  }

  const fake = (value, column) => {
    if (!TEXT_TYPES.includes(column.type) || column.type === 'uuid' || column.type === 'json') return pseudo(value, column)
    const name = column.name.toLowerCase()
    const tag = hex(value, 8)
    let text
    if (/mail/.test(name) || /^[^@\s]+@[^@\s]+$/.test(String(value))) text = `user_${tag}@example.invalid`
    else if (/phone|t[eé]l|mobile|portable|fax/.test(name)) { const n = String(number(value, 100000000)).padStart(8, '0'); text = `06${n}` }
    else if (/(^|_)ip(_|$)|ip_?address/.test(name)) text = `192.0.2.${number(value, 254) + 1}`
    else if (/first_?name|prenom|prénom/.test(name)) text = `Prenom${tag.slice(0, 4)}`
    else if (/last_?name|(^|_)nom($|_)|surname/.test(name)) text = `Nom${tag.slice(0, 4)}`
    else if (/(^|_)name$/.test(name)) text = `Personne ${tag.slice(0, 6)}`
    else if (/password|passwd|pwd|secret|token/.test(name)) text = `anonymise_${hex(value, 24)}`
    else if (/address|adresse|street|rue/.test(name)) text = `${number(value, 200) + 1} rue Fictive`
    else if (/user_?agent/.test(name)) text = 'Mozilla/5.0 (anonymise)'
    else text = `${column.name}_${tag}`
    return fit(text, column)
  }

  const apply = (value, column, method) => {
    if (value === null || value === undefined || !method || method === 'exclude') return value
    if (method === 'null') return null
    if (method === 'hash') return TEXT_TYPES.includes(column.type) && !['uuid', 'json'].includes(column.type) ? fit(hex(value), column) : pseudo(value, column)
    if (method === 'mask') {
      if (!TEXT_TYPES.includes(column.type) || ['uuid', 'json'].includes(column.type)) return pseudo(value, column)
      const text = String(value)
      return fit(`${text.slice(0, 1)}${'*'.repeat(Math.max(3, Math.min(text.length - 1, 12)))}`, column)
    }
    if (method === 'fake') return fake(value, column)
    return value
  }

  return { apply }
}

// Règles de colonnes d'une table, sous forme { colonne: méthode } validée.
export function sanitizeRules(rules = {}) {
  return Object.fromEntries(Object.entries(rules || {}).filter(([, method]) => METHODS.includes(method)))
}
