import { createHash } from 'node:crypto'
import { parseTemporal, toUtc } from './types.js'

const MOD = 1n << 128n

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
  return value
}

function normalizeNumber(value) {
  let text = String(value).trim()
  if (/e/i.test(text)) text = String(Number(text))
  text = text.replace(/^\+/, '')
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  text = text.replace(/^(-?)0+(?=\d)/, '$1')
  return text === '-0' ? '0' : text
}

const fraction = (frac) => `${(frac || '').replace('.', '')}000000`.slice(0, 6)

// Ramène une valeur à une forme comparable entre moteurs, d'après le type canonique de la source :
// un booléen devenu NUMBER(1), un horodatage converti en UTC ou un décimal complété de zéros restent égaux.
export function normalizeForCompare(value, type, { emptyIsNull = false } = {}) {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') value = value.toString()
  if (value instanceof Uint8Array) return `b:${Buffer.from(value).toString('hex')}`
  switch (type) {
    case 'boolean': return Buffer.isBuffer(value) ? String(Number(value[0] !== 0)) : (value === true || value === 1 || ['1', 't', 'true', 'y'].includes(String(value).toLowerCase()) ? '1' : '0')
    case 'smallint': case 'integer': case 'bigint': case 'decimal': return normalizeNumber(value)
    case 'float': return Number(value).toPrecision(6)
    case 'double': return Number(value).toPrecision(15)
    case 'date': return parseTemporal(value)?.date ?? String(value)
    case 'timestamp': case 'timestamptz': {
      let parts = parseTemporal(value)
      if (!parts) return String(value)
      if (type === 'timestamptz' || parts.offset) parts = toUtc(parts)
      return `${parts.date} ${parts.time || '00:00:00'}.${fraction(parts.frac)}`
    }
    case 'time': {
      const text = value instanceof Date ? value.toISOString().slice(11, 23) : String(value)
      const match = text.match(/^(\d{2}:\d{2}(?::\d{2})?)(\.\d+)?/)
      return match ? `${match[1].length === 5 ? `${match[1]}:00` : match[1]}.${fraction(match[2])}` : text
    }
    case 'json': try { return JSON.stringify(sortKeys(typeof value === 'string' ? JSON.parse(value) : value)) } catch { return String(value) }
    case 'uuid': return String(value).toLowerCase()
    default: {
      const text = value instanceof Date ? value.toISOString() : String(value)
      // Oracle ne distingue pas la chaîne vide de NULL.
      return emptyIsNull && text === '' ? null : text
    }
  }
}

// Empreinte d'un ensemble de lignes indépendante de l'ordre : somme des empreintes de chaque ligne.
export function createDigest(columns, options) {
  let sum = 0n
  let count = 0
  return {
    add(row) {
      const values = columns.map((column) => normalizeForCompare(row[column.key ?? column.name], column.type, options))
      const hash = createHash('sha256').update(JSON.stringify(values)).digest()
      sum = (sum + BigInt(`0x${hash.subarray(0, 16).toString('hex')}`)) % MOD
      count += 1
    },
    result: () => ({ count, hash: sum.toString(16).padStart(32, '0') }),
  }
}
