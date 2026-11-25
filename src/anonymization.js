export const METHODS = [
  { value: '', label: 'Copier telle quelle' },
  { value: 'exclude', label: 'Exclure' },
  { value: 'null', label: 'Vider (NULL)' },
  { value: 'hash', label: 'Hacher' },
  { value: 'mask', label: 'Masquer' },
  { value: 'fake', label: 'Valeur fictive' },
]

// Colonnes probablement personnelles ou secrètes, d'après leur nom.
const SUGGESTIONS = [
  [/password|passwd|pwd|secret|token|api_?key/i, 'hash'],
  [/e-?mail/i, 'fake'],
  [/phone|t[eé]l[eé]phone|mobile|portable|fax/i, 'fake'],
  [/(^|_)ip(_|$)|ip_?address/i, 'fake'],
  [/first_?name|last_?name|(^|_)nom($|_)|pr[eé]nom|surname|full_?name/i, 'fake'],
  [/address|adresse|street|(^|_)rue($|_)|postal|zip|city|ville/i, 'fake'],
  [/birth|naissance|iban|bic|nir|ssn|secu/i, 'null'],
  [/user_?agent|payload/i, 'null'],
]

export function suggestRule(column) {
  if (column.primary) return null
  for (const [pattern, method] of SUGGESTIONS) {
    if (pattern.test(column.name)) return method === 'null' && !column.nullable ? 'fake' : method
  }
  return null
}
