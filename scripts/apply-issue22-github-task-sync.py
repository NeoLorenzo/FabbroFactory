from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# ---- Supabase GitHub sync backend -------------------------------------------------
index_path = Path("supabase/functions/github-sync/index.ts")
index = index_path.read_text()

index = replace_once(
    index,
    'import { createAppAuth } from "npm:@octokit/auth-app@8.3.1";\n',
    'import { createAppAuth } from "npm:@octokit/auth-app@8.3.1";\nimport { buildReconciledIssueTasks, type GitHubIssueSyncRecord } from "./githubIssueTasks.ts";\n',
    "github-sync helper import",
)

index = replace_once(
    index,
    'type GitHubRepo = {\n  id: number;\n  name?: string;\n',
    'type GitHubRepo = {\n  id: number;\n  name?: string;\n  full_name?: string;\n',
    "GitHubRepo full_name",
)

index = replace_once(
    index,
    '      return jsonResponse({ integration: result.integration, repoCount: result.repoCount });\n',
    '      return jsonResponse({ integration: result.integration, repoCount: result.repoCount, issueCount: result.issueCount });\n',
    "link response issue count",
)
index = replace_once(
    index,
    '      return jsonResponse({ integration: result.integration, repoCount: result.repoCount });\n',
    '      return jsonResponse({ integration: result.integration, repoCount: result.repoCount, issueCount: result.issueCount });\n',
    "reconcile response issue count",
)

index = replace_once(
    index,
    '    "repository",\n    "push",\n    "installation",\n',
    '    "repository",\n    "push",\n    "issues",\n    "installation",\n',
    "issues webhook event",
)

index = replace_once(
    index,
    '  const result = await reconcileIntegration(integration);\n  return jsonResponse({ ok: true, repoCount: result.repoCount });\n',
    '  const result = await reconcileIntegration(integration);\n  return jsonResponse({ ok: true, repoCount: result.repoCount, issueCount: result.issueCount });\n',
    "webhook response issue count",
)

index = replace_once(
    index,
    '        ok: true,\n        repoCount: result.repoCount\n',
    '        ok: true,\n        repoCount: result.repoCount,\n        issueCount: result.issueCount\n',
    "cron response issue count",
)

old_reconcile = '''    const repos = rawRepos.filter(
      (repo) => Number(repo?.stargazers_count || 0) >= 1 && repo?.archived !== true
    );

    await reconcileProjectsForUser(integration.user_id, repos);
    const updatedIntegration = await patchIntegration(integration.user_id, {
      sync_status: "ok",
      last_error: "",
      last_reconciled_at: new Date().toISOString()
    });

    return { integration: updatedIntegration, repoCount: repos.length };
'''
new_reconcile = '''    const repos = rawRepos.filter(
      (repo) => Number(repo?.stargazers_count || 0) >= 1 && repo?.archived !== true
    );
    const issues = await fetchIssuesForRepositories(token, repos);

    await reconcileProjectsForUser(integration.user_id, repos);
    await reconcileTasksForUser(integration.user_id, issues);
    const updatedIntegration = await patchIntegration(integration.user_id, {
      sync_status: "ok",
      last_error: "",
      last_reconciled_at: new Date().toISOString()
    });

    return {
      integration: updatedIntegration,
      repoCount: repos.length,
      issueCount: issues.filter((issue) => String(issue.state || "").toLowerCase() === "open").length
    };
'''
index = replace_once(index, old_reconcile, new_reconcile, "issue reconciliation in integration")

insert_before_projects = '''async function reconcileProjectsForUser(userId: string, repos: GitHubRepo[]) {'''
issue_reconcile_helpers = '''async function reconcileTasksForUser(userId: string, issues: GitHubIssueSyncRecord[]) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await getUserTasks(userId);
    if (!row) {
      throw new Error("No user_tasks row exists for the linked Ariadne user.");
    }

    const currentTasks = Array.isArray(row.tasks) ? row.tasks : [];
    const nextTasks = buildReconciledIssueTasks(currentTasks, issues);
    if (JSON.stringify(nextTasks) === JSON.stringify(currentTasks)) {
      return;
    }

    const updated = await updateUserTasksIfVersionMatches({
      userId,
      expectedVersion: Number(row.version || 1),
      tasks: nextTasks
    });
    if (updated) {
      return;
    }
  }

  throw new Error("Task reconciliation conflicted with concurrent Ariadne writes repeatedly.");
}

'''
index = replace_once(
    index,
    insert_before_projects,
    issue_reconcile_helpers + insert_before_projects,
    "task reconciliation helper",
)

insert_before_headers = '''function githubHeaders(token: string) {'''
fetch_issue_helpers = '''async function fetchIssuesForRepositories(
  token: string,
  repos: GitHubRepo[]
): Promise<GitHubIssueSyncRecord[]> {
  const issueGroups = await Promise.all(
    repos.map((repo) => fetchRepositoryIssues(token, repo))
  );
  return issueGroups.flat();
}

async function fetchRepositoryIssues(
  token: string,
  repo: GitHubRepo
): Promise<GitHubIssueSyncRecord[]> {
  const repositoryId = parsePositiveInteger(repo?.id);
  const repositoryFullName = String(repo?.full_name || "").trim();
  const [owner, name] = repositoryFullName.split("/");
  if (!repositoryId || !owner || !name) {
    return [];
  }

  const issues: GitHubIssueSyncRecord[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?state=all&per_page=100&page=${page}`,
      { headers: githubHeaders(token) }
    );
    if (!response.ok) {
      throw new Error(`GitHub issue listing for ${repositoryFullName} returned HTTP ${response.status}.`);
    }

    const payload = await response.json();
    const pageItems = Array.isArray(payload) ? payload : [];
    for (const item of pageItems) {
      if (item?.pull_request) {
        continue;
      }
      const issueId = parsePositiveInteger(item?.id);
      const issueNumber = parsePositiveInteger(item?.number);
      if (!issueId || !issueNumber) {
        continue;
      }
      issues.push({
        id: issueId,
        number: issueNumber,
        title: String(item?.title || ""),
        state: String(item?.state || "open"),
        html_url: String(item?.html_url || ""),
        created_at: item?.created_at ? String(item.created_at) : null,
        updated_at: item?.updated_at ? String(item.updated_at) : null,
        repository: {
          id: repositoryId,
          full_name: repositoryFullName
        }
      });
    }

    if (pageItems.length < 100) {
      break;
    }
  }
  return issues;
}

'''
index = replace_once(
    index,
    insert_before_headers,
    fetch_issue_helpers + insert_before_headers,
    "issue API fetch helpers",
)

insert_before_admin = '''async function adminJson(path: string, init: RequestInit = {}) {'''
user_task_helpers = '''async function getUserTasks(userId: string) {
  const rows = await adminJson(
    `/rest/v1/user_tasks?user_id=eq.${encodeURIComponent(userId)}&select=tasks,version`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function updateUserTasksIfVersionMatches({
  userId,
  expectedVersion,
  tasks
}: {
  userId: string;
  expectedVersion: number;
  tasks: unknown[];
}) {
  const rows = await adminJson(
    `/rest/v1/user_tasks?user_id=eq.${encodeURIComponent(userId)}&version=eq.${expectedVersion}&select=version`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        tasks,
        version: expectedVersion + 1,
        updated_at: new Date().toISOString()
      })
    }
  );
  return Array.isArray(rows) && rows.length > 0;
}

'''
index = replace_once(
    index,
    insert_before_admin,
    user_task_helpers + insert_before_admin,
    "user_tasks admin helpers",
)

index_path.write_text(index)


# ---- Task page --------------------------------------------------------------------
task_path = Path("app/tasks/page.js")
tasks = task_path.read_text()

tasks = replace_once(
    tasks,
    'import { createTaskSignatureMap, getTaskSyncSignature, mergeTaskSnapshots, reconcileTaskSnapshots, sanitizeSubtaskList, sanitizeTask, sanitizeTaskList } from "@/lib/tasks/reconcile";\n',
    'import { createTaskSignatureMap, getTaskSyncSignature, isGitHubIssueTask, mergeTaskSnapshots, reconcileTaskSnapshots, sanitizeSubtaskList, sanitizeTask, sanitizeTaskList } from "@/lib/tasks/reconcile";\n',
    "task page GitHub helper import",
)

tasks = replace_once(
    tasks,
    '''  const saveTask = () => {
    const title = form.title.trim();
''',
    '''  const saveTask = () => {
    const isEditingGitHubIssue = isGitHubIssueTask(editingTask);
    const title = isEditingGitHubIssue ? String(editingTask?.title || "").trim() : form.title.trim();
''',
    "GitHub-aware save title",
)

tasks = replace_once(
    tasks,
    '''    const nextTaskShape = {
      completed: Boolean(form.completed),
      title,
''',
    '''    const nextTaskShape = {
      completed: isEditingGitHubIssue ? Boolean(editingTask?.completed) : Boolean(form.completed),
      title,
''',
    "GitHub-aware save completion",
)

tasks = replace_once(
    tasks,
    '''    const removedTask = tasks[removedTaskIndex];
    const deletedAt = Date.now();
''',
    '''    const removedTask = tasks[removedTaskIndex];
    if (isGitHubIssueTask(removedTask)) {
      return;
    }
    const deletedAt = Date.now();
''',
    "prevent GitHub task deletion",
)

tasks = replace_once(
    tasks,
    '''  const duplicateTask = (task) => {
    const now = Date.now();
''',
    '''  const duplicateTask = (task) => {
    if (isGitHubIssueTask(task)) return;
    const now = Date.now();
''',
    "prevent GitHub task duplication",
)

tasks = replace_once(
    tasks,
    '''  const toggleTaskCompleted = (taskId) => setTasks((currentTasks) => currentTasks.map((task) =>
    task.id === taskId ? { ...task, completed: !task.completed, updatedAt: Date.now() } : task
  ));
''',
    '''  const toggleTaskCompleted = (taskId) => setTasks((currentTasks) => currentTasks.map((task) =>
    task.id === taskId && !isGitHubIssueTask(task)
      ? { ...task, completed: !task.completed, updatedAt: Date.now() }
      : task
  ));
''',
    "prevent GitHub completion divergence",
)

tasks = replace_once(
    tasks,
    '''  const renderTaskCard = (task) => {
    const directionalGoalId = getDirectionalGoalId(task);
''',
    '''  const renderTaskCard = (task) => {
    const directionalGoalId = getDirectionalGoalId(task);
    const githubBacked = isGitHubIssueTask(task);
''',
    "GitHub card state",
)

tasks = replace_once(
    tasks,
    '''        className={`task-card priority-band-${priorityBand}${directionalGoalId ? " is-directional-goal" : ""}${
          isMobileExperience ? " task-card-mobile-editable" : ""
        }`}
''',
    '''        className={`task-card priority-band-${priorityBand}${directionalGoalId ? " is-directional-goal" : ""}${
          githubBacked ? " is-github-issue" : ""
        }${isMobileExperience ? " task-card-mobile-editable" : ""}`}
''',
    "GitHub task card class",
)

tasks = replace_once(
    tasks,
    '''          onClick={(event) => { event.stopPropagation(); toggleTaskCompleted(task.id); }}
          aria-label={task.completed ? "Mark task incomplete" : "Mark task complete"}
        >{task.completed ? "✓" : ""}</button>
''',
    '''          onClick={(event) => { event.stopPropagation(); toggleTaskCompleted(task.id); }}
          disabled={githubBacked}
          title={githubBacked ? "Completion is managed by the GitHub issue state" : undefined}
          aria-label={githubBacked ? "Completion managed by GitHub" : task.completed ? "Mark task incomplete" : "Mark task complete"}
        >{task.completed ? "✓" : ""}</button>
''',
    "GitHub completion control",
)

tasks = replace_once(
    tasks,
    '''        <header className="task-card-header">
          <h4 className="task-card-title">{task.title}</h4>
          {directionalGoalId ? (
''',
    '''        <header className="task-card-header">
          <h4 className="task-card-title">{task.title}</h4>
          {githubBacked && task.githubIssueUrl ? (
            <a
              className="task-card-github-source"
              href={task.githubIssueUrl}
              target="_blank"
              rel="noreferrer"
              title={`Open ${task.githubRepositoryFullName || "GitHub"} #${task.githubIssueNumber || ""}`}
              aria-label={`Open GitHub issue ${task.githubIssueNumber || ""}`}
              onClick={(event) => event.stopPropagation()}
            >
              ↗ #{task.githubIssueNumber || ""}
            </a>
          ) : null}
          {directionalGoalId ? (
''',
    "GitHub source link",
)

tasks = replace_once(
    tasks,
    '''            {!isMobileExperience ? (
              <button type="button" className="task-card-btn" title="Duplicate" aria-label="Duplicate task" onClick={(event) => { event.stopPropagation(); duplicateTask(task); }}>
                ⧉
              </button>
            ) : null}
            {!isMobileExperience ? (
''',
    '''            {!isMobileExperience && !githubBacked ? (
              <button type="button" className="task-card-btn" title="Duplicate" aria-label="Duplicate task" onClick={(event) => { event.stopPropagation(); duplicateTask(task); }}>
                ⧉
              </button>
            ) : null}
            {!isMobileExperience && !githubBacked ? (
''',
    "hide GitHub duplicate/delete actions",
)

tasks = replace_once(
    tasks,
    '''                    <button type="button" className={`task-editor-completion${form.completed ? " is-complete" : ""}`} onClick={() => setForm((current) => ({ ...current, completed: !current.completed }))} aria-label={form.completed ? "Mark task incomplete" : "Mark task complete"}>{form.completed ? "✓" : ""}</button>
''',
    '''                    <button
                      type="button"
                      className={`task-editor-completion${form.completed ? " is-complete" : ""}`}
                      onClick={() => setForm((current) => ({ ...current, completed: !current.completed }))}
                      disabled={isGitHubIssueTask(editingTask)}
                      title={isGitHubIssueTask(editingTask) ? "Completion is managed by GitHub" : undefined}
                      aria-label={isGitHubIssueTask(editingTask) ? "Completion managed by GitHub" : form.completed ? "Mark task incomplete" : "Mark task complete"}
                    >{form.completed ? "✓" : ""}</button>
''',
    "GitHub modal completion control",
)

tasks = replace_once(
    tasks,
    '''                      rows={1}
                      required
                    />
                    <textarea
''',
    '''                      rows={1}
                      required
                      readOnly={isGitHubIssueTask(editingTask)}
                      aria-readonly={isGitHubIssueTask(editingTask)}
                    />
                    {isGitHubIssueTask(editingTask) && editingTask?.githubIssueUrl ? (
                      <a
                        className="task-editor-github-source"
                        href={editingTask.githubIssueUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {editingTask.githubRepositoryFullName || "GitHub"} #{editingTask.githubIssueNumber || ""} ↗
                      </a>
                    ) : null}
                    <textarea
''',
    "GitHub modal source link and readonly title",
)

task_path.write_text(tasks)


# ---- Minimal provenance styling ----------------------------------------------------
css_path = Path("app/globals.css")
css = css_path.read_text()
marker = "/* GitHub-backed Ariadne tasks */"
if marker in css:
    raise RuntimeError("GitHub issue task CSS already exists")
css += '''

/* GitHub-backed Ariadne tasks */
.task-card.is-github-issue {
  border-color: rgba(74, 222, 128, 0.42);
  box-shadow: inset 3px 0 0 rgba(74, 222, 128, 0.72);
}

.task-card.is-github-issue:hover {
  border-color: rgba(74, 222, 128, 0.62);
}

.task-card-github-source,
.task-editor-github-source {
  color: rgba(134, 239, 172, 0.9);
  font-size: 0.72rem;
  font-weight: 650;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
}

.task-card-github-source:hover,
.task-editor-github-source:hover {
  color: #bbf7d0;
  text-decoration: underline;
  text-underline-offset: 0.18rem;
}

.task-editor-github-source {
  width: fit-content;
  margin-top: 0.16rem;
}

.task-card.is-github-issue .task-list-completion:disabled,
.task-editor-completion:disabled {
  cursor: default;
  opacity: 0.78;
}

.task-editor-title-input[readonly] {
  cursor: default;
}
'''
css_path.write_text(css)

print("Issue #22 source patch applied successfully.")
