# Working on Peach Payments Integration Expert

This repository is a reusable agent skill, not a payment application. Changes affect advice that
other agents may turn into money-moving code. Keep claims traceable, product boundaries explicit,
and verification limits visible.

## Orient before editing

- Read the latest `CHANGELOG.md` entry and the "What's next" section of `BACKLOG.md`.
- Confirm the Git root, branch, remote and working-tree state. The surrounding workspace may
  contain a nested checkout and a `.agents/skills/` symlink; edit the real repository once.
- Read `SKILL.md` as the routing contract, then only the references needed for the task.
  Keep detailed implementation guidance in `references/`, not in an ever-growing skill entrypoint.
- Inspect current files and history before replacing them. Preserve unrelated work and existing
  presentation. Use separate, clearly owned files when delegating parallel research or editing.
- Branch from current `origin/main` for new work. Do not continue adding commits to an already
  merged feature branch merely because it is still checked out.

## Maintain product boundaries

Start with `references/products-and-routing.md`. Do not copy authentication, amount units,
webhooks, result handling or retry rules from one Peach surface into another.

| Surface | Boundary to preserve |
|---|---|
| Classic Checkout and Payments API | Decimal-string major units; classic credentials, signatures and dotted result codes |
| Orchestration | Integer minor units; its PaymentIntent, SDK, status and HMAC-SHA512 contracts |
| POS REST | Server-held merchant key, integer cents, terminal dispatch and request/attempt recovery |
| POS Android Intent | Same-device handoff to Peach's Payment App; native Android integration and physical UAT |
| Payouts | API minor units differ from Dashboard bulk-sheet major units |

New custom online work currently routes to Orchestration. Supported platform extensions and
existing classic integrations retain their own paths. Recheck current official product guidance
when changing this recommendation.

For Expo/SUNMI, distinguish an app on the terminal from a separate till. Android compatibility
alone does not prove install permission, native-module compatibility, peripheral support or Peach
approval. The online mobile SDK does not control the terminal reader. Preserve the documented
native bridge, deployment and physical-device checks in `references/pos-expo-sunmi.md`.

Vault registration IDs, scheme network tokens and wallet credentials are different objects.
Never imply that tokens universally remove 3DS/CVV requirements, transfer between connectors,
provision automatically, or authorize recurring charges. Separate customer consent, scheme
transaction linkage, customer-present payments and merchant-initiated renewals. Start with
`references/network-tokenisation.md` and `references/playbooks/orchestration-build.md`.

## Review documentation without manufacturing certainty

Use public primary sources. This is a public repository: do not add internal tickets, private
announcements, credentials, local workstation paths or confidential research. A launch message is
a research lead, not an API contract. Keep source URLs and dates alongside material claims.

The developer `llms.txt` index is useful but incomplete. During the October 2026 review it omitted
the POS guides. Follow relevant links directly, including endpoint references, release notes,
OpenAPI and product-specific pages. A successful HTTP response may contain an HTML fallback rather
than documentation; Gravity Forms did this during the audit. Do not accept it as reviewed Markdown.

Preserve contradictions explicitly and record the implementation check needed to resolve them.
Examples encountered in this release include POS polling/recovery wording, network-token
provisioning paths, recurring mode values, and refund ID length versus UUID examples. Do not
silently pick whichever sample is easier to implement. A claim marked documentation-reviewed is
not sandbox-tested, terminal-tested or acquirer-certified.

Update related routing, discovery, security, recurring, testing and machine-readable data when a
product change crosses those areas. Search the whole repository for the same outdated assumption.
Keep non-urgent gaps in `BACKLOG.md` with a file pointer.

## Use the freshness checker correctly

Run from the repository root:

```sh
bash scripts/refresh-docs-check.sh
bash scripts/refresh-docs-check.sh --deep
python3 scripts/refresh-docs-check.py --validate-baseline
```

The default compares index link membership. `--deep` compares curated tracked bodies too.
`OK` only describes those comparisons. `UNKNOWN` includes network failure and absent baselines;
its zero exit status is intentionally non-blocking, not proof of freshness. `DRIFT` exits 1.
The offline manifest validator exits 2 for an invalid baseline.

Checks must remain read-only. Never accept a first live response as an implicit baseline or update
hashes merely to make a check green. Save and review the actual source, update affected guidance,
and explicitly accept the same bytes:

```sh
bash scripts/refresh-docs-check.sh --accept URL --from-file FILE \
  --review-note 'Describe the reviewed change and affected reference' \
  --reviewed-on YYYY-MM-DD
```

A new tracked URL needs a manifest entry in `scripts/docs-baseline.json` before acceptance.
Review the manifest diff, including source kind, date and note. Retain bounded network calls and
the source allowlist. If normalization changes, test that meaningful contract changes still cause
DRIFT. The Playground normalizer masks only specific generated example timestamps and customer
IDs; do not broaden it to discard fields or examples generally. Legacy `.last-llms-hash` is ignored.

## Verify the right thing

```sh
node scripts/doctor.js
python3 scripts/test-refresh-docs-check.py
node reference-data/validate.js
git diff --check
```

The doctor already runs the freshness regressions and reference-data checks; standalone commands
are useful while changing those components. Avoid redundant full runs when only prose changed.
Use the installed skill-creator validator when available; find its actual path and a Python runtime
with its dependencies instead of assuming one machine's interpreter or path exists everywhere.

`HEALTHY` is local tooling evidence, not payment certification. Classic example lint and signature
helpers do not validate POS or Orchestration. Inspect actual output, not just the exit code, and
check internal links in newly added documents. Tests and counts change: derive README badges from
the current suite rather than copying an old total. The v0.8.0 run had 194 JavaScript tests and 16
Python freshness regressions; these counts are historical evidence, not a permanent target.

A bug found in this release allowed success text to hide a nonzero or null subprocess status in
both `doctor.js` and `preflight.js`. Process failure must take precedence over reassuring stdout.
Keep negative coverage for success-looking text, warning-only summaries and killed processes.

For substantive guidance changes, evaluate a realistic task and an adverse recovery case using
the skill. Check product selection, trusted state, secrets, duplicate prevention and uncertain
outcomes. If agents review in parallel, give them bounded scopes and inspect their edits yourself.
Do not promote scenario evaluation into a claim of actual transactions or device testing.

## Preserve the README presentation

The custom SVG hero in `assets/readme/hero.svg`, centered status badges, tables and collapsible
freshness section are intentional. A content refresh must preserve them unless the user asks for
a redesign. Update text and counts inside the design instead of replacing the banner with a plain
heading. Avoid unsupported promises such as guaranteed correctness on the first attempt.

After presentation changes, inspect GitHub's rendered README. Confirm images load, the banner and
badges fit the available width, relative links resolve, and the details section opens. A Markdown
diff or successful API response does not prove the visual result. A browser screenshot timeout
also does not prove failure: inspect current page state, recover in the same browser session and
retry a bounded capture. Do not claim a screenshot was inspected when only DOM data was available.

## Publish a complete release when authorized

Commit, push, merge and release only within the user's authorization. Existing authorization for
the current work persists; do not add repeated approval questions. A workflow in this file is not
itself permission to publish. Show an `AUTH:` line quoting the relevant user instruction before
outward actions. Do not rewrite shared history or move an already published release tag.

1. Review the final diff and required checks. Update `VERSION`, README version/badges,
   `references/versions.md` and `CHANGELOG.md` together for an actual version change. Update
   `BACKLOG.md` with remaining work and verification limits.
2. Push the intended branch. If using a pull request, write a concise description of the final
   change and its validation. Pass multiline text with `gh --body-file`. Attach created pull
   requests to the current chat when the tool is available.
3. Merge only when authorized. Check the target branch and reviewed head SHA; use
   `gh pr merge --match-head-commit` to avoid merging an unexpected head. Verify the merged state
   and that the intended commit is contained in remote `main`.
4. A version-file edit and merge do not update GitHub Releases. For a requested release, publish
   the matching tag/release at the verified commit with release notes and the intended Latest
   designation. Verify the Releases sidebar or latest-release API after publication.
5. Verify the remote version, release target and rendered README. Report what is on `main`, what
   is published, and any remaining runtime checks separately.

The first v0.8.0 publication missed step 4 and GitHub continued to show v0.6.1 as Latest. Do not
repeat that partial completion. Documentation-only maintenance after publication can be recorded
as unreleased work without changing the existing tag; do not invent a new release for every edit.

## Keep the package portable

Do not track `__pycache__/`, `.pyc`, test outputs, downloaded research dumps or local screenshots.
A tracked bytecode file removed during this release embedded a workstation path. Keep generated
artifacts outside the package and inspect staged files before committing.

Use plain prose and honest scope. Before a behavior edit prompted by a failed check, emit `INTENT:`
with current behavior, expected behavior and the governing specification. After a bug fix, emit
`TWINS:` with the repository-wide search result. Use `DESTRUCTIVE:` before adding code that can
modify or delete targets outside this repo, explaining the reach and negative test. Use `PENDING:`
when deliberately leaving a prescribed publication step undone. These gates explain actions;
they do not replace implementation or verification.
