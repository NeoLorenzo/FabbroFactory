import { createAppAuth } from "npm:@octokit/auth-app@8.3.1";
import { buildReconciledIssueTasks, type GitHubIssueSyncRecord } from "./githubIssueTasks.ts";

const AUTHORIZED_EMAIL = "theneolorenzo@gmail.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_CATEGORY = "NeoLorenzo Coding";
const GITHUB_PROJECT_PREFIX = "github-repo-";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ariadne-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

type Integration = {
  user_id: string;
  installation_id: number;
  account_login: string;
  account_id: number | null;
  target_type: string;
  repository_selection: string;
  sync_status: string;
  last_reconciled_at: string | null;
  last_webhook_at: string | null;
  last_error: string;
};

type GitHubRepo = {
  id: number;
  name?: string;
  full_name?: string;
  description?: string | null;
  html_url?: string;
  archived?: boolean;
  stargazers_count?: number;
  pushed_at?: string | null;
  updated_at?: string | null;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  try {
    const githubEvent = request.headers.get("x-github-event");
    if (githubEvent) {
      return await handleWebhook(request, githubEvent);
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "").trim();

    if (action === "reconcile-all") {
      if (!isAuthorizedCronRequest(request)) {
        return jsonResponse({ error: "Not authorized." }, 403);
      }
      return await reconcileAllIntegrations();
    }

    const owner = await getAuthorizedOwner(request);
    if (!owner) {
      return jsonResponse({ error: "Not authorized." }, 403);
    }

    if (action === "link") {
      const installationId = parsePositiveInteger(body?.installationId);
      if (!installationId) {
        return jsonResponse({ error: "A valid installationId is required." }, 400);
      }

      const installation = await fetchGitHubInstallation(installationId);
      const integration = await upsertIntegration({
        userId: owner.userId,
        installationId,
        accountLogin: String(installation?.account?.login || ""),
        accountId: parsePositiveInteger(installation?.account?.id),
        targetType: String(installation?.target_type || "User"),
        repositorySelection: String(installation?.repository_selection || "all")
      });
      const result = await reconcileIntegration(integration);
      return jsonResponse({ integration: result.integration, repoCount: result.repoCount, issueCount: result.issueCount });
    }

    if (action === "reconcile") {
      const integration = await getIntegrationByUserId(owner.userId);
      if (!integration) {
        return jsonResponse({ error: "GitHub App is not linked." }, 409);
      }
      const result = await reconcileIntegration(integration);
      return jsonResponse({ integration: result.integration, repoCount: result.repoCount, issueCount: result.issueCount });
    }

    return jsonResponse({ error: "Unsupported action." }, 400);
  } catch (error) {
    console.error("github-sync failed", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "GitHub synchronization failed." },
      500
    );
  }
});

async function handleWebhook(request: Request, event: string) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!(await verifyWebhookSignature(rawBody, signature))) {
    return jsonResponse({ error: "Invalid webhook signature." }, 401);
  }

  const payload = JSON.parse(rawBody || "{}");
  if (event === "ping") {
    return jsonResponse({ ok: true });
  }

  const installationId = parsePositiveInteger(payload?.installation?.id);
  if (!installationId) {
    return jsonResponse({ ok: true, ignored: "No installation id." });
  }

  const integration = await getIntegrationByInstallationId(installationId);
  if (!integration) {
    return jsonResponse({ ok: true, ignored: "Installation is not linked to Ariadne yet." });
  }

  await patchIntegration(integration.user_id, {
    last_webhook_at: new Date().toISOString()
  });

  if (event === "installation") {
    const action = String(payload?.action || "").toLowerCase();
    if (action === "deleted") {
      await reconcileProjectsForUser(integration.user_id, []);
      const disconnected = await patchIntegration(integration.user_id, {
        sync_status: "disconnected",
        last_error: "GitHub App installation was removed.",
        last_reconciled_at: new Date().toISOString()
      });
      return jsonResponse({ ok: true, integration: disconnected });
    }

    if (action === "suspend") {
      const suspended = await patchIntegration(integration.user_id, {
        sync_status: "disconnected",
        last_error: "GitHub App installation is suspended."
      });
      return jsonResponse({ ok: true, integration: suspended });
    }
  }

  if (event === "issues") {
    const issueRecord = buildIssueRecordFromWebhook(payload);
    if (!issueRecord) {
      return jsonResponse({ ok: true, ignored: "Issue webhook payload was incomplete." });
    }
    if (!(await isTrackedRepositoryForUser(integration.user_id, issueRecord.repository.id))) {
      return jsonResponse({ ok: true, ignored: "Issue repository is not tracked by Ariadne." });
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
  if (!eventsThatRequireReconciliation.has(event)) {
    return jsonResponse({ ok: true, ignored: `Unhandled event: ${event}` });
  }

  const result = await reconcileIntegration(integration);
  return jsonResponse({ ok: true, repoCount: result.repoCount, issueCount: result.issueCount });
}

async function reconcileAllIntegrations() {
  const integrations = await listIntegrations();
  const results = [];

  for (const integration of integrations) {
    try {
      const result = await reconcileIntegration(integration);
      results.push({
        installationId: integration.installation_id,
        ok: true,
        repoCount: result.repoCount,
        issueCount: result.issueCount
      });
    } catch (error) {
      results.push({
        installationId: integration.installation_id,
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  return jsonResponse({ results });
}

async function reconcileIntegration(integration: Integration) {
  await patchIntegration(integration.user_id, {
    sync_status: "syncing",
    last_error: ""
  });

  try {
    const token = await getInstallationToken(integration.installation_id);
    const rawRepos = await fetchInstallationRepositories(token);
    const repos = rawRepos.filter(
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub reconciliation failed.";
    await patchIntegration(integration.user_id, {
      sync_status: "error",
      last_error: message
    }).catch(() => null);
    throw error;
  }
}

async function isTrackedRepositoryForUser(userId: string, repositoryId: number) {
  const row = await getUserProjects(userId);
  const projects = Array.isArray(row?.projects) ? row.projects : [];
  const expectedProjectId = `${GITHUB_PROJECT_PREFIX}${repositoryId}`;
  return projects.some((project: unknown) =>
    Boolean(project) &&
    typeof project === "object" &&
    String((project as Record<string, unknown>).id || "") === expectedProjectId
  );
}

async function reconcileTasksForUser(userId: string, issues: GitHubIssueSyncRecord[]) {
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

async function reconcileProjectsForUser(userId: string, repos: GitHubRepo[]) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await getUserProjects(userId);
    if (!row) {
      throw new Error("No user_projects row exists for the linked Ariadne user.");
    }

    const currentProjects = Array.isArray(row.projects) ? row.projects : [];
    const nextProjects = buildReconciledProjects(currentProjects, repos);
    if (JSON.stringify(nextProjects) === JSON.stringify(currentProjects)) {
      return;
    }

    const updated = await updateUserProjectsIfVersionMatches({
      userId,
      expectedVersion: Number(row.version || 1),
      projects: nextProjects
    });
    if (updated) {
      return;
    }
  }

  throw new Error("Project reconciliation conflicted with concurrent Ariadne writes repeatedly.");
}

function buildReconciledProjects(currentProjects: unknown[], repos: GitHubRepo[]) {
  const existingById = new Map<string, Record<string, unknown>>();
  const nonGitHubProjects: unknown[] = [];

  for (const rawProject of currentProjects) {
    if (!rawProject || typeof rawProject !== "object") {
      continue;
    }
    const project = rawProject as Record<string, unknown>;
    const id = String(project.id || "");
    if (id.startsWith(GITHUB_PROJECT_PREFIX)) {
      existingById.set(id, project);
    } else {
      nonGitHubProjects.push(project);
    }
  }

  const now = Date.now();
  const syncedProjects = repos
    .map((repo) => {
      const repoId = Number(repo?.id);
      if (!Number.isFinite(repoId)) {
        return null;
      }

      const id = `${GITHUB_PROJECT_PREFIX}${repoId}`;
      const existing = existingById.get(id);
      const remoteFields = {
        id,
        category: String(existing?.category || GITHUB_CATEGORY),
        title: String(repo?.name || "").trim(),
        desc: String(repo?.description || "").trim(),
        repoUrl: normalizeUrl(repo?.html_url),
        completionStatus: "active",
        repoStatusTag: "active",
        isArchived: false,
        stargazersCount: Number(repo?.stargazers_count || 0),
        lastCommitAt: parseDateToTimestamp(repo?.pushed_at) ?? parseDateToTimestamp(repo?.updated_at)
      };

      if (existing && remoteRepoFieldsEqual(existing, remoteFields)) {
        return existing;
      }

      return {
        ...(existing || {}),
        ...remoteFields,
        dueDate: String(existing?.dueDate || ""),
        estimatedHours: String(existing?.estimatedHours || ""),
        createdAt: Number.isFinite(Number(existing?.createdAt)) ? Number(existing?.createdAt) : now,
        updatedAt: now
      };
    })
    .filter(Boolean);

  return [...syncedProjects, ...nonGitHubProjects];
}

function remoteRepoFieldsEqual(existing: Record<string, unknown>, next: Record<string, unknown>) {
  return [
    "id",
    "category",
    "title",
    "desc",
    "repoUrl",
    "completionStatus",
    "repoStatusTag",
    "isArchived",
    "stargazersCount",
    "lastCommitAt"
  ].every((key) => existing[key] === next[key]);
}

async function getInstallationToken(installationId: number) {
  const auth = createAppAuth({
    appId: requiredEnv("GITHUB_APP_ID"),
    privateKey: requiredEnv("GITHUB_APP_PRIVATE_KEY")
  });
  const authentication = await auth({ type: "installation", installationId });
  return authentication.token;
}

async function getAppToken() {
  const auth = createAppAuth({
    appId: requiredEnv("GITHUB_APP_ID"),
    privateKey: requiredEnv("GITHUB_APP_PRIVATE_KEY")
  });
  const authentication = await auth({ type: "app" });
  return authentication.token;
}

async function fetchGitHubInstallation(installationId: number) {
  const token = await getAppToken();
  const response = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: githubHeaders(token)
  });
  if (!response.ok) {
    throw new Error(`GitHub installation lookup returned HTTP ${response.status}.`);
  }
  return await response.json();
}

async function fetchInstallationRepositories(token: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const response = await fetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      { headers: githubHeaders(token) }
    );
    if (!response.ok) {
      throw new Error(`GitHub repository listing returned HTTP ${response.status}.`);
    }

    const payload = await response.json();
    const pageRepos = Array.isArray(payload?.repositories) ? payload.repositories : [];
    repos.push(...pageRepos);
    if (pageRepos.length < 100) {
      break;
    }
  }
  return repos;
}

function buildIssueRecordFromWebhook(payload: any): GitHubIssueSyncRecord | null {
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

async function fetchIssuesForRepositories(
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

function githubHeaders(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "Ariadne-GitHub-Sync"
  };
}

async function getAuthorizedOwner(request: Request) {
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const publishableKey = request.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const authorization = request.headers.get("authorization");
  if (!publishableKey || !authorization?.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: publishableKey,
      Authorization: authorization
    }
  });
  if (!response.ok) {
    return null;
  }

  const user = await response.json();
  if (String(user?.email || "").trim().toLowerCase() !== AUTHORIZED_EMAIL) {
    return null;
  }

  const userId = String(user?.id || "").trim();
  return userId ? { userId, email: AUTHORIZED_EMAIL } : null;
}

function isAuthorizedCronRequest(request: Request) {
  const expected = Deno.env.get("GITHUB_SYNC_CRON_SECRET") || "";
  const supplied = request.headers.get("x-ariadne-cron-secret") || "";
  return Boolean(expected && supplied && constantTimeEqual(expected, supplied));
}

async function verifyWebhookSignature(rawBody: string, signature: string | null) {
  const secret = Deno.env.get("GITHUB_WEBHOOK_SECRET") || "";
  if (!secret || !signature?.startsWith("sha256=")) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = `sha256=${toHex(new Uint8Array(digest))}`;
  return constantTimeEqual(expected, signature);
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function getIntegrationByUserId(userId: string): Promise<Integration | null> {
  const rows = await adminJson(
    `/rest/v1/github_integrations?user_id=eq.${encodeURIComponent(userId)}&select=*`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getIntegrationByInstallationId(installationId: number): Promise<Integration | null> {
  const rows = await adminJson(
    `/rest/v1/github_integrations?installation_id=eq.${installationId}&select=*`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function listIntegrations(): Promise<Integration[]> {
  const rows = await adminJson("/rest/v1/github_integrations?select=*");
  return Array.isArray(rows) ? rows : [];
}

async function upsertIntegration({
  userId,
  installationId,
  accountLogin,
  accountId,
  targetType,
  repositorySelection
}: {
  userId: string;
  installationId: number;
  accountLogin: string;
  accountId: number | null;
  targetType: string;
  repositorySelection: string;
}): Promise<Integration> {
  const rows = await adminJson("/rest/v1/github_integrations?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      user_id: userId,
      installation_id: installationId,
      account_login: accountLogin,
      account_id: accountId,
      target_type: targetType,
      repository_selection: repositorySelection,
      sync_status: "pending",
      last_error: "",
      updated_at: new Date().toISOString()
    })
  });
  const integration = Array.isArray(rows) ? rows[0] : null;
  if (!integration) {
    throw new Error("GitHub integration could not be stored.");
  }
  return integration;
}

async function patchIntegration(userId: string, values: Record<string, unknown>): Promise<Integration> {
  const rows = await adminJson(
    `/rest/v1/github_integrations?user_id=eq.${encodeURIComponent(userId)}&select=*`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ ...values, updated_at: new Date().toISOString() })
    }
  );
  const integration = Array.isArray(rows) ? rows[0] : null;
  if (!integration) {
    throw new Error("GitHub integration state could not be updated.");
  }
  return integration;
}

async function getUserProjects(userId: string) {
  const rows = await adminJson(
    `/rest/v1/user_projects?user_id=eq.${encodeURIComponent(userId)}&select=projects,version`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function updateUserProjectsIfVersionMatches({
  userId,
  expectedVersion,
  projects
}: {
  userId: string;
  expectedVersion: number;
  projects: unknown[];
}) {
  const rows = await adminJson(
    `/rest/v1/user_projects?user_id=eq.${encodeURIComponent(userId)}&version=eq.${expectedVersion}&select=version`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        projects,
        version: expectedVersion + 1,
        updated_at: new Date().toISOString()
      })
    }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function getUserTasks(userId: string) {
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

async function adminJson(path: string, init: RequestInit = {}) {
  const url = `${requiredEnv("SUPABASE_URL")}${path}`;
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Supabase request returned HTTP ${response.status}: ${message.slice(0, 300)}`);
  }
  if (response.status === 204) {
    return null;
  }
  return await response.json();
}

function parsePositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseDateToTimestamp(value: unknown) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUrl(value: unknown) {
  const normalized = String(value || "").trim();
  return /^https?:\/\//i.test(normalized) ? normalized : "";
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name) || "";
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }
  return value;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json"
    }
  });
}
