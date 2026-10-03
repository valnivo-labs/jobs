# Valnivo Labs jobs

The scheduled jobs of Valnivo Labs' products, one folder per product. They are public so anybody can read
exactly what each job does with the data it touches; they are not a library, and they run only here.

## valnivo/

| Workflow | What it does | When |
|---|---|---|
| `valnivo-layouts.yml` | Reads the statement layouts people chose to send from the app, publishes on the `published` branch the taught layouts at least three submissions agree on, and deletes submissions after 90 days. | Daily, 03:23 UTC |

**What a statement layout is.** When Valnivo cannot read a bank's PDF, a person may send the layout of the
statement: where each piece of text sits, with every name replaced by `Xxx` and every digit by `9`, on their
own device, before it is sent. A *taught* layout is less: the statement's column headings, redacted the same
way, and where the date and amount columns sit. Nothing sent carries the person's account.

**What is published.** Only `valnivo/layouts.json` on the `published` branch: taught layouts that at least
three submissions agree on, and whose headings contain no word outside `valnivo/vocabulary.json`. No
submission, text, bank name or count is ever published, and the logs say "ok" or an error's code.

## Who can run them

- Nothing a stranger does can start a job: the only triggers are the schedule and *Run workflow*, which
  needs write access to this repository.
- Every job checks it is running in `valnivo-labs/jobs`, so a fork runs nothing.
- Google Cloud gives credentials only to workflows running from this repository's `main` branch, through
  Workload Identity Federation; no key is stored here. The account can reach Firestore and nothing else.
- Every action is pinned to a commit, not a tag, and only those actions may run here.

The scripts are edited in Valnivo's own repository and copied here. Changes made only here are overwritten.
