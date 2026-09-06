from pathlib import Path

# One-off branch patch used to validate direct GitHub issue webhook handling.
path = Path("supabase/functions/github-sync/index.ts")
text = path.read_text()

old = '''  const eventsThatRequireReconciliation = new Set([
    "repository",
    "push",
    "issues",
    "installation",
    "installation_repositories"
  ]);
'''
new = '''  if (event === "issues") {
    const issueRecord = buildIssueRecordFromWebhook(payload);
    if (!issueRecord) {
      return jsonResponse({ ok: true, ignored: "Issue webhook payload was incomplete." });
    }
    await reconcileTasksForUser(integration.user_id, [issueRecord]);
    return jsonResponse({
      ok: true,
      issueNumber: issueRecord.number,
      issueState: String(issueRecord.state || "open").toLowerCase()
    });
  }

  const eventsThatRequireReconciliation = new Set([
    "repository",
    "push",
    "installation",
    "installation_repositories"
  ]);
'''
if text.count(old) != 1:
    raise RuntimeError(f"Expected one webhook event-set block, found {text.count(old)}")
text = text.replace(old, new, 1)

anchor = '''async function fetchIssuesForRepositories(
  token: string,
  repos: GitHubRepo[]
): Promise<GitHubIssueSyncRecord[]> {
'''
helper = '''function buildIssueRecordFromWebhook(payload: any): GitHubIssueSyncRecord | null {
  const issue = payload?.issue;
  const repository = payload?.repository;
  if (!issue || issue?.pull_request) {
    return null;
  }

  const issueId = parsePositiveInteger(issue?.id);
  const issueNumber = parsePositiveInteger(issue?.number);
  const repositoryId = parsePositiveInteger(repository?.id);
  const repositoryFullName = String(repository?.full_name || "").trim();
  if (!issueId || !issueNumber || !repositoryId || !repositoryFullName) {
    return null;
  }

  return {
    id: issueId,
    number: issueNumber,
    title: String(issue?.title || ""),
    state: String(issue?.state || "open"),
    html_url: String(issue?.html_url || ""),
    created_at: issue?.created_at ? String(issue.created_at) : null,
    updated_at: issue?.updated_at ? String(issue.updated_at) : null,
    repository: {
      id: repositoryId,
      full_name: repositoryFullName
    }
  };
}

'''
if text.count(anchor) != 1:
    raise RuntimeError(f"Expected one issue-fetch helper anchor, found {text.count(anchor)}")
text = text.replace(anchor, helper + anchor, 1)

path.write_text(text)
print("Direct GitHub issue webhook handling patch applied.")
