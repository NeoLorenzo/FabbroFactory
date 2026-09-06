export const GITHUB_ISSUE_TASK_PREFIX = "github-issue-";
export const GITHUB_ISSUE_SOURCE_TYPE = "github-issue";

export type GitHubIssueSyncRecord = {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  created_at?: string | null;
  updated_at?: string | null;
  repository: {
    id: number;
    full_name: string;
  };
};

type TaskRecord = Record<string, unknown>;

export function buildReconciledIssueTasks(
  currentTasks: unknown[],
  issues: GitHubIssueSyncRecord[]
) {
  const issuesById = new Map<number, GitHubIssueSyncRecord>();
  for (const issue of Array.isArray(issues) ? issues : []) {
    const issueId = positiveInteger(issue?.id);
    const issueNumber = positiveInteger(issue?.number);
    const repositoryId = positiveInteger(issue?.repository?.id);
    const repositoryFullName = String(issue?.repository?.full_name || "").trim();
    if (!issueId || !issueNumber || !repositoryId || !repositoryFullName) {
      continue;
    }
    issuesById.set(issueId, issue);
  }

  const reconciled: unknown[] = [];
  const representedIssueIds = new Set<number>();

  for (const rawTask of Array.isArray(currentTasks) ? currentTasks : []) {
    if (!isRecord(rawTask)) {
      reconciled.push(rawTask);
      continue;
    }

    const issueId = getTaskGitHubIssueId(rawTask);
    if (!issueId) {
      reconciled.push(rawTask);
      continue;
    }

    if (representedIssueIds.has(issueId)) {
      continue;
    }
    representedIssueIds.add(issueId);

    const issue = issuesById.get(issueId);
    reconciled.push(issue ? buildGitHubIssueTask(rawTask, issue) : rawTask);
  }

  for (const [issueId, issue] of issuesById) {
    if (representedIssueIds.has(issueId) || normalizeIssueState(issue.state) !== "open") {
      continue;
    }
    reconciled.push(buildGitHubIssueTask(null, issue));
  }

  return reconciled;
}

export function getTaskGitHubIssueId(task: unknown) {
  if (!isRecord(task)) {
    return null;
  }

  const explicitId = positiveInteger(task.githubIssueId);
  if (explicitId) {
    return explicitId;
  }

  const sourceType = String(task.sourceType || "").trim().toLowerCase();
  const taskId = String(task.id || "").trim();
  if (sourceType !== GITHUB_ISSUE_SOURCE_TYPE && !taskId.startsWith(GITHUB_ISSUE_TASK_PREFIX)) {
    return null;
  }

  return positiveInteger(taskId.slice(GITHUB_ISSUE_TASK_PREFIX.length));
}

function buildGitHubIssueTask(existing: TaskRecord | null, issue: GitHubIssueSyncRecord) {
  const now = Date.now();
  const issueId = positiveInteger(issue.id)!;
  const issueNumber = positiveInteger(issue.number)!;
  const repositoryId = positiveInteger(issue.repository.id)!;
  const issueState = normalizeIssueState(issue.state);
  const issueUpdatedAt = timestamp(issue.updated_at) ?? now;
  const issueCreatedAt = timestamp(issue.created_at) ?? now;
  const taskId = `${GITHUB_ISSUE_TASK_PREFIX}${issueId}`;

  const remoteFields = {
    id: taskId,
    sourceType: GITHUB_ISSUE_SOURCE_TYPE,
    sourceGoalId: "",
    title: String(issue.title || "").trim() || `GitHub issue #${issueNumber}`,
    completed: issueState === "closed",
    githubIssueId: issueId,
    githubRepositoryId: repositoryId,
    githubRepositoryFullName: String(issue.repository.full_name || "").trim(),
    githubIssueNumber: issueNumber,
    githubIssueUrl: normalizeUrl(issue.html_url),
    githubIssueState: issueState,
    githubIssueUpdatedAt: issueUpdatedAt
  };

  if (existing && remoteIssueFieldsEqual(existing, remoteFields)) {
    return existing;
  }

  const base = existing || {};
  return {
    ...base,
    ...remoteFields,
    description: String(base.description || ""),
    dueDate: String(base.dueDate || ""),
    dueTime: String(base.dueTime || ""),
    priority: Number.isInteger(Number(base.priority)) ? Number(base.priority) : 0,
    estimatedHours: String(base.estimatedHours || ""),
    subtasks: Array.isArray(base.subtasks) ? base.subtasks : [],
    tags: Array.isArray(base.tags) ? base.tags : [],
    deleted: false,
    deletedAt: 0,
    createdAt: Number.isFinite(Number(base.createdAt)) ? Number(base.createdAt) : issueCreatedAt,
    updatedAt: Number.isFinite(Number(base.updatedAt)) ? Number(base.updatedAt) : now
  };
}

function remoteIssueFieldsEqual(existing: TaskRecord, next: TaskRecord) {
  return [
    "id",
    "sourceType",
    "sourceGoalId",
    "title",
    "completed",
    "githubIssueId",
    "githubRepositoryId",
    "githubRepositoryFullName",
    "githubIssueNumber",
    "githubIssueUrl",
    "githubIssueState",
    "githubIssueUpdatedAt"
  ].every((key) => existing[key] === next[key]);
}

function normalizeIssueState(value: unknown) {
  return String(value || "").trim().toLowerCase() === "closed" ? "closed" : "open";
}

function normalizeUrl(value: unknown) {
  const normalized = String(value || "").trim();
  return /^https?:\/\//i.test(normalized) ? normalized : "";
}

function positiveInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function timestamp(value: unknown) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is TaskRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
