/**
 * The Admin SDK's credential for the scheduled jobs, two ways (Valnivo Vault phase 4; owner, 2026-10-03:
 * *keep a backup in case anything goes down*).
 *
 *  · `VALNIVO_KEYLESS=1` and `FIREBASE_PROJECT`: the short-lived credentials GitHub's workflow obtained through
 *    Workload Identity Federation (`google-github-actions/auth`), read as application default credentials. No
 *    key is stored anywhere for this path; it is the default in every workflow.
 *  · `FIREBASE_SERVICE_ACCOUNT`: the service account's JSON key, as before. **Kept on purpose as the fallback**:
 *    a workflow run by hand with *use the stored key* takes this path if the keyless one ever fails.
 *
 * Returns `null` when neither is given.
 */
export async function adminCredential() {
  const { applicationDefault, cert } = await import('firebase-admin/app')
  if (process.env.VALNIVO_KEYLESS === '1') {
    const projectId = process.env.FIREBASE_PROJECT
    if (!projectId) throw new Error('VALNIVO_KEYLESS is set without FIREBASE_PROJECT')
    return { credential: applicationDefault(), projectId, how: 'keyless' }
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) return null
  const key = JSON.parse(raw)
  return { credential: cert(key), projectId: key.project_id, how: 'stored key' }
}
