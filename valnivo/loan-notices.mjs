// Telling the other person about a step on a loan between two users
// (`docs/agreements.md` phase 8). The pure half of it: who is to be told, and
// in what words. `tools/send-reminders.mjs` reads the loans and sends; this
// file decides, and `tests/loanNotices.test.ts` holds it to what it may say.
//
// **It reads nothing a client wrote for it.** The job works from the loan's own
// fields and its signed history, which the rules already constrain: the act,
// the role, the account that took it. There is no notice document a person
// writes, so there is no field a message could be smuggled into — the reason
// `spaceNotices` has no string field, reached here by having no document.
//
// **It says which step was taken and nothing else**: never a name, an amount, a
// date or a note. Those are sealed, and a lock screen is not the place for them.
//
// Plain JavaScript, because the job runs on Node 22 in Actions, which cannot
// read TypeScript.

/** What each step says to the person it is for. `settled`, `forgiven` and `replaced` are the three closings. */
export const WORDING = {
  proposed: {
    title: 'A loan is waiting for you',
    body: 'Somebody recorded a loan to you in Valnivo. Open it to read the terms; opening it agrees to nothing.',
  },
  opened: {
    title: 'Your loan was opened',
    body: 'Open Valnivo so your device can share the terms with them.',
  },
  signed: {
    title: 'Your loan is signed by both of you',
    body: 'Open Valnivo to keep your copy and save the signed PDF.',
  },
  declined: {
    title: 'A loan you recorded was declined',
    body: 'Nothing was agreed.',
  },
  withdrawn: {
    title: 'A loan to you was withdrawn',
    body: 'Nothing was agreed.',
  },
  repayment: {
    title: 'A repayment was recorded on a loan',
    body: 'Open Valnivo to confirm it, if the money arrived.',
  },
  confirmation: {
    title: 'A repayment you recorded was confirmed',
    body: 'It now counts against what is owed.',
  },
  settled: {
    title: 'A loan is marked as paid back',
    body: 'Open Valnivo to see the signed record.',
  },
  forgiven: {
    title: 'The rest of a loan was let go',
    body: 'Open Valnivo to see the signed record.',
  },
  replaced: {
    title: 'A loan was replaced by its correction',
    body: 'Both of you signed the corrected terms. Open Valnivo to see both records.',
  },
}

/**
 * Who an entry is to be told to: the other person on the loan. The lender's
 * steps go to the borrower — by account once they have opened it, and by the
 * address the lender typed before that — and the borrower's go to the lender.
 * Null for an entry by neither, which the rules should never have accepted.
 */
export function recipientOf(loan, entry) {
  if (entry.byUid === loan.lenderUid) {
    if (loan.borrowerUid) return { uid: loan.borrowerUid }
    return loan.borrowerEmail ? { email: String(loan.borrowerEmail).toLowerCase() } : null
  }
  if (loan.borrowerUid && entry.byUid === loan.borrowerUid) return { uid: loan.lenderUid }
  return null
}

/** The key of a step's wording: the act, or the outcome for a closing. */
export const wordingKey = (entry) =>
  entry.act === 'closed' ? (entry.detail === 'forgiven' || entry.detail === 'replaced' ? entry.detail : 'settled') : entry.act

/**
 * The notices one loan owes since the job last looked: one per person, the
 * words of the newest step, and how many steps there were. `notifiedCount` is
 * the job's own mark on the loan; entries below it were dealt with already.
 */
export function planLoanNotices(loan, entries) {
  const from = Number(loan.notifiedCount ?? 0)
  const byRecipient = new Map()
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (entry.seq < from || !WORDING[wordingKey(entry)]) continue
    const to = recipientOf(loan, entry)
    if (!to) continue
    const key = to.uid ? `uid:${to.uid}` : `email:${to.email}`
    const notice = byRecipient.get(key) ?? { loanId: loan.id, to, steps: 0, last: entry }
    notice.steps += 1
    notice.last = entry
    byRecipient.set(key, notice)
  }
  return [...byRecipient.values()].map((n) => ({ loanId: n.loanId, to: n.to, steps: n.steps, ...wordingOf(n.last, n.steps) }))
}

/** The words for the newest step, with the count when there was more than one. */
export function wordingOf(entry, steps = 1) {
  const w = WORDING[wordingKey(entry)]
  return {
    title: w.title,
    body: steps > 1 ? `${w.body} (${steps} steps since the last notification.)` : w.body,
  }
}
