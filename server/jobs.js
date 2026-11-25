import { randomUUID } from 'node:crypto'

// Tâches en mémoire : un transfert tourne en arrière-plan, l'interface interroge sa progression.
const jobs = new Map()
const KEEP_MS = 60 * 60 * 1000

export function startJob(work) {
  const job = { id: randomUUID(), status: 'running', progress: null, report: null, error: null, startedAt: new Date().toISOString(), cancelRequested: false }
  jobs.set(job.id, job)
  const hooks = { onProgress: (progress) => { job.progress = progress }, isCancelled: () => job.cancelRequested }
  work(hooks)
    .then((report) => { job.report = report; job.status = 'done' })
    .catch((error) => { job.error = error.message; job.status = 'failed' })
    .finally(() => { job.finishedAt = new Date().toISOString(); setTimeout(() => jobs.delete(job.id), KEEP_MS).unref() })
  return job
}

export const getJob = (id) => jobs.get(id)

export function cancelJob(id) {
  const job = jobs.get(id)
  if (job && job.status === 'running') job.cancelRequested = true
  return job
}

export const publicJob = (job) => ({
  id: job.id, status: job.status, progress: job.progress, report: job.report, error: job.error,
  startedAt: job.startedAt, finishedAt: job.finishedAt, cancelRequested: job.cancelRequested,
})
