"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import AppShell from "@/components/AppShell";
import { supabase } from "@/lib/supabase/client";
import { useIsMobileExperience } from "@/lib/device/useIsMobileExperience";
import { ModalBody, ModalFooter, ModalShell, PrimaryButton, SecondaryButton } from "@/components/ui/AriadneUI";
import {
  readLastKnownSyncUserId,
  readSyncCacheEntry,
  upsertSyncCacheEntryIfChanged
} from "@/lib/storage/syncCache";
import {
  orderTasksForDisplay,
  TASK_SORT_STORAGE_KEY
} from "@/lib/tasks/taskOrdering";
import {
  isTaskDeleted,
  markTaskDeleted,
  normalizeTaskTombstone,
  purgeExpiredTaskTombstones,
  restoreDeletedTask
} from "@/lib/tasks/taskTombstones";
import { createTaskSignatureMap, getTaskSyncSignature, isGitHubIssueTask, mergeTaskSnapshots, reconcileTaskSnapshots, sanitizeSubtaskList, sanitizeTask, sanitizeTaskList } from "@/lib/tasks/reconcile";
import { createTaskWriteCoordinator } from "@/lib/tasks/writeCoordinator";

const TASK_STORAGE_KEY = "fabbro_tasks_v1";
const TASKS_SYNC_CACHE_NAMESPACE = "tasks.resolved_cloud";
const TASK_TOMBSTONE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const EMPTY_FORM = {
  completed: false,
  title: "",
  description: "",
  dueDate: "",
  dueTime: "",
  priority: 0,
  sourceGoalId: "",
  estimatedHours: "",
  subtasks: []
};

export default function TasksPage() {
  const isMobileExperience = useIsMobileExperience();
  const [tasks, setTasks] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingTaskId, setEditingTaskId] = useState("");
  const [taskFormError, setTaskFormError] = useState("");
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [sortMode, setSortMode] = useState("due-date");
  const [undoDeleteState, setUndoDeleteState] = useState(null);
  const [cloudUserId, setCloudUserId] = useState(null);
  const [cloudVersion, setCloudVersion] = useState(null);
  const [isCloudSyncReady, setIsCloudSyncReady] = useState(false);
  const [cloudSnapshotSignaturesByTaskId, setCloudSnapshotSignaturesByTaskId] = useState({});
  const [isCloudWriteInFlight, setIsCloudWriteInFlight] = useState(false);
  const [didCloudWriteFail, setDidCloudWriteFail] = useState(false);
  const [isAveragePressureCompact, setIsAveragePressureCompact] = useState(false);
  const [taskRecoveryState, setTaskRecoveryState] = useState({ status: "idle", backup: null, message: "" });
  const [hideCompletedSubtasks, setHideCompletedSubtasks] = useState(false);
  const [areSubtasksExpanded, setAreSubtasksExpanded] = useState(true);
  const [isCompletedTasksExpanded, setIsCompletedTasksExpanded] = useState(false);
  const [draggedSubtaskId, setDraggedSubtaskId] = useState("");
  const [, setCloudReadState] = useState("idle");
  const [, setCloudReadSource] = useState("none");
  const [, setCloudReadErrorMessage] = useState("");
  const undoTimeoutRef = useRef(null);
  const averagePressureRef = useRef(null);
  const descriptionRef = useRef(null);
  const draggedSubtaskIdRef = useRef("");
  const skipNextCloudWriteRef = useRef(false);
  const skipInitialPersistenceRef = useRef(true);
  const tasksRef = useRef([]);
  const isEnsuringCloudVersionRef = useRef(false);
  const cloudVersionRef = useRef(null);
  const cloudSnapshotSignaturesRef = useRef({});
  const isCloudWriteInFlightRef = useRef(false);
  const taskWriteCoordinatorRef = useRef(null);
  if (!taskWriteCoordinatorRef.current) taskWriteCoordinatorRef.current = createTaskWriteCoordinator();

  useEffect(() => {
    const descriptionField = descriptionRef.current;
    if (!descriptionField) return;

    if (!isMobileExperience || !isTaskModalOpen) {
      descriptionField.style.height = "";
      return;
    }

    descriptionField.style.height = "auto";
    const maximumHeight = Number.parseFloat(window.getComputedStyle(descriptionField).maxHeight) || 112;
    descriptionField.style.height = `${Math.min(descriptionField.scrollHeight, maximumHeight)}px`;
  }, [form.description, isMobileExperience, isTaskModalOpen]);

  useEffect(() => {
    if (!isTaskModalOpen) return;

    document
      .querySelectorAll(".task-editor-wrapping-title")
      .forEach((titleField) => {
        titleField.style.height = "auto";
        titleField.style.height = `${titleField.scrollHeight}px`;
      });
  }, [form.title, form.subtasks, isTaskModalOpen]);

  useEffect(() => {
    try {
      const savedSortMode = window.localStorage.getItem(TASK_SORT_STORAGE_KEY);
      if (savedSortMode === "due-date" || savedSortMode === "priority") {
        setSortMode(savedSortMode);
      }
    } catch {
      // Keep the default order when browser storage is unavailable.
    }
  }, []);

  const changeSortMode = (nextSortMode) => {
    const normalizedSortMode = nextSortMode === "priority" ? "priority" : "due-date";
    setSortMode(normalizedSortMode);
    try {
      window.localStorage.setItem(TASK_SORT_STORAGE_KEY, normalizedSortMode);
    } catch {
      // The selected order still applies for the current session.
    }
  };

  const resolveTasksForUser = async (userId, fallbackTasks) => {
    if (!supabase || !userId) {
      return {
        tasks: sanitizeTaskList(fallbackTasks),
        version: null,
        readState: "local",
        readSource: "no-supabase",
        readErrorMessage: ""
      };
    }

    const { data: remoteRow, error: remoteReadError } = await supabase
      .from("user_tasks")
      .select("tasks,version")
      .eq("user_id", userId)
      .maybeSingle();

    if (remoteReadError) {
      return {
        tasks: sanitizeTaskList(fallbackTasks),
        version: null,
        readState: "error",
        readSource: "local-fallback",
        readErrorMessage: String(remoteReadError.message || "Cloud read failed.")
      };
    }

    if (Array.isArray(remoteRow?.tasks)) {
      return {
        tasks: sanitizeTaskList(remoteRow.tasks),
        version: Number.isFinite(Number(remoteRow.version)) ? Number(remoteRow.version) : 1,
        readState: "ok",
        readSource: "cloud",
        readErrorMessage: ""
      };
    }

    const localFallbackTasks = sanitizeTaskList(fallbackTasks);
    const { error: seedError } = await supabase.from("user_tasks").insert(
      {
        user_id: userId,
        tasks: localFallbackTasks
      }
    );

    if (seedError) {
      const { data: raceRow, error: raceReadError } = await supabase
        .from("user_tasks")
        .select("tasks,version")
        .eq("user_id", userId)
        .maybeSingle();

      if (!raceReadError && Array.isArray(raceRow?.tasks)) {
        return {
          tasks: sanitizeTaskList(raceRow.tasks),
          version: Number.isFinite(Number(raceRow.version)) ? Number(raceRow.version) : 1,
          readState: "ok",
          readSource: "cloud-race-resolve",
          readErrorMessage: ""
        };
      }

      return {
        tasks: localFallbackTasks,
        version: null,
        readState: "error",
        readSource: "local-seed-error",
        readErrorMessage: String(seedError.message || "Cloud seed failed.")
      };
    }

    return {
      tasks: localFallbackTasks,
      version: 1,
      readState: "ok",
      readSource: localFallbackTasks.length > 0 ? "local-seeded" : "cloud-empty-seeded",
      readErrorMessage: ""
    };
  };

  useEffect(() => {
    const localTasks = readTasksFromStorage();
    tasksRef.current = localTasks;
    setTasks(localTasks);
    setCloudVersion(null);
    setCloudSnapshotSignaturesByTaskId({});
    setCloudReadState("local");
    setCloudReadSource("local-storage");
    setCloudReadErrorMessage("");

    if (!supabase) {
      setIsCloudSyncReady(true);
      return undefined;
    }

    const lastKnownUserId = readLastKnownSyncUserId();
    const cachedBootEntry = lastKnownUserId
      ? readSyncCacheEntry({
          namespace: TASKS_SYNC_CACHE_NAMESPACE,
          userId: lastKnownUserId
        })
      : null;
    const cachedBootPayload = cachedBootEntry?.payload;
    if (
      cachedBootPayload &&
      Array.isArray(cachedBootPayload.tasks) &&
      Number.isFinite(Number(cachedBootPayload.version))
    ) {
      const cachedTasks = mergeTaskSnapshots(localTasks, cachedBootPayload.tasks);
      tasksRef.current = cachedTasks;
      setTasks(cachedTasks);
      setCloudUserId(lastKnownUserId);
      setCloudVersion(Number(cachedBootPayload.version));
      setCloudSnapshotSignaturesByTaskId(createTaskSignatureMap(cachedBootPayload.tasks));
      setCloudReadState("ok");
      setCloudReadSource("cache-boot");
      writeTasksToStorage(cachedTasks);
    }

    let isMounted = true;

    const initializeCloudSync = async () => {
      setIsCloudSyncReady(false);
      try {
        const {
          data: { session }
        } = await supabase.auth.getSession();
        const user = session?.user || null;

        const nextUserId = user?.id || null;
        if (!isMounted) {
          return;
        }

        setCloudUserId(nextUserId);
        if (!nextUserId) {
          setCloudVersion(null);
          setCloudSnapshotSignaturesByTaskId({});
          setCloudReadState("local");
          setCloudReadSource("signed-out");
          setCloudReadErrorMessage("");
          return;
        }

        const cachedEntry = readSyncCacheEntry({
          namespace: TASKS_SYNC_CACHE_NAMESPACE,
          userId: nextUserId
        });
        const cachedPayload = cachedEntry?.payload;
        if (
          cachedPayload &&
          Array.isArray(cachedPayload.tasks) &&
          Number.isFinite(Number(cachedPayload.version))
        ) {
          const cachedTasks = mergeTaskSnapshots(tasksRef.current, cachedPayload.tasks);
          tasksRef.current = cachedTasks;
          skipNextCloudWriteRef.current = true;
          setTasks(cachedTasks);
          setCloudVersion(Number(cachedPayload.version));
          setCloudSnapshotSignaturesByTaskId(createTaskSignatureMap(cachedPayload.tasks));
          setCloudReadState("ok");
          setCloudReadSource("cache");
          setCloudReadErrorMessage("");
          writeTasksToStorage(cachedTasks);
          setIsCloudSyncReady(true);
        }

        const resolvedCloud = await resolveTasksForUser(nextUserId, localTasks);
        if (!isMounted) {
          return;
        }

        const resolvedVersion = Number.isFinite(Number(resolvedCloud.version))
          ? Number(resolvedCloud.version)
          : null;
        const resolvedCachePayload = {
          tasks: sanitizeTaskList(resolvedCloud.tasks),
          version: resolvedVersion
        };
        const currentLocalTasks = sanitizeTaskList(tasksRef.current);
        const baselineSignatures = createTaskSignatureMap(cachedPayload?.tasks);
        const reconciledTasks =
          resolvedCloud.readState === "ok"
            ? reconcileTaskSnapshots(currentLocalTasks, resolvedCachePayload.tasks, baselineSignatures)
            : currentLocalTasks;
        tasksRef.current = reconciledTasks;
        skipNextCloudWriteRef.current = true;
        setTasks(reconciledTasks);
        setCloudVersion(resolvedVersion);
        setCloudSnapshotSignaturesByTaskId(
          resolvedCloud.readState === "ok" ? createTaskSignatureMap(resolvedCachePayload.tasks) : {}
        );
        setCloudReadState(resolvedCloud.readState);
        setCloudReadSource(
          getTaskListParitySignature(reconciledTasks) ===
            getTaskListParitySignature(resolvedCachePayload.tasks)
            ? resolvedCloud.readSource
            : `${resolvedCloud.readSource}-local-edits-preserved`
        );
        setCloudReadErrorMessage(resolvedCloud.readErrorMessage);
        writeTasksToStorage(reconciledTasks);

        if (resolvedCloud.readState === "ok" && Number.isFinite(Number(resolvedVersion))) {
          upsertSyncCacheEntryIfChanged({
            namespace: TASKS_SYNC_CACHE_NAMESPACE,
            userId: nextUserId,
            payload: resolvedCachePayload,
            signature: getTaskCollectionCacheSignature(resolvedCachePayload)
          });
        }
      } catch {
        if (!isMounted) {
          return;
        }
        setCloudUserId(null);
        setCloudVersion(null);
        setCloudSnapshotSignaturesByTaskId({});
        setCloudReadState("local");
        setCloudReadSource("auth-lock-fallback");
        setCloudReadErrorMessage("");
      } finally {
        if (isMounted) {
          setIsCloudSyncReady(true);
        }
      }
    };

    void initializeCloudSync();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!supabase) {
      return undefined;
    }

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((event, session) => {
      const shouldRehydrate =
        event === "SIGNED_IN" ||
        event === "SIGNED_OUT" ||
        event === "USER_UPDATED" ||
        event === "INITIAL_SESSION";
      if (!shouldRehydrate) {
        return;
      }

      window.setTimeout(async () => {
        const nextUserId = session?.user?.id || null;
        setCloudUserId(nextUserId);

        if (!nextUserId) {
          setCloudVersion(null);
          setCloudSnapshotSignaturesByTaskId({});
          setCloudReadState("local");
          setCloudReadSource("signed-out");
          setCloudReadErrorMessage("");
          setIsCloudSyncReady(true);
          return;
        }

        setIsCloudSyncReady(false);
        const cachedEntry = readSyncCacheEntry({
          namespace: TASKS_SYNC_CACHE_NAMESPACE,
          userId: nextUserId
        });
        const cachedPayload = cachedEntry?.payload;
        if (
          cachedPayload &&
          Array.isArray(cachedPayload.tasks) &&
          Number.isFinite(Number(cachedPayload.version))
        ) {
          const cachedTasks = mergeTaskSnapshots(readTasksFromStorage(), cachedPayload.tasks);
          tasksRef.current = cachedTasks;
          skipNextCloudWriteRef.current = true;
          setTasks(cachedTasks);
          setCloudVersion(Number(cachedPayload.version));
          setCloudSnapshotSignaturesByTaskId(createTaskSignatureMap(cachedPayload.tasks));
          setCloudReadState("ok");
          setCloudReadSource("cache");
          setCloudReadErrorMessage("");
          writeTasksToStorage(cachedTasks);
          setIsCloudSyncReady(true);
        }

        const resolvedCloud = await resolveTasksForUser(nextUserId, readTasksFromStorage());
        const resolvedVersion = Number.isFinite(Number(resolvedCloud.version))
          ? Number(resolvedCloud.version)
          : null;
        const resolvedCachePayload = {
          tasks: sanitizeTaskList(resolvedCloud.tasks),
          version: resolvedVersion
        };
        const currentLocalTasks = sanitizeTaskList(tasksRef.current);
        const baselineSignatures = createTaskSignatureMap(cachedPayload?.tasks);
        const reconciledTasks =
          resolvedCloud.readState === "ok"
            ? reconcileTaskSnapshots(currentLocalTasks, resolvedCachePayload.tasks, baselineSignatures)
            : currentLocalTasks;
        tasksRef.current = reconciledTasks;
        skipNextCloudWriteRef.current = true;
        setTasks(reconciledTasks);
        setCloudVersion(resolvedVersion);
        setCloudSnapshotSignaturesByTaskId(
          resolvedCloud.readState === "ok" ? createTaskSignatureMap(resolvedCachePayload.tasks) : {}
        );
        setCloudReadState(resolvedCloud.readState);
        setCloudReadSource(
          getTaskListParitySignature(reconciledTasks) ===
            getTaskListParitySignature(resolvedCachePayload.tasks)
            ? resolvedCloud.readSource
            : `${resolvedCloud.readSource}-local-edits-preserved`
        );
        setCloudReadErrorMessage(resolvedCloud.readErrorMessage);
        writeTasksToStorage(reconciledTasks);

        if (resolvedCloud.readState === "ok" && Number.isFinite(Number(resolvedVersion))) {
          upsertSyncCacheEntryIfChanged({
            namespace: TASKS_SYNC_CACHE_NAMESPACE,
            userId: nextUserId,
            payload: resolvedCachePayload,
            signature: getTaskCollectionCacheSignature(resolvedCachePayload)
          });
        }
        setIsCloudSyncReady(true);
      }, 0);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (skipInitialPersistenceRef.current) {
      skipInitialPersistenceRef.current = false;
      return;
    }

    writeTasksToStorage(tasks);

    if (!supabase || !cloudUserId || !isCloudSyncReady) {
      return;
    }

    const currentTaskSignatureMap = createTaskSignatureMap(tasks);
    const snapshotSignatureMap = cloudSnapshotSignaturesByTaskId || {};
    const currentTaskIds = Object.keys(currentTaskSignatureMap);
    const snapshotTaskIds = Object.keys(snapshotSignatureMap);
    const isCloudSnapshotParity =
      currentTaskIds.length === snapshotTaskIds.length &&
      currentTaskIds.every(
        (taskId) => String(snapshotSignatureMap[taskId] || "") === String(currentTaskSignatureMap[taskId] || "")
      );

    if (skipNextCloudWriteRef.current) {
      skipNextCloudWriteRef.current = false;
      if (isCloudSnapshotParity) {
        return;
      }
    }

    if (isCloudSnapshotParity) {
      return;
    }

    if (!Number.isFinite(Number(cloudVersion))) {
      if (isEnsuringCloudVersionRef.current) {
        return;
      }

      isEnsuringCloudVersionRef.current = true;
      void (async () => {
        try {
          const { data: existingRow, error: existingReadError } = await supabase
            .from("user_tasks")
            .select("tasks,version")
            .eq("user_id", cloudUserId)
            .maybeSingle();

          if (!existingReadError && Number.isFinite(Number(existingRow?.version))) {
            setCloudVersion(Number(existingRow.version));
            if (Array.isArray(existingRow?.tasks)) {
              setCloudSnapshotSignaturesByTaskId(createTaskSignatureMap(sanitizeTaskList(existingRow.tasks)));
            }
            setCloudReadState("ok");
            setCloudReadSource("cloud-version-recovered");
            setCloudReadErrorMessage("");
            return;
          }

          const localTasksForBootstrap = sanitizeTaskList(tasksRef.current);
          const { error: seedError } = await supabase.from("user_tasks").insert({
            user_id: cloudUserId,
            tasks: localTasksForBootstrap
          });

          if (!seedError) {
            setCloudVersion(1);
            setCloudSnapshotSignaturesByTaskId(createTaskSignatureMap(localTasksForBootstrap));
            setCloudReadState("ok");
            setCloudReadSource("cloud-version-seeded");
            setCloudReadErrorMessage("");
            upsertSyncCacheEntryIfChanged({
              namespace: TASKS_SYNC_CACHE_NAMESPACE,
              userId: cloudUserId,
              payload: {
                tasks: localTasksForBootstrap,
                version: 1
              },
              signature: getTaskCollectionCacheSignature({
                tasks: localTasksForBootstrap,
                version: 1
              })
            });
            return;
          }

          const { data: raceRow, error: raceReadError } = await supabase
            .from("user_tasks")
            .select("tasks,version")
            .eq("user_id", cloudUserId)
            .maybeSingle();

          if (!raceReadError && Number.isFinite(Number(raceRow?.version))) {
            setCloudVersion(Number(raceRow.version));
            if (Array.isArray(raceRow?.tasks)) {
              setCloudSnapshotSignaturesByTaskId(createTaskSignatureMap(sanitizeTaskList(raceRow.tasks)));
            }
            setCloudReadState("ok");
            setCloudReadSource("cloud-version-race-recovered");
            setCloudReadErrorMessage("");
            return;
          }

          setDidCloudWriteFail(true);
          setCloudReadState("error");
          setCloudReadSource("write-blocked-missing-version");
          setCloudReadErrorMessage(
            String(seedError?.message || existingReadError?.message || "Cloud version is unknown.")
          );
        } finally {
          isEnsuringCloudVersionRef.current = false;
        }
      })();
      return;
    }

    if (!taskWriteCoordinatorRef.current.start()) {
      return;
    }
    const expectedVersion = Number(cloudVersion);
    isCloudWriteInFlightRef.current = true;
    setIsCloudWriteInFlight(true);
    setDidCloudWriteFail(false);

    void supabase
      .from("user_tasks")
      .update(
        {
          tasks: sanitizeTaskList(tasks),
          updated_at: new Date().toISOString(),
          version: expectedVersion + 1
        }
      )
      .eq("user_id", cloudUserId)
      .eq("version", expectedVersion)
      .select("version")
      .maybeSingle()
      .then(async ({ data, error }) => {
        if (error) {
          setDidCloudWriteFail(true);
          setCloudReadState("error");
          setCloudReadSource("write-error");
          setCloudReadErrorMessage(String(error.message || "Cloud write failed."));
          return;
        }

        if (data) {
          const nextVersion = expectedVersion + 1;
          const nextCachePayload = {
            tasks: sanitizeTaskList(tasks),
            version: nextVersion
          };
          setCloudVersion((currentVersion) =>
            Number.isFinite(Number(currentVersion)) ? Number(currentVersion) + 1 : expectedVersion + 1
          );
          setCloudSnapshotSignaturesByTaskId(createTaskSignatureMap(tasks));
          setCloudReadState("ok");
          setCloudReadSource("cloud-write");
          setCloudReadErrorMessage("");
          upsertSyncCacheEntryIfChanged({
            namespace: TASKS_SYNC_CACHE_NAMESPACE,
            userId: cloudUserId,
            payload: nextCachePayload,
            signature: getTaskCollectionCacheSignature(nextCachePayload)
          });
          return;
        }

        const { data: latestRow, error: latestReadError } = await supabase
          .from("user_tasks")
          .select("tasks,version")
          .eq("user_id", cloudUserId)
          .maybeSingle();

        if (latestReadError || !Array.isArray(latestRow?.tasks)) {
          setDidCloudWriteFail(true);
          setCloudReadState("error");
          setCloudReadSource("write-version-conflict");
          setCloudReadErrorMessage("Version conflict detected and latest row could not be loaded.");
          return;
        }

        const latestTasks = sanitizeTaskList(latestRow.tasks);
        const latestVersion = Number.isFinite(Number(latestRow.version))
          ? Number(latestRow.version)
          : expectedVersion;
        const reconciledTasks = reconcileTaskSnapshots(
          tasks,
          latestTasks,
          cloudSnapshotSignaturesByTaskId
        );
        const hasLocalChangesToPreserve =
          getTaskListParitySignature(reconciledTasks) !== getTaskListParitySignature(latestTasks);

        tasksRef.current = reconciledTasks;
        cloudVersionRef.current = latestVersion;
        cloudSnapshotSignaturesRef.current = createTaskSignatureMap(latestTasks);
        setCloudVersion(latestVersion);
        setCloudSnapshotSignaturesByTaskId(createTaskSignatureMap(latestTasks));
        skipNextCloudWriteRef.current = true;
        setTasks(reconciledTasks);
        setCloudReadState("ok");
        setCloudReadSource(
          hasLocalChangesToPreserve
            ? "write-version-conflict-merged-retry"
            : "write-version-conflict-reloaded"
        );
        setCloudReadErrorMessage("");
        const latestCachePayload = {
          tasks: latestTasks,
          version: latestVersion
        };
        upsertSyncCacheEntryIfChanged({
          namespace: TASKS_SYNC_CACHE_NAMESPACE,
          userId: cloudUserId,
          payload: latestCachePayload,
          signature: getTaskCollectionCacheSignature(latestCachePayload)
        });
      })
      .finally(() => {
        isCloudWriteInFlightRef.current = false;
        setIsCloudWriteInFlight(false);
        if (taskWriteCoordinatorRef.current.finish()) {
          setTasks((currentTasks) => sanitizeTaskList(currentTasks));
        }
      });
  }, [
    tasks,
    cloudUserId,
    isCloudSyncReady,
    cloudVersion
  ]);

  useEffect(
    () => () => {
      if (undoTimeoutRef.current) {
        window.clearTimeout(undoTimeoutRef.current);
      }
    },
    []
  );

  useEffect(() => {
    tasksRef.current = sanitizeTaskList(tasks);
  }, [tasks]);

  useEffect(() => {
    const purgeExpiredTombstones = () => {
      setTasks((currentTasks) => {
        const nextTasks = purgeExpiredTaskTombstones(currentTasks);
        return nextTasks.length === currentTasks.length ? currentTasks : nextTasks;
      });
    };

    purgeExpiredTombstones();
    const intervalId = window.setInterval(
      purgeExpiredTombstones,
      TASK_TOMBSTONE_CLEANUP_INTERVAL_MS
    );
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    cloudVersionRef.current = Number.isFinite(Number(cloudVersion)) ? Number(cloudVersion) : null;
  }, [cloudVersion]);

  useEffect(() => {
    cloudSnapshotSignaturesRef.current = cloudSnapshotSignaturesByTaskId || {};
  }, [cloudSnapshotSignaturesByTaskId]);

  useEffect(() => {
    isCloudWriteInFlightRef.current = isCloudWriteInFlight;
  }, [isCloudWriteInFlight]);

  useEffect(() => {
    if (!supabase || !cloudUserId || !isCloudSyncReady) {
      return undefined;
    }

    let isActive = true;
    let refreshInFlight = false;

    const refreshFromCloud = async () => {
      if (!isActive || refreshInFlight || isCloudWriteInFlightRef.current) {
        return;
      }

      refreshInFlight = true;
      try {
        const { data: remoteRow, error } = await supabase
          .from("user_tasks")
          .select("tasks,version")
          .eq("user_id", cloudUserId)
          .maybeSingle();
        if (!isActive || error || !Array.isArray(remoteRow?.tasks)) {
          return;
        }

        const remoteVersion = Number(remoteRow.version);
        if (!Number.isFinite(remoteVersion)) {
          return;
        }
        const currentVersion = Number(cloudVersionRef.current);
        if (Number.isFinite(currentVersion) && remoteVersion <= currentVersion) {
          return;
        }

        const remoteTasks = sanitizeTaskList(remoteRow.tasks);
        const reconciledTasks = reconcileTaskSnapshots(
          tasksRef.current,
          remoteTasks,
          cloudSnapshotSignaturesRef.current
        );
        const remoteSignatures = createTaskSignatureMap(remoteTasks);
        const nextCachePayload = { tasks: remoteTasks, version: remoteVersion };

        tasksRef.current = reconciledTasks;
        cloudVersionRef.current = remoteVersion;
        cloudSnapshotSignaturesRef.current = remoteSignatures;
        skipNextCloudWriteRef.current = true;
        setTasks(reconciledTasks);
        setCloudVersion(remoteVersion);
        setCloudSnapshotSignaturesByTaskId(remoteSignatures);
        setCloudReadState("ok");
        setCloudReadSource("cloud-refresh");
        setCloudReadErrorMessage("");
        writeTasksToStorage(reconciledTasks);
        upsertSyncCacheEntryIfChanged({
          namespace: TASKS_SYNC_CACHE_NAMESPACE,
          userId: cloudUserId,
          payload: nextCachePayload,
          signature: getTaskCollectionCacheSignature(nextCachePayload)
        });
      } finally {
        refreshInFlight = false;
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshFromCloud();
      }
    };
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshFromCloud();
      }
    }, 5000);

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    void refreshFromCloud();

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [cloudUserId, isCloudSyncReady]);

  useEffect(() => {
    const refreshFromStorage = () => setTasks(readTasksFromStorage());
    const handleStorage = (event) => {
      if (event.key === TASK_STORAGE_KEY) refreshFromStorage();
    };
    window.addEventListener("ariadne:tasks-changed", refreshFromStorage);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("ariadne:tasks-changed", refreshFromStorage);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    const visibleTaskCount = tasks.filter((task) => !isTaskDeleted(task)).length;
    if (!supabase || !cloudUserId || !isCloudSyncReady || visibleTaskCount > 0) {
      setTaskRecoveryState({ status: "idle", backup: null, message: "" });
      return;
    }

    let isActive = true;
    setTaskRecoveryState({ status: "loading", backup: null, message: "Checking task backups…" });
    void supabase
      .from("user_tasks_backups")
      .select("id,version,tasks,backed_up_at")
      .eq("user_id", cloudUserId)
      .order("backed_up_at", { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (!isActive) return;
        if (error) {
          setTaskRecoveryState({ status: "error", backup: null, message: "Could not read task backups." });
          return;
        }
        const backup = (Array.isArray(data) ? data : []).find(
          (entry) => sanitizeTaskList(entry?.tasks).some((task) => !isTaskDeleted(task))
        ) || null;
        setTaskRecoveryState(backup
          ? { status: "available", backup, message: "" }
          : { status: "empty", backup: null, message: "No non-empty task backup was found." });
      });

    return () => { isActive = false; };
  }, [cloudUserId, isCloudSyncReady, tasks]);

  const restoreTaskBackup = () => {
    const recoveredTasks = sanitizeTaskList(taskRecoveryState.backup?.tasks);
    if (!recoveredTasks.length) return;
    setTaskRecoveryState({ status: "restoring", backup: taskRecoveryState.backup, message: "Restoring tasks…" });
    setTasks(recoveredTasks.map((task) => ({ ...task, updatedAt: Date.now() })));
  };

  const liveTasks = useMemo(
    () => tasks.filter((task) => !isTaskDeleted(task)),
    [tasks]
  );
  const displayedTasks = orderTasksForDisplay(liveTasks, sortMode);
  const activeTasks = displayedTasks.filter((task) => !task.completed);
  const completedTasks = displayedTasks.filter((task) => task.completed);

  const submitLabel = editingTaskId ? "Save Task" : "Add Task";
  const taskModalTitle = editingTaskId ? "Edit Task" : "Add Task";
  const timePressureByTaskId = useMemo(
    () => buildQueueAdjustedTimePressureByTaskId(liveTasks),
    [liveTasks]
  );
  const averageTimePressure = useMemo(
    () => calculateAverageTimePressure(liveTasks, timePressureByTaskId),
    [liveTasks, timePressureByTaskId]
  );
  useEffect(() => {
    const averagePressureElement = averagePressureRef.current;
    if (!averagePressureElement || typeof window === "undefined") {
      return undefined;
    }

    const recomputeAveragePressureLabel = () => {
      const isMobileView = window.matchMedia("(max-aspect-ratio: 2/3)").matches;
      if (isMobileView) {
        setIsAveragePressureCompact(true);
        return;
      }

      const computedStyle = window.getComputedStyle(averagePressureElement);
      const measurementCanvas = document.createElement("canvas");
      const measurementContext = measurementCanvas.getContext("2d");
      if (!measurementContext) {
        setIsAveragePressureCompact(false);
        return;
      }

      measurementContext.font = [
        computedStyle.fontStyle,
        computedStyle.fontVariant,
        computedStyle.fontWeight,
        computedStyle.fontSize,
        computedStyle.fontFamily
      ]
        .filter(Boolean)
        .join(" ");

      const fullLabelText = `Avg Time Pressure: ${formatTimePressure(averageTimePressure)}`;
      const fullLabelWidth = measurementContext.measureText(fullLabelText).width;
      const availableWidth = averagePressureElement.clientWidth;
      setIsAveragePressureCompact(fullLabelWidth > availableWidth + 0.5);
    };

    recomputeAveragePressureLabel();

    let resizeObserver;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(recomputeAveragePressureLabel);
      resizeObserver.observe(averagePressureElement);
    }

    window.addEventListener("resize", recomputeAveragePressureLabel);
    return () => {
      window.removeEventListener("resize", recomputeAveragePressureLabel);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    };
  }, [averageTimePressure]);
  const averagePressureLabel = isAveragePressureCompact ? "Avg TP" : "Avg Time Pressure";
  const cloudSyncBadge = useMemo(() => {
    if (!supabase) {
      return { label: "Local", tone: "local" };
    }

    if (!isCloudSyncReady) {
      return { label: "Syncing", tone: "syncing" };
    }

    if (cloudUserId) {
      return { label: "Connected", tone: "connected" };
    }

    return { label: "Sign In", tone: "signed-out" };
  }, [cloudUserId, isCloudSyncReady]);
  const formTimePressure = useMemo(
    () => calculateDraftQueueAdjustedTimePressure(form, liveTasks, editingTaskId),
    [form, liveTasks, editingTaskId]
  );
  const taskCloudSyncBadgesByTaskId = useMemo(
    () =>
      buildTaskCloudSyncBadges({
        tasks,
        cloudSnapshotSignaturesByTaskId,
        hasSupabase: Boolean(supabase),
        cloudUserId,
        isCloudSyncReady,
        isCloudWriteInFlight,
        didCloudWriteFail
      }),
    [
      tasks,
      cloudSnapshotSignaturesByTaskId,
      cloudUserId,
      isCloudSyncReady,
      isCloudWriteInFlight,
      didCloudWriteFail
    ]
  );
  const editingTask = useMemo(
    () => tasks.find((task) => task.id === editingTaskId) || null,
    [tasks, editingTaskId]
  );

  const openAddModal = () => {
    draggedSubtaskIdRef.current = "";
    setDraggedSubtaskId("");
    setEditingTaskId("");
    setTaskFormError("");
    setForm(EMPTY_FORM);
    setIsTaskModalOpen(true);
  };

  const closeTaskModal = () => {
    draggedSubtaskIdRef.current = "";
    setDraggedSubtaskId("");
    setIsTaskModalOpen(false);
    setEditingTaskId("");
    setTaskFormError("");
    setForm(EMPTY_FORM);
  };

  const saveTask = () => {
    const isEditingGitHubIssue = isGitHubIssueTask(editingTask);
    const title = isEditingGitHubIssue ? String(editingTask?.title || "").trim() : form.title.trim();
    if (!title) {
      setTaskFormError("Title is required.");
      return;
    }

    const normalizedEstimatedHours = normalizeEstimatedHours(form.estimatedHours);
    if (String(form.estimatedHours || "").trim() && !normalizedEstimatedHours) {
      setTaskFormError("Estimated time must be a valid non-negative number of hours.");
      return;
    }

    const nextTaskShape = {
      completed: isEditingGitHubIssue ? Boolean(editingTask?.completed) : Boolean(form.completed),
      title,
      description: form.description.trim(),
      dueDate: normalizeDateInput(form.dueDate),
      dueTime: normalizeTimeInput(form.dueTime),
      priority: form.sourceGoalId ? 0 : normalizePriority(form.priority),
      estimatedHours: normalizedEstimatedHours,
      subtasks: sanitizeSubtaskList(form.subtasks)
    };

    const duplicateExists = tasks.some((task) => {
      if (isTaskDeleted(task)) {
        return false;
      }
      if (editingTaskId && task.id === editingTaskId) {
        return false;
      }

      return areTasksIdentical(task, nextTaskShape);
    });

    if (duplicateExists) {
      setTaskFormError("An identical task already exists.");
      return;
    }

    setTaskFormError("");

    if (editingTaskId) {
      setTasks((currentTasks) =>
        currentTasks.map((task) =>
          task.id === editingTaskId
            ? {
                ...task,
                ...nextTaskShape,
                updatedAt: Date.now()
              }
            : task
        )
      );
    } else {
      const now = Date.now();
      setTasks((currentTasks) => [
        ...currentTasks,
        {
          id: createTaskId(),
          ...nextTaskShape,
          createdAt: now,
          updatedAt: now
        }
      ]);
    }

    setForm(EMPTY_FORM);
    setEditingTaskId("");
    setIsTaskModalOpen(false);
  };

  const onSubmit = (event) => {
    event.preventDefault();
    saveTask();
  };

  const startEditTask = (task) => {
    const directionalGoalId = getDirectionalGoalId(task);
    setEditingTaskId(task.id);
    setTaskFormError("");
    setForm({
      completed: Boolean(task.completed),
      title: task.title || "",
      description: task.description || "",
      dueDate: task.dueDate || "",
      dueTime: task.dueTime || "",
      priority: directionalGoalId ? 0 : normalizePriority(task.priority, task.materialConsequence),
      sourceGoalId: directionalGoalId,
      estimatedHours: normalizeEstimatedHours(task.estimatedHours),
      subtasks: sanitizeSubtaskList(task.subtasks)
    });
    setIsTaskModalOpen(true);
  };

  const cancelEdit = () => {
    closeTaskModal();
  };

  const deleteTask = (taskId) => {
    const removedTaskIndex = tasks.findIndex((task) => task.id === taskId);
    if (removedTaskIndex === -1) {
      return;
    }

    const removedTask = tasks[removedTaskIndex];
    if (isGitHubIssueTask(removedTask)) {
      return;
    }
    const deletedAt = Date.now();
    setTasks((currentTasks) => currentTasks.map((task) =>
      task.id === taskId ? markTaskDeleted(task, deletedAt) : task
    ));
    queueUndoDelete(removedTask, removedTaskIndex);

    if (editingTaskId === taskId) {
      cancelEdit();
    }
  };

  const queueUndoDelete = (task, index) => {
    if (undoTimeoutRef.current) {
      window.clearTimeout(undoTimeoutRef.current);
    }

    setUndoDeleteState({ task, index });
    undoTimeoutRef.current = window.setTimeout(() => {
      setUndoDeleteState(null);
      undoTimeoutRef.current = null;
    }, 5000);
  };

  const undoDelete = () => {
    if (!undoDeleteState) {
      return;
    }

    if (undoTimeoutRef.current) {
      window.clearTimeout(undoTimeoutRef.current);
      undoTimeoutRef.current = null;
    }

    setTasks((currentTasks) => {
      const restoredAt = Date.now();
      const deletedTaskIndex = currentTasks.findIndex(
        (task) => task.id === undoDeleteState.task.id
      );
      if (deletedTaskIndex !== -1) {
        return currentTasks.map((task, index) =>
          index === deletedTaskIndex
            ? restoreDeletedTask(undoDeleteState.task, restoredAt)
            : task
        );
      }

      const nextTasks = [...currentTasks];
      const insertIndex = Math.max(0, Math.min(undoDeleteState.index, nextTasks.length));
      nextTasks.splice(insertIndex, 0, restoreDeletedTask(undoDeleteState.task, restoredAt));
      return nextTasks;
    });

    setUndoDeleteState(null);
  };

  const duplicateTask = (task) => {
    if (isGitHubIssueTask(task)) return;
    const now = Date.now();
    setTasks((currentTasks) => [
      ...currentTasks,
      {
        ...task,
        id: createTaskId(),
        title: makeCopyTitle(task.title),
        sourceType: "",
        sourceGoalId: "",
        tags: [],
        deleted: false,
        deletedAt: 0,
        subtasks: sanitizeSubtaskList(task.subtasks).map((subtask) => ({
          ...subtask,
          id: createTaskId(),
          createdAt: now,
          updatedAt: now
        })),
        createdAt: now,
        updatedAt: now
      }
    ]);
  };

  const addDraftSubtask = () => {
    const now = Date.now();
    setForm((current) => ({ ...current, subtasks: [...(current.subtasks || []), { id: createTaskId(), title: "", description: "", completed: false, createdAt: now, updatedAt: now }] }));
  };

  const updateDraftSubtask = (subtaskId, updates) => setForm((current) => ({
    ...current,
    subtasks: (current.subtasks || []).map((item) => item.id === subtaskId ? { ...item, ...updates, updatedAt: Date.now() } : item)
  }));

  const removeDraftSubtask = (subtaskId) => setForm((current) => ({ ...current, subtasks: (current.subtasks || []).filter((item) => item.id !== subtaskId) }));

  const moveDraftSubtask = (subtaskId, direction) => setForm((current) => {
    const subtasks = [...(current.subtasks || [])];
    const index = subtasks.findIndex((item) => item.id === subtaskId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= subtasks.length) return current;
    [subtasks[index], subtasks[nextIndex]] = [subtasks[nextIndex], subtasks[index]];
    return { ...current, subtasks };
  });

  const reorderDraftSubtask = (subtaskId, targetSubtaskId, placeAfterTarget) => setForm((current) => {
    if (!subtaskId || !targetSubtaskId || subtaskId === targetSubtaskId) return current;

    const subtasks = [...(current.subtasks || [])];
    const sourceIndex = subtasks.findIndex((item) => item.id === subtaskId);
    if (sourceIndex < 0) return current;

    const [movedSubtask] = subtasks.splice(sourceIndex, 1);
    const targetIndex = subtasks.findIndex((item) => item.id === targetSubtaskId);
    if (targetIndex < 0) return current;

    subtasks.splice(targetIndex + (placeAfterTarget ? 1 : 0), 0, movedSubtask);
    return { ...current, subtasks };
  });

  const startDraftSubtaskDrag = (event, subtaskId) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggedSubtaskIdRef.current = subtaskId;
    setDraggedSubtaskId(subtaskId);
  };

  const dragDraftSubtask = (event) => {
    const subtaskId = draggedSubtaskIdRef.current;
    if (!subtaskId) return;

    event.preventDefault();
    const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
    const hoveredRow = hoveredElement?.closest?.(".task-editor-subtask-row");
    const targetSubtaskId = hoveredRow?.dataset?.subtaskId || "";
    if (!targetSubtaskId || targetSubtaskId === subtaskId) return;

    const bounds = hoveredRow.getBoundingClientRect();
    reorderDraftSubtask(subtaskId, targetSubtaskId, event.clientY > bounds.top + bounds.height / 2);
  };

  const finishDraftSubtaskDrag = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draggedSubtaskIdRef.current = "";
    setDraggedSubtaskId("");
  };

  const toggleTaskSubtask = (taskId, subtaskId) => setTasks((currentTasks) => currentTasks.map((task) =>
    task.id === taskId ? {
      ...task,
      subtasks: (task.subtasks || []).map((item) => item.id === subtaskId ? { ...item, completed: !item.completed, updatedAt: Date.now() } : item),
      updatedAt: Date.now()
    } : task
  ));

  const toggleTaskCompleted = (taskId) => setTasks((currentTasks) => currentTasks.map((task) =>
    task.id === taskId && !isGitHubIssueTask(task)
      ? { ...task, completed: !task.completed, updatedAt: Date.now() }
      : task
  ));

  const renderTaskCard = (task) => {
    const directionalGoalId = getDirectionalGoalId(task);
    const githubBacked = isGitHubIssueTask(task);
    const priorityScore = calculatePriorityScore(task);
    const priorityBand = getPriorityScoreBand(priorityScore);
    const timePressureRatio =
      timePressureByTaskId[task.id] ?? calculateTimePressure(task);
    const timePressureColor = getTimePressureColor(timePressureRatio);
    const description = String(task.description || "").trim();
    const normalizedDueDate = normalizeDateInput(task.dueDate);
    const normalizedEstimatedHours = normalizeEstimatedHours(task.estimatedHours);
    const hasDescription = Boolean(description);
    const hasDueDate = Boolean(normalizedDueDate);
    const hasEstimatedTime = normalizedEstimatedHours !== "";
    const hasTimePressure = hasEstimatedTime
      && timePressureRatio !== null
      && timePressureRatio !== undefined;
    const subtasks = sanitizeSubtaskList(task.subtasks);
    const completedSubtaskCount = subtasks.filter((subtask) => subtask.completed).length;
    const taskSyncBadge = taskCloudSyncBadgesByTaskId[task.id] || {
      label: "Local",
      tone: "local"
    };

    return (
      <article
        key={task.id}
        className={`task-card priority-band-${priorityBand}${directionalGoalId ? " is-directional-goal" : ""}${
          githubBacked ? " is-github-issue" : ""
        }${isMobileExperience ? " task-card-mobile-editable" : ""}`}
        onClick={() => startEditTask(task)}
        onKeyDown={
          (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              startEditTask(task);
            }
          }
        }
        role="button"
        tabIndex={0}
      >
        <button
          type="button"
          className={`task-list-completion${task.completed ? " is-complete" : ""}`}
          onClick={(event) => { event.stopPropagation(); toggleTaskCompleted(task.id); }}
          disabled={githubBacked}
          title={githubBacked ? "Completion is managed by the GitHub issue state" : undefined}
          aria-label={githubBacked ? "Completion managed by GitHub" : task.completed ? "Mark task incomplete" : "Mark task complete"}
        >{task.completed ? "✓" : ""}</button>
        <div className={`task-card-content${task.completed ? " is-complete" : ""}`}>
        <header className="task-card-header">
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
            <span className="task-card-goal-tag">D · Directional</span>
          ) : priorityScore > 0 ? (
            <span className={`task-card-priority-pill priority-band-${priorityBand}`}>
              Priority {priorityScore}
            </span>
          ) : null}
          <span
            className={`task-card-sync-badge task-card-sync-dot is-${taskSyncBadge.tone}`}
            title={taskSyncBadge.label}
            aria-label={taskSyncBadge.label}
          />
          <div className="task-card-actions">
            {!isMobileExperience && !githubBacked ? (
              <button type="button" className="task-card-btn" title="Duplicate" aria-label="Duplicate task" onClick={(event) => { event.stopPropagation(); duplicateTask(task); }}>
                ⧉
              </button>
            ) : null}
            {!isMobileExperience && !githubBacked ? (
              <button
                type="button"
                className="task-card-btn task-card-btn-danger"
                title="Delete"
                aria-label="Delete task"
                onClick={(event) => { event.stopPropagation(); deleteTask(task.id); }}
              >
                ×
              </button>
            ) : null}
          </div>
        </header>
        {hasDescription ? <p className="task-card-description">{description}</p> : null}
        {subtasks.length ? (
          <div className="task-card-subtasks">
            <div className="task-card-subtask-summary"><span>Subtasks</span><strong>{completedSubtaskCount} / {subtasks.length}</strong></div>
            <div className="task-card-subtask-progress" aria-hidden="true"><span style={{ width: `${(completedSubtaskCount / subtasks.length) * 100}%` }} /></div>
            {subtasks.slice(0, 3).map((subtask) => (
              <label className="task-card-subtask" key={subtask.id}>
                <input type="checkbox" checked={subtask.completed} onChange={() => toggleTaskSubtask(task.id, subtask.id)} />
                <span className={subtask.completed ? "is-complete" : ""}>{subtask.title}</span>
              </label>
            ))}
            {subtasks.length > 3 ? <span className="task-card-subtask-more">+{subtasks.length - 3} more</span> : null}
          </div>
        ) : null}
        {hasDueDate ? <p className="task-card-date">{formatDueInDays(task.dueDate, task.dueTime)}</p> : null}
        {hasEstimatedTime || hasTimePressure ? (
          <div className="task-card-metrics">
            {hasEstimatedTime ? (
              <p className="task-card-estimated-time task-card-chip">
                Est: {formatEstimatedHours(normalizedEstimatedHours)}
              </p>
            ) : null}
            {hasTimePressure ? (
              <p className="task-card-time-pressure task-card-chip" style={{ color: timePressureColor }}>
                Pressure: {formatTimePressure(timePressureRatio)}
              </p>
            ) : null}
          </div>
        ) : null}
        </div>
      </article>
    );
  };

  return (
    <AppShell currentPageLabel="Tasks" activeNavItem="tasks" hideMobileNav={isTaskModalOpen}>
      <section className="tasks-workspace">
        <section className="task-board-modal">
          <div className="task-board-toolbar">
            <header className="task-board-header">
              <h2 className="task-board-title">Tasks</h2>
              <p className={`task-board-sync-badge is-${cloudSyncBadge.tone}`}>{cloudSyncBadge.label}</p>
              {averageTimePressure !== null ? <p
                ref={averagePressureRef}
                className="task-board-average-pressure"
                style={{ color: getTimePressureColor(averageTimePressure) }}
              >
                {averagePressureLabel}: {formatTimePressure(averageTimePressure)}
              </p> : null}
              <label className="task-board-sort">
                <span>Sort</span>
                <select
                  className="task-board-sort-select"
                  value={sortMode}
                  onChange={(event) => changeSortMode(event.target.value)}
                >
                  <option value="due-date">Due date</option>
                  <option value="priority">Priority</option>
                </select>
              </label>
              <span className="task-board-list-count">{displayedTasks.length}</span>
            </header>
            <button type="button" className="task-board-add-btn" onClick={openAddModal} aria-label="Add task">
              +
            </button>
          </div>
          {displayedTasks.length === 0 ? (
            <div className="task-board-empty-state">
              <p className="task-board-empty">No tasks yet.</p>
              {taskRecoveryState.status === "available" ? (
                <button type="button" className="task-board-recovery-btn" onClick={restoreTaskBackup}>
                  Restore {sanitizeTaskList(taskRecoveryState.backup.tasks).filter(
                    (task) => !isTaskDeleted(task)
                  ).length} tasks from backup
                </button>
              ) : null}
              {taskRecoveryState.message ? <p className="task-board-recovery-message">{taskRecoveryState.message}</p> : null}
            </div>
          ) : (
            <div className="task-board-list">
              {activeTasks.map(renderTaskCard)}
              {completedTasks.length > 0 ? (
                <div className="task-board-completed-section">
                  <button
                    type="button"
                    className="task-board-completed-heading"
                    onClick={() => setIsCompletedTasksExpanded((current) => !current)}
                    aria-expanded={isCompletedTasksExpanded}
                  >
                    <span className="task-board-completed-chevron" aria-hidden="true">
                      {isCompletedTasksExpanded ? "⌄" : "›"}
                    </span>
                    <h3>Completed Tasks</h3>
                    <span className="task-board-completed-count">{completedTasks.length}</span>
                  </button>
                  {isCompletedTasksExpanded ? (
                    <div className="task-board-completed-list">
                      {completedTasks.map(renderTaskCard)}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          {isTaskModalOpen ? (
            <div className="task-floating-modal" role="dialog" aria-modal="true" aria-label={taskModalTitle}>
              <button
                type="button"
                className="task-floating-backdrop"
                aria-label="Close task editor"
                onClick={closeTaskModal}
              />
              <ModalShell as="form" className="task-editor-modal task-editor-floating-form" onSubmit={onSubmit}>
                  <header className="task-editor-content-header ff-modal-header">
                    <button
                      type="button"
                      className={`task-editor-completion${form.completed ? " is-complete" : ""}`}
                      onClick={() => setForm((current) => ({ ...current, completed: !current.completed }))}
                      disabled={isGitHubIssueTask(editingTask)}
                      title={isGitHubIssueTask(editingTask) ? "Completion is managed by GitHub" : undefined}
                      aria-label={isGitHubIssueTask(editingTask) ? "Completion managed by GitHub" : form.completed ? "Mark task incomplete" : "Mark task complete"}
                    >{form.completed ? "✓" : ""}</button>
                    <div className="task-editor-main-content">
                    <textarea
                      id="task-title"
                      className="task-editor-title-input task-editor-wrapping-title"
                      value={form.title}
                      onChange={(event) => {
                        setForm((current) => ({ ...current, title: event.target.value.replace(/\r?\n/g, " ") }));
                        if (taskFormError) {
                          setTaskFormError("");
                        }
                      }}
                      placeholder="Write task title"
                      rows={1}
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
                      ref={descriptionRef}
                      id="task-description"
                      className="task-editor-description-input"
                      value={form.description}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, description: event.target.value }))
                      }
                      placeholder="Add details for this task"
                      rows={isMobileExperience ? 1 : 5}
                    />
                    </div>
                  </header>

                  <ModalBody className="task-editor-body">

                  <div className="task-editor-metadata-row">
                    <label className="task-editor-meta-control"><span>▣</span><input id="task-due-date" type="date" aria-label="Due date" value={form.dueDate} onChange={(event) => setForm((current) => ({ ...current, dueDate: event.target.value }))} /></label>
                    <label className="task-editor-meta-control"><span>◷</span><input id="task-due-time" type="time" aria-label="Due time" value={form.dueTime} onChange={(event) => setForm((current) => ({ ...current, dueTime: event.target.value }))} /></label>
                    <label className="task-editor-meta-control"><span>Priority</span>
                    <select
                      id="task-priority"
                      aria-label="Priority"
                      value={form.priority}
                      disabled={Boolean(form.sourceGoalId)}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          priority: normalizePriority(event.target.value)
                        }))
                      }
                    >
                      {form.sourceGoalId ? <option value={form.priority}>D · Directional</option> : null}
                      <option value="0">0 · No priority</option>
                      <option value="1">1 · Highest</option>
                      <option value="2">2 · High</option>
                      <option value="3">3 · Medium</option>
                      <option value="4">4 · Lowest</option>
                    </select>
                    </label>
                    <label className="task-editor-meta-control"><span>Estimate</span>
                    <input
                      id="task-estimated-hours"
                      type="number"
                      min="0"
                      step="0.1"
                      value={form.estimatedHours}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, estimatedHours: event.target.value }))
                      }
                      placeholder="—"
                    />
                    <span>h</span></label>
                  </div>

                  <section className="task-editor-subtasks">
                    <div className="task-editor-subtasks-header">
                      <button type="button" className="task-editor-subtasks-toggle" onClick={() => setAreSubtasksExpanded((current) => !current)} aria-expanded={areSubtasksExpanded}>{areSubtasksExpanded ? "⌄" : "›"}</button>
                      <strong>Sub-tasks</strong>
                      <span className="task-editor-subtask-progress-ring">○</span>
                      <span>{(form.subtasks || []).filter((item) => item.completed).length}/{(form.subtasks || []).length}</span>
                      <button type="button" className="task-editor-hide-completed" onClick={() => setHideCompletedSubtasks((current) => !current)}>{hideCompletedSubtasks ? "Show completed" : "Hide completed"}</button>
                    </div>
                    {areSubtasksExpanded ? <div className="task-editor-subtask-list">
                      {(form.subtasks || []).filter((subtask) => !hideCompletedSubtasks || !subtask.completed).map((subtask, index) => (
                        <div
                          className={`task-editor-subtask-row${draggedSubtaskId === subtask.id ? " is-dragging" : ""}`}
                          key={subtask.id}
                          data-subtask-id={subtask.id}
                        >
                          <button
                            type="button"
                            className="task-editor-drag-handle"
                            aria-label={`Reorder ${subtask.title || "subtask"}`}
                            title="Drag to reorder"
                            onPointerDown={(event) => startDraftSubtaskDrag(event, subtask.id)}
                            onPointerMove={dragDraftSubtask}
                            onPointerUp={finishDraftSubtaskDrag}
                            onPointerCancel={finishDraftSubtaskDrag}
                            onKeyDown={(event) => {
                              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                                event.preventDefault();
                                moveDraftSubtask(subtask.id, event.key === "ArrowUp" ? -1 : 1);
                              }
                            }}
                          >
                            ⠿
                          </button>
                          <button type="button" className={`task-editor-completion task-editor-subtask-completion${subtask.completed ? " is-complete" : ""}`} onClick={() => updateDraftSubtask(subtask.id, { completed: !subtask.completed })} aria-label={`Mark ${subtask.title || "subtask"} ${subtask.completed ? "incomplete" : "complete"}`}>{subtask.completed ? "✓" : ""}</button>
                          <div className={`task-editor-subtask-content${subtask.completed ? " is-complete" : ""}`}>
                            <textarea
                              className="task-editor-subtask-title task-editor-wrapping-title"
                              value={subtask.title}
                              onChange={(event) => updateDraftSubtask(subtask.id, { title: event.target.value.replace(/\r?\n/g, " ") })}
                              placeholder="Sub-task title"
                              aria-label="Subtask title"
                              rows={1}
                            />
                            <input className="task-editor-subtask-description" value={subtask.description || ""} onChange={(event) => updateDraftSubtask(subtask.id, { description: event.target.value })} placeholder="Add description" aria-label="Subtask description" />
                          </div>
                          <button type="button" className="task-editor-remove-subtask" onClick={() => removeDraftSubtask(subtask.id)} aria-label="Delete subtask">×</button>
                        </div>
                      ))}
                      <button type="button" className="task-editor-add-subtask" onClick={addDraftSubtask}><span>＋</span> Add sub-task</button>
                    </div> : null}
                  </section>
                  {isMobileExperience && editingTaskId ? (
                    <div className="task-editor-mobile-secondary-actions">
                      <button
                        type="button"
                        className="task-editor-btn task-editor-btn-secondary"
                        onClick={() => {
                          if (editingTask) {
                            duplicateTask(editingTask);
                          }
                        }}
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        className="task-editor-btn task-editor-btn-danger"
                        onClick={() => deleteTask(editingTaskId)}
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                  {taskFormError ? <p className="task-editor-error">{taskFormError}</p> : null}
                  </ModalBody>

                  <ModalFooter className="task-editor-actions">
                    <p className="task-editor-auto-summary" aria-live="polite">
                      {formTimePressure !== null ? <>
                        <span>Pressure: </span>
                        <strong style={{ color: getTimePressureColor(formTimePressure) }}>
                          {formatTimePressure(formTimePressure)}
                        </strong>
                        <span className="task-editor-auto-divider">|</span>
                      </> : null}
                      <span>Priority: </span>
                      <strong>{calculatePriorityScore(form)}</strong>
                    </p>
                    <div className="task-editor-action-buttons">
                      <SecondaryButton onClick={cancelEdit}>Cancel</SecondaryButton>
                      <PrimaryButton onClick={saveTask}>{submitLabel}</PrimaryButton>
                    </div>
                  </ModalFooter>
              </ModalShell>
            </div>
          ) : null}
        </section>

        {undoDeleteState ? (
          <div className="task-undo-layer" aria-live="polite">
            <div className="task-undo-toast" role="status">
              <span>Task deleted.</span>
              <button type="button" className="task-undo-btn" onClick={undoDelete}>
                Undo
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

/* production task sanitization/reconciliation lives in lib/tasks/reconcile.js */
/*
function sanitizeTask(task) {
  if (!task || typeof task !== "object") {
    return null;
  }

  const title = String(task.title || "").trim();
  if (!title) {
    return null;
  }

  const directionalGoalId = getDirectionalGoalId(task);
  const createdAt = Number.isFinite(Number(task.createdAt)) ? Number(task.createdAt) : 0;
  const tombstone = normalizeTaskTombstone(task);
  return {
    id: String(task.id || createTaskId()),
    completed: Boolean(task.completed),
    title,
    description: String(task.description || "").trim(),
    dueDate: normalizeDateInput(task.dueDate),
    dueTime: normalizeTimeInput(task.dueTime),
    priority: directionalGoalId ? 0 : normalizePriority(task.priority, task.materialConsequence),
    estimatedHours: normalizeEstimatedHours(task.estimatedHours ?? task.difficulty),
    subtasks: sanitizeSubtaskList(task.subtasks),
    sourceType: directionalGoalId ? "directional-goal" : "",
    sourceGoalId: directionalGoalId,
    tags: directionalGoalId ? ["directional-goal"] : [],
    deleted: tombstone.deleted,
    deletedAt: tombstone.deletedAt,
    createdAt,
    updatedAt: Number.isFinite(Number(task.updatedAt)) ? Number(task.updatedAt) : createdAt
  };
}

function sanitizeSubtaskList(rawSubtasks) {
  if (!Array.isArray(rawSubtasks)) return [];
  return rawSubtasks.map((subtask) => {
    if (!subtask || typeof subtask !== "object") return null;
    const title = String(subtask.title || "").trim();
    if (!title) return null;
    const createdAt = Number.isFinite(Number(subtask.createdAt)) ? Number(subtask.createdAt) : 0;
    return {
      id: String(subtask.id || createTaskId()),
      title,
      description: String(subtask.description || "").trim(),
      completed: Boolean(subtask.completed),
      createdAt,
      updatedAt: Number.isFinite(Number(subtask.updatedAt)) ? Number(subtask.updatedAt) : createdAt
    };
  }).filter(Boolean);
}

function buildTaskCloudSyncBadges({
  tasks,
  cloudSnapshotSignaturesByTaskId,
  hasSupabase,
  cloudUserId,
  isCloudSyncReady,
  isCloudWriteInFlight,
  didCloudWriteFail
}) {
  const badgeByTaskId = {};
  const safeTasks = Array.isArray(tasks) ? tasks : [];

  safeTasks.forEach((task) => {
    const taskId = String(task?.id || "");

    if (!hasSupabase || !cloudUserId) {
      badgeByTaskId[taskId] = { label: "Local", tone: "local" };
      return;
    }

    if (!isCloudSyncReady) {
      badgeByTaskId[taskId] = { label: "Syncing", tone: "syncing" };
      return;
    }

    if (didCloudWriteFail) {
      badgeByTaskId[taskId] = { label: "Retry", tone: "error" };
      return;
    }

    const cloudSnapshotSignature = cloudSnapshotSignaturesByTaskId?.[taskId];
    const currentTaskSignature = getTaskSyncSignature(task);

    if (!cloudSnapshotSignature) {
      badgeByTaskId[taskId] = isCloudWriteInFlight
        ? { label: "Pending", tone: "pending" }
        : { label: "Local only", tone: "local" };
      return;
    }

    if (cloudSnapshotSignature !== currentTaskSignature) {
      badgeByTaskId[taskId] = { label: "Pending", tone: "pending" };
      return;
    }

    badgeByTaskId[taskId] = { label: "Synced", tone: "synced" };
  });

  return badgeByTaskId;
}

function getTaskSyncSignature(task) {
  const sanitizedTask = sanitizeTask(task);
  if (!sanitizedTask) {
    return "";
  }

  return JSON.stringify({
    id: sanitizedTask.id,
    completed: sanitizedTask.completed,
    title: sanitizedTask.title,
    description: sanitizedTask.description,
    dueDate: sanitizedTask.dueDate,
    dueTime: sanitizedTask.dueTime,
    priority: sanitizedTask.priority,
    estimatedHours: sanitizedTask.estimatedHours,
    subtasks: sanitizedTask.subtasks,
    sourceType: sanitizedTask.sourceType,
    sourceGoalId: sanitizedTask.sourceGoalId,
    tags: sanitizedTask.tags,
    deleted: sanitizedTask.deleted,
    deletedAt: sanitizedTask.deletedAt,
    createdAt: sanitizedTask.createdAt,
    updatedAt: sanitizedTask.updatedAt
  });
}

function createTaskSignatureMap(taskList) {
  const signatureMap = {};
  const safeTasks = Array.isArray(taskList) ? taskList : [];

  safeTasks.forEach((task) => {
    const taskId = String(task?.id || "");
    if (!taskId) {
      return;
    }

    signatureMap[taskId] = getTaskSyncSignature(task);
  });

  return signatureMap;
}

function sanitizeTaskList(rawTasks) {
  if (!Array.isArray(rawTasks)) {
    return [];
  }

  return rawTasks.map((task) => sanitizeTask(task)).filter(Boolean);
}

function mergeTaskSnapshots(preferredTasks, fallbackTasks) {
  const preferred = sanitizeTaskList(preferredTasks);
  const fallback = sanitizeTaskList(fallbackTasks);
  const mergedById = new Map(fallback.map((task) => [task.id, task]));

  preferred.forEach((task) => {
    const existing = mergedById.get(task.id);
    if (!existing || Number(task.updatedAt || 0) >= Number(existing.updatedAt || 0)) {
      mergedById.set(task.id, task);
    }
  });

  return [...mergedById.values()];
}

function reconcileTaskSnapshots(localTasks, remoteTasks, baselineSignaturesByTaskId = {}) {
  const localById = new Map(sanitizeTaskList(localTasks).map((task) => [task.id, task]));
  const remoteById = new Map(sanitizeTaskList(remoteTasks).map((task) => [task.id, task]));
  const baselineSignatures =
    baselineSignaturesByTaskId && typeof baselineSignaturesByTaskId === "object"
      ? baselineSignaturesByTaskId
      : {};
  const taskIds = new Set([
    ...localById.keys(),
    ...remoteById.keys(),
    ...Object.keys(baselineSignatures)
  ]);
  const reconciled = [];

  taskIds.forEach((taskId) => {
    const localTask = localById.get(taskId) || null;
    const remoteTask = remoteById.get(taskId) || null;
    const baselineSignature = String(baselineSignatures[taskId] || "");
    const localSignature = localTask ? getTaskSyncSignature(localTask) : "";
    const remoteSignature = remoteTask ? getTaskSyncSignature(remoteTask) : "";
    const localChanged = localSignature !== baselineSignature;
    const remoteChanged = remoteSignature !== baselineSignature;

    if (localChanged && !remoteChanged) {
      if (localTask) reconciled.push(localTask);
      return;
    }

    if (remoteChanged && !localChanged) {
      if (remoteTask) reconciled.push(remoteTask);
      return;
    }

    if (localChanged && remoteChanged && localTask && remoteTask) {
      const localUpdatedAt = Number(localTask.updatedAt || 0);
      const remoteUpdatedAt = Number(remoteTask.updatedAt || 0);
      reconciled.push(localUpdatedAt > remoteUpdatedAt ? localTask : remoteTask);
      return;
    }

    if (remoteTask) {
      reconciled.push(remoteTask);
    } else if (localTask && localChanged) {
      reconciled.push(localTask);
    }
  });

  return reconciled;
}
*/

function buildTaskCloudSyncBadges({
  tasks,
  cloudSnapshotSignaturesByTaskId,
  hasSupabase,
  cloudUserId,
  isCloudSyncReady,
  isCloudWriteInFlight,
  didCloudWriteFail
}) {
  const badgeByTaskId = {};

  (Array.isArray(tasks) ? tasks : []).forEach((task) => {
    const taskId = String(task?.id || "");
    if (!hasSupabase || !cloudUserId) {
      badgeByTaskId[taskId] = { label: "Local", tone: "local" };
    } else if (!isCloudSyncReady) {
      badgeByTaskId[taskId] = { label: "Syncing", tone: "syncing" };
    } else if (didCloudWriteFail) {
      badgeByTaskId[taskId] = { label: "Retry", tone: "error" };
    } else {
      const cloudSignature = cloudSnapshotSignaturesByTaskId?.[taskId];
      const currentSignature = getTaskSyncSignature(task);
      if (!cloudSignature) {
        badgeByTaskId[taskId] = isCloudWriteInFlight
          ? { label: "Pending", tone: "pending" }
          : { label: "Local only", tone: "local" };
      } else if (cloudSignature !== currentSignature) {
        badgeByTaskId[taskId] = { label: "Pending", tone: "pending" };
      } else {
        badgeByTaskId[taskId] = { label: "Synced", tone: "synced" };
      }
    }
  });

  return badgeByTaskId;
}

function readTasksFromStorage() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(TASK_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    return sanitizeTaskList(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writeTasksToStorage(taskList) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(sanitizeTaskList(taskList)));
}

function getTaskCollectionCacheSignature(cachePayload) {
  const safePayload = cachePayload && typeof cachePayload === "object" ? cachePayload : {};
  const safeTasks = sanitizeTaskList(safePayload.tasks);
  const safeVersion = Number.isFinite(Number(safePayload.version)) ? Number(safePayload.version) : null;
  return JSON.stringify({
    version: safeVersion,
    tasks: safeTasks.map((task) => getTaskSyncSignature(task))
  });
}

function getTaskListParitySignature(taskList) {
  const safeTasks = sanitizeTaskList(taskList);
  return JSON.stringify(safeTasks.map((task) => getTaskSyncSignature(task)));
}

function createTaskId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDateInput(rawValue) {
  if (!rawValue) {
    return "";
  }
  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(0, 10);
}

function normalizeTimeInput(rawValue) {
  if (!rawValue) {
    return "";
  }
  const value = String(rawValue).trim();
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    return "";
  }
  return `${match[1]}:${match[2]}`;
}

function sortTasksByDueDate(first, second) {
  const firstDueTimestamp = getDueTimestamp(first.dueDate, first.dueTime);
  const secondDueTimestamp = getDueTimestamp(second.dueDate, second.dueTime);

  if (firstDueTimestamp === null && secondDueTimestamp === null) {
    return Number(first.createdAt || 0) - Number(second.createdAt || 0);
  }

  if (firstDueTimestamp === null) {
    return 1;
  }

  if (secondDueTimestamp === null) {
    return -1;
  }

  if (firstDueTimestamp !== secondDueTimestamp) {
    return firstDueTimestamp - secondDueTimestamp;
  }

  return Number(first.createdAt || 0) - Number(second.createdAt || 0);
}

function formatDueInDays(dueDate, dueTime) {
  const dueTimestamp = getDueTimestamp(dueDate, dueTime);
  if (dueTimestamp === null) {
    return "No due date";
  }

  const now = Date.now();
  const differenceMs = dueTimestamp - now;
  const isOverdue = differenceMs < 0;
  const absoluteMinutes = Math.floor(Math.abs(differenceMs) / 60000);
  const totalHours = Math.floor(absoluteMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = absoluteMinutes % 60;

  const prefix = isOverdue ? "Overdue by" : "Due in";
  return `${prefix} ${days} ${days === 1 ? "day" : "days"}, ${hours} ${
    hours === 1 ? "hour" : "hours"
  }, and ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function getDueTimestamp(dueDate, dueTime) {
  if (!dueDate) {
    return null;
  }

  const normalizedDate = normalizeDateInput(dueDate);
  if (!normalizedDate) {
    return null;
  }

  const normalizedTime = normalizeTimeInput(dueTime) || "23:59";
  const dueDateTime = new Date(`${normalizedDate}T${normalizedTime}:00`);
  if (Number.isNaN(dueDateTime.getTime())) {
    return null;
  }

  return dueDateTime.getTime();
}

function areTasksIdentical(firstTask, secondTask) {
  const firstTitle = normalizeCompareText(firstTask.title);
  const secondTitle = normalizeCompareText(secondTask.title);
  if (firstTitle !== secondTitle) {
    return false;
  }

  const firstDescription = normalizeCompareText(firstTask.description);
  const secondDescription = normalizeCompareText(secondTask.description);
  if (firstDescription !== secondDescription) {
    return false;
  }

  const firstDueDate = normalizeDateInput(firstTask.dueDate);
  const secondDueDate = normalizeDateInput(secondTask.dueDate);
  if (firstDueDate !== secondDueDate) {
    return false;
  }

  const firstDueTime = normalizeTimeInput(firstTask.dueTime);
  const secondDueTime = normalizeTimeInput(secondTask.dueTime);
  if (firstDueTime !== secondDueTime) {
    return false;
  }

  const firstPriority = normalizePriority(firstTask.priority, firstTask.materialConsequence);
  const secondPriority = normalizePriority(secondTask.priority, secondTask.materialConsequence);
  if (firstPriority !== secondPriority) {
    return false;
  }

  if (normalizeEstimatedHours(firstTask.estimatedHours) !== normalizeEstimatedHours(secondTask.estimatedHours)) {
    return false;
  }

  const comparableSubtasks = (task) => sanitizeSubtaskList(task.subtasks).map((subtask) => ({
    title: normalizeCompareText(subtask.title),
    completed: subtask.completed
  }));
  return JSON.stringify(comparableSubtasks(firstTask)) === JSON.stringify(comparableSubtasks(secondTask));
}

function normalizeCompareText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizePriority(value, legacyConsequence) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 4) {
    return numeric;
  }
  const legacy = String(legacyConsequence || value || "").trim().toLowerCase();
  return legacy && legacy !== "0" && legacy !== "0:none" && legacy !== "none" ? 1 : 0;
}

function getDirectionalGoalId(taskLike) {
  const explicitGoalId = String(taskLike?.sourceGoalId || "").trim();
  if (explicitGoalId) {
    return explicitGoalId;
  }
  const taskId = String(taskLike?.id || "");
  const prefix = "directional-goal-task-";
  return taskId.startsWith(prefix) ? taskId.slice(prefix.length) : "";
}

function normalizeEstimatedHours(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return "";
  }

  const rounded = Math.round(numeric * 100) / 100;
  return String(rounded);
}

function formatEstimatedHours(value) {
  const normalized = normalizeEstimatedHours(value);
  if (!normalized) {
    return "Not set";
  }

  const numeric = Number(normalized);
  return `${numeric.toString()} ${numeric === 1 ? "hour" : "hours"}`;
}

function calculateTimePressure(taskLike, queuedHoursBeforeTask = 0) {
  const normalizedHours = normalizeEstimatedHours(taskLike?.estimatedHours);
  if (!normalizedHours) {
    return null;
  }

  const estimatedHours = Number(normalizedHours);
  if (!Number.isFinite(estimatedHours) || estimatedHours < 0) {
    return null;
  }

  const dueTimestamp = getDueTimestamp(taskLike?.dueDate, taskLike?.dueTime);
  if (dueTimestamp === null) {
    return null;
  }

  const remainingHours = (dueTimestamp - Date.now()) / 3600000;
  if (remainingHours <= 0) {
    return estimatedHours === 0 ? 0 : Number.POSITIVE_INFINITY;
  }

  const awakeHoursUntilDue = getAwakeHoursUntilDue(remainingHours);
  const queuedHours = Math.max(0, Number(queuedHoursBeforeTask) || 0);
  const effectiveAvailableHours = awakeHoursUntilDue - queuedHours;
  if (effectiveAvailableHours <= 0) {
    return estimatedHours === 0 ? 0 : Number.POSITIVE_INFINITY;
  }

  return estimatedHours / effectiveAvailableHours;
}

function formatTimePressure(ratio) {
  if (ratio === null || ratio === undefined) {
    return "0";
  }

  if (!Number.isFinite(ratio)) {
    return "1.00+";
  }

  return (Math.round(ratio * 1000) / 1000).toFixed(3);
}

function calculateAverageTimePressure(taskList, pressureByTaskId) {
  const safeTasks = Array.isArray(taskList) ? taskList : [];
  let total = 0;
  let includedTaskCount = 0;
  let hasInfinitePressure = false;

  safeTasks.forEach((task) => {
    if (!normalizeEstimatedHours(task?.estimatedHours)) {
      return;
    }
    const ratio = pressureByTaskId?.[String(task?.id || "")];
    if (ratio === null || ratio === undefined) {
      return;
    }

    if (!Number.isFinite(ratio)) {
      hasInfinitePressure = true;
      includedTaskCount += 1;
      return;
    }

    total += ratio;
    includedTaskCount += 1;
  });

  if (includedTaskCount === 0) {
    return null;
  }

  if (hasInfinitePressure) {
    return Number.POSITIVE_INFINITY;
  }

  return total / includedTaskCount;
}

function getTimePressureColor(ratio) {
  if (ratio === null || ratio === undefined) {
    return "#94a3b8";
  }

  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 1;

  const safeMidpoint = 0.1;
  const green = [34, 197, 94];
  const white = [255, 255, 255];
  const red = [255, 0, 0];

  if (clamped <= safeMidpoint) {
    const progress = safeMidpoint === 0 ? 1 : clamped / safeMidpoint;
    return mixRgb(green, white, progress);
  }

  const progress = (clamped - safeMidpoint) / (1 - safeMidpoint);
  return mixRgb(white, red, progress);
}

function mixRgb(start, end, progress) {
  const normalizedProgress = Math.max(0, Math.min(1, progress));
  const r = Math.round(start[0] + (end[0] - start[0]) * normalizedProgress);
  const g = Math.round(start[1] + (end[1] - start[1]) * normalizedProgress);
  const b = Math.round(start[2] + (end[2] - start[2]) * normalizedProgress);
  return `rgb(${r}, ${g}, ${b})`;
}

function getAwakeHoursUntilDue(totalHoursUntilDue) {
  const normalizedHours = Number(totalHoursUntilDue);
  if (!Number.isFinite(normalizedHours) || normalizedHours <= 0) {
    return 0;
  }

  if (normalizedHours <= 24) {
    return normalizedHours;
  }

  const fullDayBlocks = Math.floor(normalizedHours / 24);
  const sleepHours = fullDayBlocks * 9;
  return Math.max(0, normalizedHours - sleepHours);
}

function parseEstimatedHours(value) {
  const normalized = normalizeEstimatedHours(value);
  if (!normalized) {
    return 0;
  }

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function buildQueueAdjustedTimePressureByTaskId(taskList) {
  const pressureByTaskId = {};
  let queuedHours = 0;

  const dueOrderedTasks = [...(Array.isArray(taskList) ? taskList : [])].sort(sortTasksByDueDate);

  let taskIndex = 0;
  while (taskIndex < dueOrderedTasks.length) {
    const task = dueOrderedTasks[taskIndex];
    const dueTimestamp = getDueTimestamp(task?.dueDate, task?.dueTime);

    if (dueTimestamp === null) {
      const ratio = calculateTimePressure(task, queuedHours);
      pressureByTaskId[String(task?.id || "")] = ratio;
      taskIndex += 1;
      continue;
    }

    const sameDueTasks = [];
    let scanIndex = taskIndex;
    while (scanIndex < dueOrderedTasks.length) {
      const scanTask = dueOrderedTasks[scanIndex];
      const scanDueTimestamp = getDueTimestamp(scanTask?.dueDate, scanTask?.dueTime);
      if (scanDueTimestamp !== dueTimestamp) {
        break;
      }
      sameDueTasks.push(scanTask);
      scanIndex += 1;
    }

    const estimatedTasks = sameDueTasks.filter(
      (sameDueTask) => Boolean(normalizeEstimatedHours(sameDueTask?.estimatedHours))
    );
    const combinedEstimatedHours = estimatedTasks.reduce(
      (totalHours, sameDueTask) => totalHours + parseEstimatedHours(sameDueTask?.estimatedHours),
      0
    );
    const groupRatio = estimatedTasks.length ? calculateTimePressure(
      {
        dueDate: task?.dueDate,
        dueTime: task?.dueTime,
        estimatedHours: String(combinedEstimatedHours)
      },
      queuedHours
    ) : null;

    sameDueTasks.forEach((sameDueTask) => {
      pressureByTaskId[String(sameDueTask?.id || "")] = normalizeEstimatedHours(sameDueTask?.estimatedHours)
        ? groupRatio
        : null;
    });

    queuedHours += combinedEstimatedHours;
    taskIndex = scanIndex;
  }

  return pressureByTaskId;
}

function calculateDraftQueueAdjustedTimePressure(formState, taskList, editingTaskId) {
  if (!normalizeEstimatedHours(formState?.estimatedHours)) {
    return null;
  }
  const draftTaskId = editingTaskId || "__draft-time-pressure-task__";
  const draftTask = {
    id: draftTaskId,
    title: formState?.title || "",
    description: formState?.description || "",
    dueDate: formState?.dueDate || "",
    dueTime: formState?.dueTime || "",
    priority: normalizePriority(formState?.priority, formState?.materialConsequence),
    estimatedHours: formState?.estimatedHours ?? "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const allOtherTasks = (Array.isArray(taskList) ? taskList : []).filter((task) => task?.id !== editingTaskId);
  const pressureByTaskId = buildQueueAdjustedTimePressureByTaskId([...allOtherTasks, draftTask]);
  return pressureByTaskId[draftTaskId] ?? null;
}

function calculatePriorityScore(taskLike) {
  return normalizePriority(taskLike?.priority, taskLike?.materialConsequence);
}

function getPriorityScoreBand(score) {
  const priority = normalizePriority(score);
  if (priority === 1) return "critical";
  if (priority === 2) return "high";
  if (priority === 3) return "medium";
  if (priority === 4) return "low";
  return "none";
}

function makeCopyTitle(title) {
  const base = String(title || "").trim().replace(/\s*\(copy\)\s*$/i, "");
  return `${base} (Copy)`;
}
