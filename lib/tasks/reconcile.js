import { normalizeTaskTombstone } from "./taskTombstones";

export const GITHUB_ISSUE_SOURCE_TYPE = "github-issue";
export const GITHUB_ISSUE_TASK_PREFIX = "github-issue-";

function createTaskId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDateInput(value) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function normalizeTimeInput(value) {
  const match = String(value || "").trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? `${match[1]}:${match[2]}` : "";
}

function normalizePriority(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 4 ? numeric : 0;
}

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeOptionalUrl(value) {
  const normalized = String(value || "").trim();
  return /^https?:\/\//i.test(normalized) ? normalized : "";
}

function normalizeOptionalTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function getDirectionalGoalId(task) {
  const explicit = String(task?.sourceGoalId || "").trim();
  if (explicit) return explicit;
  const id = String(task?.id || "");
  return id.startsWith("directional-goal-task-") ? id.slice("directional-goal-task-".length) : "";
}

export function getGitHubIssueId(task) {
  const explicit = normalizePositiveInteger(task?.githubIssueId);
  if (explicit) return explicit;

  const sourceType = String(task?.sourceType || "").trim().toLowerCase();
  const id = String(task?.id || "").trim();
  if (sourceType !== GITHUB_ISSUE_SOURCE_TYPE && !id.startsWith(GITHUB_ISSUE_TASK_PREFIX)) {
    return null;
  }
  return normalizePositiveInteger(id.slice(GITHUB_ISSUE_TASK_PREFIX.length));
}

export function isGitHubIssueTask(task) {
  return Boolean(getGitHubIssueId(task));
}

function normalizeEstimatedHours(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) return "";
  return String(Math.round(numeric * 100) / 100);
}

export function sanitizeSubtaskList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (!item || typeof item !== "object" || !String(item.title || "").trim()) return null;
    const createdAt = Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : 0;
    return { id: String(item.id || createTaskId()), title: String(item.title).trim(), description: String(item.description || "").trim(), completed: Boolean(item.completed), createdAt, updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : createdAt };
  }).filter(Boolean);
}

export function sanitizeTask(task) {
  if (!task || typeof task !== "object" || !String(task.title || "").trim()) return null;
  const githubIssueId = getGitHubIssueId(task);
  const directionalGoalId = githubIssueId ? "" : getDirectionalGoalId(task);
  const createdAt = Number.isFinite(Number(task.createdAt)) ? Number(task.createdAt) : 0;
  const tombstone = normalizeTaskTombstone(task);
  const base = {
    id: githubIssueId ? `${GITHUB_ISSUE_TASK_PREFIX}${githubIssueId}` : String(task.id || createTaskId()),
    completed: Boolean(task.completed),
    title: String(task.title).trim(),
    description: String(task.description || "").trim(),
    dueDate: normalizeDateInput(task.dueDate),
    dueTime: normalizeTimeInput(task.dueTime),
    priority: directionalGoalId ? 0 : normalizePriority(task.priority),
    estimatedHours: normalizeEstimatedHours(task.estimatedHours),
    subtasks: sanitizeSubtaskList(task.subtasks),
    sourceType: githubIssueId ? GITHUB_ISSUE_SOURCE_TYPE : directionalGoalId ? "directional-goal" : "",
    sourceGoalId: directionalGoalId,
    tags: githubIssueId
      ? (Array.isArray(task.tags) ? task.tags.map((tag) => String(tag || "").trim()).filter(Boolean) : [])
      : directionalGoalId ? ["directional-goal"] : [],
    deleted: githubIssueId ? false : tombstone.deleted,
    deletedAt: githubIssueId ? 0 : tombstone.deletedAt,
    createdAt,
    updatedAt: Number.isFinite(Number(task.updatedAt)) ? Number(task.updatedAt) : createdAt
  };

  if (!githubIssueId) return base;

  return {
    ...base,
    githubIssueId,
    githubRepositoryId: normalizePositiveInteger(task.githubRepositoryId),
    githubRepositoryFullName: String(task.githubRepositoryFullName || "").trim(),
    githubIssueNumber: normalizePositiveInteger(task.githubIssueNumber),
    githubIssueUrl: normalizeOptionalUrl(task.githubIssueUrl),
    githubIssueState: String(task.githubIssueState || "").trim().toLowerCase() === "closed" ? "closed" : "open",
    githubIssueUpdatedAt: normalizeOptionalTimestamp(task.githubIssueUpdatedAt)
  };
}

export function sanitizeTaskList(tasks) { return Array.isArray(tasks) ? tasks.map(sanitizeTask).filter(Boolean) : []; }

export function getTaskSyncSignature(task) {
  const t = sanitizeTask(task);
  if (!t) return "";
  return JSON.stringify(t);
}

export function createTaskSignatureMap(tasks) {
  return Object.fromEntries(sanitizeTaskList(tasks).map((task) => [task.id, getTaskSyncSignature(task)]));
}

function mergeGitHubIssueTaskVersions(preferredTask, fallbackTask) {
  const preferred = sanitizeTask(preferredTask);
  const fallback = sanitizeTask(fallbackTask);
  if (!preferred) return fallback;
  if (!fallback) return preferred;
  if (!isGitHubIssueTask(preferred) || !isGitHubIssueTask(fallback)) {
    return Number(preferred.updatedAt || 0) >= Number(fallback.updatedAt || 0) ? preferred : fallback;
  }

  const ariadneOwner = Number(preferred.updatedAt || 0) >= Number(fallback.updatedAt || 0)
    ? preferred
    : fallback;
  const preferredGitHubTime = Number(preferred.githubIssueUpdatedAt || 0);
  const fallbackGitHubTime = Number(fallback.githubIssueUpdatedAt || 0);
  const githubOwner = preferredGitHubTime > fallbackGitHubTime ? preferred : fallback;

  return sanitizeTask({
    ...ariadneOwner,
    id: githubOwner.id,
    sourceType: GITHUB_ISSUE_SOURCE_TYPE,
    sourceGoalId: "",
    title: githubOwner.title,
    completed: githubOwner.completed,
    githubIssueId: githubOwner.githubIssueId,
    githubRepositoryId: githubOwner.githubRepositoryId,
    githubRepositoryFullName: githubOwner.githubRepositoryFullName,
    githubIssueNumber: githubOwner.githubIssueNumber,
    githubIssueUrl: githubOwner.githubIssueUrl,
    githubIssueState: githubOwner.githubIssueState,
    githubIssueUpdatedAt: githubOwner.githubIssueUpdatedAt,
    deleted: false,
    deletedAt: 0
  });
}

export function mergeTaskSnapshots(preferredTasks, fallbackTasks) {
  const merged = new Map(sanitizeTaskList(fallbackTasks).map((task) => [task.id, task]));
  sanitizeTaskList(preferredTasks).forEach((task) => {
    const existing = merged.get(task.id);
    if (!existing) {
      merged.set(task.id, task);
      return;
    }
    merged.set(task.id, isGitHubIssueTask(task) || isGitHubIssueTask(existing)
      ? mergeGitHubIssueTaskVersions(task, existing)
      : Number(task.updatedAt || 0) >= Number(existing.updatedAt || 0) ? task : existing);
  });
  return [...merged.values()];
}

export function reconcileTaskSnapshots(localTasks, remoteTasks, baselineSignaturesByTaskId = {}) {
  const local = new Map(sanitizeTaskList(localTasks).map((task) => [task.id, task]));
  const remote = new Map(sanitizeTaskList(remoteTasks).map((task) => [task.id, task]));
  const baseline = baselineSignaturesByTaskId && typeof baselineSignaturesByTaskId === "object" ? baselineSignaturesByTaskId : {};
  const ids = new Set([...local.keys(), ...remote.keys(), ...Object.keys(baseline)]);
  const result = [];
  ids.forEach((id) => {
    const l = local.get(id) || null, r = remote.get(id) || null, b = String(baseline[id] || "");
    const lc = l ? getTaskSyncSignature(l) !== b : "" !== b, rc = r ? getTaskSyncSignature(r) !== b : "" !== b;

    if (l && r && (isGitHubIssueTask(l) || isGitHubIssueTask(r)) && (lc || rc)) {
      result.push(mergeGitHubIssueTaskVersions(l, r));
      return;
    }

    if (lc && !rc) { if (l) result.push(l); return; }
    if (rc && !lc) { if (r) result.push(r); return; }
    if (lc && rc && l && r) { result.push(Number(l.updatedAt || 0) > Number(r.updatedAt || 0) ? l : r); return; }
    if (r) result.push(r); else if (l && lc) result.push(l);
  });
  return result;
}
