from pathlib import Path

path = Path("supabase/functions/github-sync/index.ts")
text = path.read_text()

old = '''    if (!issueRecord) {
      return jsonResponse({ ok: true, ignored: "Issue webhook payload was incomplete." });
    }
    await reconcileTasksForUser(integration.user_id, [issueRecord]);
'''
new = '''    if (!issueRecord) {
      return jsonResponse({ ok: true, ignored: "Issue webhook payload was incomplete." });
    }
    if (!(await isTrackedRepositoryForUser(integration.user_id, issueRecord.repository.id))) {
      return jsonResponse({ ok: true, ignored: "Issue repository is not tracked by Ariadne." });
    }
    await reconcileTasksForUser(integration.user_id, [issueRecord]);
'''
if text.count(old) != 1:
    raise RuntimeError(f"Expected one direct issue webhook block, found {text.count(old)}")
text = text.replace(old, new, 1)

anchor = '''async function reconcileTasksForUser(userId: string, issues: GitHubIssueSyncRecord[]) {
'''
helper = '''async function isTrackedRepositoryForUser(userId: string, repositoryId: number) {
  const row = await getUserProjects(userId);
  const projects = Array.isArray(row?.projects) ? row.projects : [];
  const expectedProjectId = `${GITHUB_PROJECT_PREFIX}${repositoryId}`;
  return projects.some((project) =>
    Boolean(project) &&
    typeof project === "object" &&
    String((project as Record<string, unknown>).id || "") === expectedProjectId
  );
}

'''
if text.count(anchor) != 1:
    raise RuntimeError(f"Expected one task-reconcile anchor, found {text.count(anchor)}")
text = text.replace(anchor, helper + anchor, 1)

path.write_text(text)
print("Tracked repository guard applied.")
