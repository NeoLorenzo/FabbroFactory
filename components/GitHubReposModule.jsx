"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import {
  readLastKnownSyncUserId,
  readSyncCacheEntry,
  upsertSyncCacheEntryIfChanged
} from "@/lib/storage/syncCache";
import {
  getVisibleGitHubRepos,
  GITHUB_COMPANY_CATEGORIES,
  LEGACY_CATEGORY_TO_COMPANY
} from "@/lib/projects/githubRepos";

const PROJECTS_STORAGE_KEY = "fabbro_projects_v1";
const PROJECTS_SYNC_CACHE_NAMESPACE = "projects.resolved_cloud";
const PROJECT_STATUS_ACTIVE = "active";
const PROJECT_STATUS_COMPLETED = "completed";
const GITHUB_REPO_PROJECT_ID_PREFIX = "github-repo-";
const REPO_STATUS_TAG_ACTIVE = "active";

const ALL_COMPANY_CATEGORIES = GITHUB_COMPANY_CATEGORIES;
const CATEGORY_FALLBACK = ALL_COMPANY_CATEGORIES[0] || "General";
const DEFAULT_PROJECTS = [];

export function useGitHubProjectSync({ onProjectsChange }) {
  const [projects, setProjects] = useState([]);
  const [cloudUserId, setCloudUserId] = useState(null);
  const [isCloudSyncReady, setIsCloudSyncReady] = useState(false);

  useEffect(() => {
    const localProjects = readProjectsFromStorage();
    const fallbackProjects =
      localProjects.length > 0 ? localProjects : sanitizeProjectList(DEFAULT_PROJECTS);
    setProjects(fallbackProjects);

    if (!supabase) {
      setIsCloudSyncReady(true);
      return undefined;
    }

    const lastKnownUserId = readLastKnownSyncUserId();
    if (lastKnownUserId) {
      const cachedBootEntry = readSyncCacheEntry({
        namespace: PROJECTS_SYNC_CACHE_NAMESPACE,
        userId: lastKnownUserId
      });
      const cachedBootPayload = cachedBootEntry?.payload;
      if (Array.isArray(cachedBootPayload?.projects)) {
        const cachedProjects = sanitizeProjectList(cachedBootPayload.projects);
        setProjects(cachedProjects);
        writeProjectsToStorage(cachedProjects);
      }
    }

    let isMounted = true;
    let loadGeneration = 0;

    const applySnapshot = ({ userId, rawProjects, version }) => {
      if (!isMounted) return;
      const cleanedProjects = sanitizeProjectList(rawProjects);
      setProjects(cleanedProjects);
      writeProjectsToStorage(cleanedProjects);

      if (userId && Number.isFinite(Number(version))) {
        const cachePayload = {
          projects: cleanedProjects,
          version: Number(version)
        };
        upsertSyncCacheEntryIfChanged({
          namespace: PROJECTS_SYNC_CACHE_NAMESPACE,
          userId,
          payload: cachePayload,
          signature: getProjectCollectionCacheSignature(cachePayload)
        });
      }
    };

    const loadForSession = async (session) => {
      const generation = ++loadGeneration;
      const userId = session?.user?.id || null;
      if (!isMounted) return;

      setCloudUserId(userId);
      setIsCloudSyncReady(false);

      if (!userId) {
        setIsCloudSyncReady(true);
        return;
      }

      const cachedEntry = readSyncCacheEntry({
        namespace: PROJECTS_SYNC_CACHE_NAMESPACE,
        userId
      });
      if (Array.isArray(cachedEntry?.payload?.projects)) {
        applySnapshot({
          userId,
          rawProjects: cachedEntry.payload.projects,
          version: cachedEntry.payload.version
        });
      }

      const { data: remoteRow, error } = await supabase
        .from("user_projects")
        .select("projects,version")
        .eq("user_id", userId)
        .maybeSingle();

      if (!isMounted || generation !== loadGeneration) return;

      if (!error && Array.isArray(remoteRow?.projects)) {
        applySnapshot({
          userId,
          rawProjects: remoteRow.projects,
          version: remoteRow.version
        });
      }

      setIsCloudSyncReady(true);
    };

    void supabase.auth.getSession().then(({ data }) => loadForSession(data?.session || null));

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (
        event !== "SIGNED_IN" &&
        event !== "SIGNED_OUT" &&
        event !== "USER_UPDATED" &&
        event !== "INITIAL_SESSION"
      ) {
        return;
      }
      window.setTimeout(() => void loadForSession(session), 0);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabase || !cloudUserId) {
      return undefined;
    }

    const channel = supabase
      .channel(`ariadne-user-projects-${cloudUserId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "user_projects",
          filter: `user_id=eq.${cloudUserId}`
        },
        (payload) => {
          const nextRow = payload?.new;
          if (!Array.isArray(nextRow?.projects)) return;

          const cleanedProjects = sanitizeProjectList(nextRow.projects);
          setProjects(cleanedProjects);
          writeProjectsToStorage(cleanedProjects);

          if (Number.isFinite(Number(nextRow.version))) {
            const cachePayload = {
              projects: cleanedProjects,
              version: Number(nextRow.version)
            };
            upsertSyncCacheEntryIfChanged({
              namespace: PROJECTS_SYNC_CACHE_NAMESPACE,
              userId: cloudUserId,
              payload: cachePayload,
              signature: getProjectCollectionCacheSignature(cachePayload)
            });
          }
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [cloudUserId]);

  useEffect(() => {
    onProjectsChange?.({ projects, userId: cloudUserId });
  }, [cloudUserId, onProjectsChange, projects]);

  const visibleRepos = useMemo(() => getVisibleGitHubRepos(projects), [projects]);

  return {
    isCloudSyncReady,
    visibleRepos
  };
}

export default function GitHubReposModule({ onProjectsChange }) {
  const { visibleRepos } = useGitHubProjectSync({ onProjectsChange });

  return (
    <section className="coding-workspace">
      <section className="coding-board-modal">
        <header className="coding-board-header">
          <h2 className="coding-board-title">Programming</h2>
        </header>

        <section className="coding-repos-module">
          <div className="coding-repos-header">
            <h3 className="coding-repos-title">Repos</h3>
            <p className="coding-repos-count">{visibleRepos.length}</p>
          </div>
          <div className="coding-repos-list">
            {visibleRepos.length === 0 ? (
              <p className="coding-repos-empty">No active repositories.</p>
            ) : (
              visibleRepos.map((project) => <RepoCard key={project.id} project={project} />)
            )}
          </div>
        </section>
      </section>
    </section>
  );
}

function RepoCard({ project }) {
  const formattedLastCommit = formatLastCommitDateTime(project?.lastCommitAt);
  const lastCommitTone = getLastCommitRecencyTone(project?.lastCommitAt);
  const relativeAge = formatLastCommitRelativeNumber(project?.lastCommitAt);

  return (
    <article className="coding-repo-card">
      <div className="coding-repo-card-header">
        <h4 className="coding-repo-title">{project?.title || "Untitled Repo"}</h4>
      </div>
      <div className="coding-repo-meta-row">
        <p className={`coding-repo-last-commit is-${lastCommitTone}`}>
          Last commit: {formattedLastCommit || "Unknown"}
        </p>
        {relativeAge ? (
          <span className={`coding-repo-age-chip is-${lastCommitTone}`}>{relativeAge}</span>
        ) : null}
      </div>
    </article>
  );
}

function sanitizeProject(project) {
  if (!project || typeof project !== "object") {
    return null;
  }

  const title = String(project.title || "").trim();
  if (!title) {
    return null;
  }

  const now = Date.now();
  return {
    id: String(project.id || createProjectId()),
    category: normalizeProjectCategory(project.category),
    title,
    desc: String(project.desc || "").trim(),
    repoUrl: normalizeOptionalUrl(project.repoUrl),
    dueDate: normalizeProjectDateTimeInput(project.dueDate),
    estimatedHours: normalizeEstimatedHours(project.estimatedHours),
    completionStatus: normalizeProjectCompletionStatus(project.completionStatus),
    repoStatusTag: normalizeRepoStatusTag(project.repoStatusTag),
    isArchived: project.isArchived === true,
    stargazersCount: Number.isFinite(Number(project.stargazersCount))
      ? Number(project.stargazersCount)
      : null,
    lastCommitAt: normalizeOptionalTimestamp(project.lastCommitAt),
    createdAt: Number.isFinite(Number(project.createdAt)) ? Number(project.createdAt) : now,
    updatedAt: Number.isFinite(Number(project.updatedAt)) ? Number(project.updatedAt) : now
  };
}

function sanitizeProjectList(rawProjects) {
  if (!Array.isArray(rawProjects)) {
    return [];
  }

  return rawProjects
    .map((project) => sanitizeProject(project))
    .filter((project) => {
      if (!project) return false;
      if (
        project.id.startsWith(GITHUB_REPO_PROJECT_ID_PREFIX) &&
        ((project.stargazersCount !== null && project.stargazersCount <= 0) || project.isArchived)
      ) {
        return false;
      }
      return true;
    });
}

function readProjectsFromStorage() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
    return raw ? sanitizeProjectList(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeProjectsToStorage(projectList) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(sanitizeProjectList(projectList)));
}

function getProjectCollectionCacheSignature(cachePayload) {
  const safePayload = cachePayload && typeof cachePayload === "object" ? cachePayload : {};
  const safeProjects = sanitizeProjectList(safePayload.projects);
  const safeVersion = Number.isFinite(Number(safePayload.version)) ? Number(safePayload.version) : null;
  return JSON.stringify({
    version: safeVersion,
    projects: safeProjects
  });
}

function normalizeProjectCategory(rawValue) {
  const category = String(rawValue || "").trim();
  const allowed = new Set(ALL_COMPANY_CATEGORIES);

  if (allowed.has(category)) {
    return category;
  }

  const mappedLegacyCategory = LEGACY_CATEGORY_TO_COMPANY[category];
  if (mappedLegacyCategory && allowed.has(mappedLegacyCategory)) {
    return mappedLegacyCategory;
  }

  return CATEGORY_FALLBACK;
}

function normalizeProjectDateTimeInput(rawValue) {
  const normalized = String(rawValue || "").trim();
  if (!normalized) return "";
  return Number.isNaN(new Date(normalized).getTime()) ? "" : normalized;
}

function normalizeEstimatedHours(rawValue) {
  if (rawValue === undefined || rawValue === null) return "";
  const trimmed = String(rawValue).trim();
  if (!trimmed) return "";
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : "";
}

function normalizeProjectCompletionStatus(rawValue) {
  return String(rawValue || "").trim().toLowerCase() === PROJECT_STATUS_COMPLETED
    ? PROJECT_STATUS_COMPLETED
    : PROJECT_STATUS_ACTIVE;
}

function normalizeRepoStatusTag(rawValue) {
  return String(rawValue || "").trim().toLowerCase() || REPO_STATUS_TAG_ACTIVE;
}

function normalizeOptionalTimestamp(rawValue) {
  const numericValue = Number(rawValue);
  if (Number.isFinite(numericValue)) return numericValue;

  const parsed = Date.parse(String(rawValue || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionalUrl(rawValue) {
  const normalized = String(rawValue || "").trim();
  return /^https?:\/\//i.test(normalized) ? normalized : "";
}

function createProjectId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getLastCommitRecencyTone(lastCommitAt) {
  const timestamp = Number(lastCommitAt);
  if (!Number.isFinite(timestamp)) return "info";

  const dayMs = 24 * 60 * 60 * 1000;
  const ageMs = Math.max(0, Date.now() - timestamp);

  if (ageMs <= 3 * dayMs) return "recent";
  if (ageMs <= 7 * dayMs) return "info";
  if (ageMs <= 14 * dayMs) return "warning";
  if (ageMs <= 90 * dayMs) return "major";
  return "danger";
}

function formatLastCommitDateTime(lastCommitAt) {
  const timestamp = Number(lastCommitAt);
  if (!Number.isFinite(timestamp)) return "";

  try {
    return new Date(timestamp).toLocaleString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
}

function formatLastCommitRelativeNumber(lastCommitAt) {
  const timestamp = Number(lastCommitAt);
  if (!Number.isFinite(timestamp)) return "";

  const ageMs = Math.max(0, Date.now() - timestamp);
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const minuteMs = 60 * 1000;

  const days = Math.floor(ageMs / dayMs);
  if (days > 0) return `${days}d`;

  const hours = Math.floor(ageMs / hourMs);
  if (hours > 0) return `${hours}h`;

  return `${Math.max(0, Math.floor(ageMs / minuteMs))}m`;
}
