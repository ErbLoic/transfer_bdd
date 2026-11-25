// Appels à l'API : toutes les réponses d'erreur portent un champ `error` lisible.
export async function api(path, { method = 'POST', body } = {}) {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(data.error || data.reason || 'Une erreur est survenue.'), { data, status: response.status })
  return data
}

export async function download(path, body) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Export impossible.')
  const name = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || 'export'
  const url = URL.createObjectURL(await response.blob())
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  return name
}

// Suit une tâche jusqu'à sa fin.
export function followJob(jobId, onUpdate) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const { job } = await api(`jobs/${jobId}`, { method: 'GET' })
        onUpdate(job)
        if (job.status === 'running') setTimeout(tick, 400)
        else resolve(job)
      } catch (error) { reject(error) }
    }
    tick()
  })
}
