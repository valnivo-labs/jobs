// Sends the push reminders that are due, tells the members of a joint space
// that a co-member recorded something, then deletes both, tells the other
// person on a loan that a step was taken, deletes the shared loan records that
// have been kept long enough, and sweeps the share links whose time has run out.
//
// Runs on a schedule in GitHub Actions (.github/workflows/reminders.yml) with
// the deploy robot's key. It reads the `tickets` collection (a date, a time, a
// generic phrase per person per day), each person's push tokens, and the
// *expiry* of each share link — `select('expiresAt')` means the sealed blob
// never leaves Firestore, so this job could not read a shared projection even
// if it wanted to. It never sees a ledger: those are sealed on the device.
//
//   FIREBASE_SERVICE_ACCOUNT='{...json...}' node tools/send-reminders.mjs
import { initializeApp } from 'firebase-admin/app'
import { adminCredential } from './admin-credential.mjs'
import { Timestamp, getFirestore } from 'firebase-admin/firestore'
import { getMessaging } from 'firebase-admin/messaging'
import { getAuth } from 'firebase-admin/auth'
import { planLoanNotices } from './loan-notices.mjs'
import { UNSIGNED, retentionOf, waitingOn } from './loan-retention.mjs'

// It runs in public (valnivo-labs/jobs), where the log is readable by anybody: an unexpected error is
// reported by its code alone, never with a document path, an account id or a value (2026-10-03).
const quiet = (err) => {
  console.error(`reminders: failed (${err?.code ?? err?.name ?? 'error'})`)
  process.exit(1)
}
process.on('uncaughtException', quiet)
process.on('unhandledRejection', quiet)

const admin = await adminCredential()
if (!admin) {
  console.error('Neither VALNIVO_KEYLESS with FIREBASE_PROJECT nor FIREBASE_SERVICE_ACCOUNT is set')
  process.exit(1)
}
initializeApp({ credential: admin.credential, projectId: admin.projectId })
console.log(`signed in to ${admin.projectId} (${admin.how})`)
const db = getFirestore()
const messaging = getMessaging()

const auth = getAuth()

const goneCache = new Map()
/**
 * Whether an account is known to have been deleted. Only `auth/user-not-found`
 * counts: a refused or failed lookup answers false, so a hiccup deletes nothing —
 * it keeps the loan, and it lets a reminder go as it always did.
 */
async function accountGone(uid) {
  if (!goneCache.has(uid)) {
    try {
      await auth.getUser(uid)
      goneCache.set(uid, false)
    } catch (err) {
      goneCache.set(uid, err?.code === 'auth/user-not-found')
    }
  }
  return goneCache.get(uid)
}

const now = Date.now()
const HOUR = 60 * 60 * 1000
// Due now, and not older than half a day: a ticket the job missed for hours
// is still worth sending the same morning, not the next day.
const due = await db
  .collection('tickets')
  .where('sendAt', '<=', now)
  .where('sendAt', '>', now - 12 * HOUR)
  .get()

let sent = 0
let removedTokens = 0
let orphaned = 0
for (const doc of due.docs) {
  const ticket = doc.data()
  // "Delete my account" removes the tickets and the push tokens itself; this is
  // the second line, for a deletion that stopped half-way or an app older than
  // that. A reminder must never reach somebody whose account is gone.
  if (await accountGone(ticket.uid)) {
    await db.doc(`users/${ticket.uid}/private/push`).delete()
    await doc.ref.delete()
    orphaned++
    continue
  }
  const pushDoc = await db.doc(`users/${ticket.uid}/private/push`).get()
  const tokens = Object.keys(pushDoc.exists ? pushDoc.data().tokens ?? {} : {})
  if (tokens.length === 0) {
    await doc.ref.delete()
    continue
  }
  const result = await messaging.sendEachForMulticast({
    tokens,
    notification: { title: ticket.title, body: ticket.body },
    webpush: {
      notification: { icon: '/icon-192.png', badge: '/icon-192.png', tag: 'lh-push' },
      fcmOptions: { link: 'https://valnivo.eu/' },
    },
  })
  sent += result.successCount
  // Tokens the browser has since dropped are removed, so the list stays clean.
  const stale = {}
  result.responses.forEach((r, i) => {
    const code = r.error?.code ?? ''
    if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
      stale[`tokens.${tokens[i]}`] = null
      removedTokens++
    }
  })
  if (Object.keys(stale).length) {
    const { FieldValue } = await import('firebase-admin/firestore')
    const update = {}
    for (const key of Object.keys(stale)) update[key] = FieldValue.delete()
    await pushDoc.ref.update(update)
  }
  await doc.ref.delete()
}

/**
 * Deletes every reference given, in batches.
 *
 * **A Firestore batch caps at 500 writes and throws past it**, which would fail
 * the whole run — so nothing would be cleaned, and the workflow would send mail
 * about it. The old one-batch version was fine only because nothing had ever
 * accumulated; a share collection that turns over completely every 48 hours is
 * exactly the thing that eventually would.
 */
async function deleteAll(refs) {
  const SIZE = 400
  for (let from = 0; from < refs.length; from += SIZE) {
    const batch = db.batch()
    for (const ref of refs.slice(from, from + SIZE)) batch.delete(ref)
    await batch.commit()
  }
  return refs.length
}

// Tickets that were never sent (no tokens, job outage) do not pile up.
const old = await db.collection('tickets').where('sendAt', '<=', now - 12 * HOUR).get()
await deleteAll(old.docs.map((d) => d.ref))

/*
 * Telling the other members of a joint space (`docs/joint-notifications.md`
 * phase 3).
 *
 * What this job may say is settled by what it can see. It holds an
 * administrative credential and every ledger is sealed, so it knows *that*
 * somebody recorded three things and never *what* they were. That is the whole
 * split the feature rests on, and it is why the generic wording is the only
 * wording built here.
 *
 * **A notice is delivered once and deleted.** The digest starts again from
 * nothing, so a busy day produces a handful of notifications rather than one
 * per entry.
 */
const NOTICE_CAP = 999
const dueNotices = await db
  .collection('spaceNotices')
  .where('sendAt', '<=', now)
  .where('sendAt', '>', now - 12 * HOUR)
  .limit(500)
  .get()

/** The space, read once per space rather than once per notice. */
const spaceCache = new Map()
async function spaceFor(id) {
  if (!spaceCache.has(id)) {
    const doc = await db.doc(`spaces/${id}`).get()
    spaceCache.set(id, doc.exists ? doc.data() : null)
  }
  return spaceCache.get(id)
}

/** "3 entries · 1 regular payment", in the order a reader cares about. */
function describeCounts(counts) {
  const names = { entries: ['entry', 'entries'], plans: ['regular payment', 'regular payments'], budgets: ['budget', 'budgets'], members: ['member change', 'member changes'] }
  const parts = []
  for (const [kind, [one, many]] of Object.entries(names)) {
    const n = Number(counts?.[kind] ?? 0)
    if (n > 0) parts.push(`${n >= NOTICE_CAP ? `${NOTICE_CAP}+` : n} ${n === 1 ? one : many}`)
  }
  return parts.join(' · ')
}

let noticesSent = 0
let noticesDropped = 0
const staleNotices = []
for (const doc of dueNotices.docs) {
  const notice = doc.data()
  const space = await spaceFor(notice.spaceId)
  // A space that is gone, or either person no longer in it. The rule stops a
  // departed member *writing* one; this is the other half — a notice already
  // written when they left must not still be delivered.
  const members = space?.memberIds ?? []
  if (!members.includes(notice.fromUid) || !members.includes(notice.forUid)) {
    staleNotices.push(doc.ref)
    noticesDropped++
    continue
  }
  // And the recipient must still want it: switching the preference off has to
  // stop a notice that was already queued, or "off" would mean "off tomorrow".
  if (space.notify?.[notice.forUid] !== true) {
    staleNotices.push(doc.ref)
    noticesDropped++
    continue
  }

  const pushDoc = await db.doc(`users/${notice.forUid}/private/push`).get()
  const tokenMap = pushDoc.exists ? (pushDoc.data().tokens ?? {}) : {}
  const tokens = Object.keys(tokenMap)
  if (tokens.length === 0) {
    staleNotices.push(doc.ref)
    continue
  }

  // The actor's name comes from the space document, never from the notice:
  // the record has no string field at all, so there is nothing a caller could
  // have put there for us to render.
  const actor = space.members?.[notice.fromUid]?.name ?? ''
  const who = actor.trim().split(/\s+/)[0] || 'Someone'
  const what = describeCounts(notice.counts)
  const title = `${who} recorded something in ${space.name ?? 'your joint space'}`
  const body = what ? `${what}. Open Valnivo to see what changed.` : 'Open Valnivo to see what changed.'

  // Two shapes, because the devices differ and pretending otherwise means one
  // of them shows nothing. A device running our service worker gets a
  // **data-only** message and composes the wording itself from the copy of the
  // ledger it already holds — FCM displays a top-level `notification` block
  // before our code ever runs, so carrying one would defeat that. Everything
  // else, including the Android shell (whose WebView is not a service worker
  // that FCM can wake) and any token saved before `kind` existed, gets the
  // plain form built here.
  const data = {
    valnivo: 'space-notice',
    spaceId: String(notice.spaceId),
    fromUid: String(notice.fromUid),
    date: String(notice.date),
    title,
    body,
  }
  const rich = tokens.filter((t) => tokenMap[t]?.kind === 'web')
  const plain = tokens.filter((t) => tokenMap[t]?.kind !== 'web')

  const sends = []
  if (rich.length) {
    sends.push(
      messaging.sendEachForMulticast({
        tokens: rich,
        data,
        webpush: { fcmOptions: { link: 'https://valnivo.eu/' } },
      }),
    )
  }
  if (plain.length) {
    sends.push(
      messaging.sendEachForMulticast({
        tokens: plain,
        notification: { title, body },
        data,
        webpush: {
          notification: { icon: '/icon-192.png', badge: '/icon-192.png', tag: 'lh-space' },
          fcmOptions: { link: 'https://valnivo.eu/' },
        },
      }),
    )
  }
  for (const result of await Promise.all(sends)) noticesSent += result.successCount
  staleNotices.push(doc.ref)
}
await deleteAll(staleNotices)

// Notices nobody could be sent — no tokens, a job outage, a space deleted —
// do not pile up. Same 12-hour window as the tickets above.
const oldNotices = await db.collection('spaceNotices').where('sendAt', '<=', now - 12 * HOUR).limit(2000).get()
await deleteAll(oldNotices.docs.map((d) => d.ref))

/*
 * Telling the other person about a step on a loan (`docs/agreements.md`
 * phase 8, `tools/loan-notices.mjs`).
 *
 * **Nothing is written for this job to read.** It looks at the loans that
 * moved in the last day and at the entries of their signed history it has not
 * dealt with yet — the act, the role and the account are in the clear because
 * the rules need them; the terms are sealed and never read — and it marks each
 * loan with `notifiedCount`, the one field only this job writes. Entries older
 * than a day when the job first sees them are marked and not sent: a step
 * from last week is not news.
 *
 * **Only a person who asked is told**: `loanNotices: true` on their own
 * `users/{uid}/private/push`, which only they can write, and only on the
 * devices where they turned push on. A proposal is addressed to the address
 * the lender typed, so the account is looked up by that address here — the
 * lender learns nothing from it, and an address with no account, or one whose
 * owner never asked, gets nothing. **That lookup needs a Firebase
 * Authentication read role on the robot** (Viewer — docs/agreements.md §12); a lookup that fails is skipped and counted, and everything after the
 * borrower opens the loan still arrives.
 */
const loansMoved = await db
  .collection('loans')
  .where('updatedAt', '>', Timestamp.fromMillis(now - 24 * HOUR))
  // Only the fields the rules keep in the clear for this: the sealed terms and
  // the wrapped keys never leave Firestore, as `select('expiresAt')` keeps a
  // shared projection there.
  .select('historyCount', 'notifiedCount', 'lenderUid', 'borrowerUid', 'borrowerEmail')
  .limit(500)
  .get()

let loanNoticesSent = 0
let loanNoticesUnresolved = 0
for (const doc of loansMoved.docs) {
  const loan = doc.data()
  const count = Number(loan.historyCount ?? 0)
  const from = Number(loan.notifiedCount ?? 0)
  if (count <= from) continue
  // A repayment's sealed payload is left where it is.
  const history = await doc.ref.collection('history').where('seq', '>=', from).orderBy('seq').select('seq', 'act', 'byUid', 'detail', 'at').get()
  // A step whose server time is more than a day old is marked, not sent.
  const fresh = history.docs.map((d) => d.data()).filter((e) => (e.at?.toMillis?.() ?? 0) > now - 24 * HOUR)
  for (const notice of planLoanNotices({ ...loan, id: doc.id }, fresh)) {
    let uid = notice.to.uid
    if (!uid) {
      try {
        uid = (await auth.getUserByEmail(notice.to.email)).uid
      } catch {
        // No such account, or the robot may not look one up. Either way the
        // lender is not told, and nobody is sent anything.
        loanNoticesUnresolved++
        continue
      }
    }
    const pushDoc = await db.doc(`users/${uid}/private/push`).get()
    const push = pushDoc.exists ? pushDoc.data() : {}
    if (push.loanNotices !== true) continue
    const tokenMap = push.tokens ?? {}
    const tokens = Object.keys(tokenMap)
    if (tokens.length === 0) continue
    const data = { valnivo: 'loan-notice', loanId: String(notice.loanId), title: notice.title, body: notice.body }
    const rich = tokens.filter((t) => tokenMap[t]?.kind === 'web')
    const plain = tokens.filter((t) => tokenMap[t]?.kind !== 'web')
    const sends = []
    if (rich.length) sends.push(messaging.sendEachForMulticast({ tokens: rich, data, webpush: { fcmOptions: { link: 'https://valnivo.eu/#/holdings' } } }))
    if (plain.length) {
      sends.push(
        messaging.sendEachForMulticast({
          tokens: plain,
          notification: { title: notice.title, body: notice.body },
          data,
          webpush: {
            notification: { icon: '/icon-192.png', badge: '/icon-192.png', tag: `lh-loan-${notice.loanId}` },
            fcmOptions: { link: 'https://valnivo.eu/#/holdings' },
          },
        }),
      )
    }
    for (const result of await Promise.all(sends)) loanNoticesSent += result.successCount
  }
  // Marked whether or not anybody was told, so a step is considered once.
  await doc.ref.update({ notifiedCount: count })
}

/*
 * How long a loan is kept (`docs/agreements.md` §7, `tools/loan-retention.mjs`).
 *
 * A proposal nobody signed goes two weeks after it was made, with its history
 * and its seal. A closed loan goes once both people's own copies hold its whole
 * history, with its history — **and its seal stays**, so a signed PDF can still
 * be checked. Only the fields the decision needs are read: never the sealed
 * terms or the wrapped keys. Two single-field queries rather than one with a
 * range, so no composite index is needed; proposals are few, and a closed loan
 * is here only until both copies catch up.
 */
const unsignedLoans = await db.collection('loans').where('status', 'in', UNSIGNED).select('status', 'createdAt', 'termsPrint').limit(500).get()
const closedLoans = await db
  .collection('loans')
  .where('status', '==', 'closed')
  .select('status', 'historyCount', 'caughtUp', 'lenderUid', 'borrowerUid')
  .limit(500)
  .get()
let proposalsDeleted = 0
let closedDeleted = 0
for (const doc of [...unsignedLoans.docs, ...closedLoans.docs]) {
  const loan = doc.data()
  const gone = new Set()
  if (loan.status === 'closed') for (const uid of waitingOn(loan)) if (await accountGone(uid)) gone.add(uid)
  const verdict = retentionOf(loan, now, (uid) => gone.has(uid))
  if (!verdict) continue
  const entries = await doc.ref.collection('history').select().get()
  const refs = [...entries.docs.map((d) => d.ref), doc.ref]
  if (verdict === 'proposal' && typeof loan.termsPrint === 'string' && /^[0-9a-f]{64}$/.test(loan.termsPrint)) {
    refs.push(db.doc(`loanSeals/${loan.termsPrint}`))
  }
  await deleteAll(refs)
  if (verdict === 'proposal') proposalsDeleted++
  else closedDeleted++
}

/*
 * Share links whose life has run out (`docs/sharing.md` phase 7).
 *
 * The rule already refuses to serve an expired share, so this protects nothing:
 * it is storage limitation, and it matters *more* with a 48-hour ceiling than it
 * would with a long-lived link, because the collection turns over completely
 * every two days. Eighteen runs a day means nothing dead outlives its expiry by
 * much more than an hour, even for somebody who never opens the app again.
 *
 * `select('expiresAt')` is load-bearing rather than tidy: without it every dead
 * share's ciphertext would be read into this runner's memory to be thrown away,
 * and the notice's account of what this job can see would stop being true.
 *
 * **Only the public document is swept here, and the reason is the design.** The
 * maker's private record lives at `users/{uid}/shares/{id}`, and the public
 * document deliberately carries no owner — that is what stops a link holder
 * learning whose it is — so this job cannot know which person a dead share
 * belonged to. Sweeping those would need a collection-group query, which needs
 * a collection-group index, which is a deploy decision rather than a line of
 * code. Meanwhile the app deletes its own expired records whenever Settings is
 * opened, and deleting an account takes the rest. So the privacy property costs
 * a sweep, knowingly.
 */
const deadShares = await db.collection('shares').where('expiresAt', '<=', now).select('expiresAt').limit(2000).get()
await deleteAll(deadShares.docs.map((d) => d.ref))

console.log(
  `reminders: ${due.size} due, ${sent} sent, ${orphaned} dropped (account deleted), ${removedTokens} stale tokens removed, ` +
    `${old.size} expired tickets cleaned, ${deadShares.size} expired shares swept, ` +
    `${dueNotices.size} space notices due, ${noticesSent} sent, ${noticesDropped} dropped ` +
    `(left the space or switched it off), ${oldNotices.size} old notices cleaned, ` +
    `${loansMoved.size} loans moved, ${loanNoticesSent} loan notices sent, ${loanNoticesUnresolved} addresses not looked up, ` +
    `${proposalsDeleted} unsigned proposals and ${closedDeleted} caught-up closed loans deleted (seals kept for signed ones)`,
)
