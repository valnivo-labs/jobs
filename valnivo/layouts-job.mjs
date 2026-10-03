#!/usr/bin/env node
/**
 * The layouts job (2026-10-03), run daily by valnivo-labs/jobs (`valnivo/layouts.yml`) and by hand here with
 * a gcloud sign-in. It reads `layoutSubmissions` and `layoutQuota`, writes `valnivo/layouts.json` beside it,
 * deletes what has expired, and prints "ok" or an error's code — its log is public. See `tools/layouts-plan.mjs`.
 *
 *   node tools/layouts-job.mjs <path to layouts.json> <path to vocabulary.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { adminCredential } from './admin-credential.mjs'
import { planLayouts } from './layouts-plan.mjs'

// A public log: an unexpected error is reported by its code alone, never with a path or a value.
const quiet = (err) => {
  console.error(`layouts: failed (${err?.code ?? err?.name ?? 'error'})`)
  process.exit(1)
}
process.on('uncaughtException', quiet)
process.on('unhandledRejection', quiet)

const [layoutsPath, vocabularyPath] = process.argv.slice(2)
if (!layoutsPath || !vocabularyPath) quiet({ name: 'usage' })

const admin = await adminCredential()
if (!admin) quiet({ name: 'no-credential' })
initializeApp({ credential: admin.credential, projectId: admin.projectId })
const db = getFirestore()

const subs = await db.collection('layoutSubmissions').get()
const quotas = await db.collection('layoutQuota').get()
const published = JSON.parse(readFileSync(layoutsPath, 'utf8')).layouts ?? []
const vocabulary = new Set(JSON.parse(readFileSync(vocabularyPath, 'utf8')))

const plan = planLayouts({
  submissions: subs.docs.map((d) => {
    const x = d.data()
    return { id: d.id, kind: x.kind, createdAt: x.createdAt?.toDate?.() ?? new Date(0), header: x.header, dateAt: x.dateAt, dateX: x.dateX, amountX: x.amountX, country: x.country }
  }),
  quotas: quotas.docs.map((d) => ({ id: d.id, day: d.data().day })),
  published,
  vocabulary,
  now: new Date(),
})

writeFileSync(layoutsPath, JSON.stringify({ format: 1, layouts: plan.layouts }, null, 2) + '\n')
for (const id of plan.expired) await db.collection('layoutSubmissions').doc(id).delete()
for (const id of plan.staleQuotas) await db.collection('layoutQuota').doc(id).delete()

// Counts stay Valnivo's: the public log says it ran (`npm run layouts:inbox` shows them, from this machine).
console.log('layouts: ok')
