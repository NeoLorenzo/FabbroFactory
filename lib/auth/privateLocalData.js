import { clearAllSyncCache, writeLastKnownSyncUserId } from "@/lib/storage/syncCache";

const PRIVATE_LOCAL_STORAGE_KEYS = [
  "fabbro_tasks_v1",
  "fabbro_tasks_sort_v1",
  "fabbro_projects_v1",
  "fabbro_direction_v1",
  "fabbro_strategic_objectives_v1",
  "fabbro_outcome_goals_v1",
  "fabbro_outcome_goal_revisions_v1",
  "fabbro_youtube_state_v1",
  "fabbro:left-nav-collapsed",
  "content-factory-document-library-v2",
  "content-factory-documents-v1"
];

export function clearLocalPrivateData() {
  if (typeof window === "undefined") {
    return;
  }

  PRIVATE_LOCAL_STORAGE_KEYS.forEach((storageKey) => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // A failed browser-storage cleanup must not prevent access from being revoked.
    }
  });

  clearAllSyncCache();
  writeLastKnownSyncUserId(null);
}
