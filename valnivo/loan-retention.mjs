// How long a loan between two users is kept (`docs/agreements.md` §7, owner,
// 2026-09-29). The pure half of it: which shared records may be deleted, and
// what goes with them. `tools/send-reminders.mjs` reads and deletes; this file
// decides, and `tests/loanRetention.test.ts` holds it to the owner's three rules.
//
// 1. **A proposal nobody signed stays at most two weeks** from when it was
//    made — waiting, declined or withdrawn alike. No document was ever handed
//    out for one (only a signed loan is copied or printed), so its seal goes
//    with it.
// 2. **A signed loan stays for the whole of the loan**, and after it closes for
//    as long as a projection needs it: until **both** people's own copies hold
//    its whole closed history (`caughtUp`), because the projection reads the
//    copy and so nothing already calculated moves when the shared record goes.
//    An account that no longer exists has nothing left to catch up.
// 3. **The seal of a signed loan is never deleted.** It holds only the history's
//    hashes — no name, amount, address or date — and it is what lets any copy
//    of the signed PDF be checked as authentic, for as long as anybody holds one.
//
// Plain JavaScript, because the job runs on Node 22 in Actions.

export const DAY = 24 * 60 * 60 * 1000
export const PROPOSAL_DAYS = 14
/** The statuses of a loan that was never signed by both. */
export const UNSIGNED = ['proposed', 'declined', 'withdrawn']

const millis = (v) => (typeof v === 'number' ? v : typeof v?.toMillis === 'function' ? v.toMillis() : null)

/**
 * What may happen to one shared loan record now:
 * - `proposal`: delete the loan, its history and its seal;
 * - `closed`: delete the loan and its history, and keep the seal;
 * - `null`: keep it.
 *
 * `gone(uid)` says whether an account no longer exists; the job asks only for
 * the people whose copy has not caught up.
 *
 * @param {Record<string, any>} loan
 * @param {number} now
 * @param {(uid: string) => boolean} [gone]
 * @returns {'proposal' | 'closed' | null}
 */
export function retentionOf(loan, now, gone = () => false) {
  if (UNSIGNED.includes(loan.status)) {
    const made = millis(loan.createdAt)
    return made !== null && made <= now - PROPOSAL_DAYS * DAY ? 'proposal' : null
  }
  if (loan.status !== 'closed') return null
  const count = Number(loan.historyCount ?? 0)
  const caught = loan.caughtUp ?? {}
  const parties = [loan.lenderUid, loan.borrowerUid]
  if (!parties.every((uid) => typeof uid === 'string' && uid)) return null
  return parties.every((uid) => caught[uid] === count || gone(uid)) ? 'closed' : null
}

/** The people on a closed loan whose own copy has not said it caught up. */
export function waitingOn(loan) {
  const count = Number(loan.historyCount ?? 0)
  const caught = loan.caughtUp ?? {}
  return [loan.lenderUid, loan.borrowerUid].filter((uid) => typeof uid === 'string' && uid && caught[uid] !== count)
}
