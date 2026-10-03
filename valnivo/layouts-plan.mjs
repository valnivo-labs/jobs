/**
 * What the layouts job does with what people sent (2026-10-03): pure, so `tests/layoutsJob.test.ts` can
 * hold it, and copied unchanged to valnivo-labs/jobs, where it runs in public.
 *
 *  · **Publish** a taught layout only when at least `AGREEING` submissions agree on it — the same redacted
 *    headings, the same place for the date, columns within ten points — and **every word of its headings is
 *    in the vocabulary** (`valnivo/vocabulary.json`, generated from the app's redaction list). A heading
 *    that slipped past a device's redaction cannot be published by sending it three times.
 *  · **Delete** every submission older than `KEEP_DAYS`, and every daily count from a day that is over.
 *  · **Say** only counts. The run's log is public; no text, bank name or heading of an unpublished layout
 *    is ever printed.
 */
export const AGREEING = 3
export const KEEP_DAYS = 90

const DAY = 24 * 60 * 60 * 1000

/** The rules' day, from a date in UTC: "2026-10-3". */
export const ruleDay = (d) => `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`

/** Whether a redacted heading may be published: two known words or more, and nothing outside the vocabulary. */
export function publishableHeader(header, vocabulary) {
  const words = String(header).split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 16) return false
  if (!words.every((w) => vocabulary.has(w))) return false
  return words.filter((w) => w !== 'xxx').length >= 2
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * submissions: [{ id, kind, createdAt: Date, header?, dateAt?, dateX?, amountX?, country? }]
 * quotas: [{ id, day }]
 * published: the layouts already in valnivo/layouts.json.
 */
export function planLayouts({ submissions, quotas, published, vocabulary, now }) {
  const expired = submissions.filter((s) => now.getTime() - s.createdAt.getTime() > KEEP_DAYS * DAY).map((s) => s.id)
  const staleQuotas = quotas.filter((q) => q.day !== ruleDay(now)).map((q) => q.id)

  const groups = new Map()
  for (const s of submissions) {
    if (s.kind !== 'taught') continue
    const key = `${s.header}|${s.dateAt}|${Math.round(s.dateX / 10)}|${Math.round(s.amountX / 10)}`
    const group = groups.get(key) ?? []
    group.push(s)
    groups.set(key, group)
  }
  const layouts = new Map(published.map((l) => [`${l.header}|${l.dateAt}`, l]))
  let added = 0
  let held = 0
  for (const group of groups.values()) {
    const first = group[0]
    if (group.length < AGREEING || !publishableHeader(first.header, vocabulary)) {
      held++
      continue
    }
    const key = `${first.header}|${first.dateAt}`
    const seen = group.map((s) => s.createdAt.toISOString().slice(0, 10)).sort()
    const before = layouts.get(key)
    if (!before) added++
    layouts.set(key, {
      header: first.header,
      dateAt: first.dateAt,
      dateX: median(group.map((s) => s.dateX)),
      amountX: median(group.map((s) => s.amountX)),
      agreeing: Math.max(group.length, before?.agreeing ?? 0),
      firstSeen: before?.firstSeen ?? seen[0],
    })
  }

  const byCountry = {}
  for (const s of submissions) if (s.kind === 'layout') byCountry[s.country || '?'] = (byCountry[s.country || '?'] ?? 0) + 1

  return {
    layouts: [...layouts.values()].sort((a, b) => a.header.localeCompare(b.header) || a.dateAt.localeCompare(b.dateAt)),
    expired,
    staleQuotas,
    summary: {
      submissions: submissions.length,
      layoutTexts: submissions.filter((s) => s.kind === 'layout').length,
      taught: submissions.filter((s) => s.kind === 'taught').length,
      published: layouts.size,
      newlyPublished: added,
      taughtNotYetAgreed: held,
      layoutTextsByCountry: byCountry,
      deleted: expired.length,
      countsCleared: staleQuotas.length,
    },
  }
}
