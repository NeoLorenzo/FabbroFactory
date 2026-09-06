import { describe, expect, it } from "vitest";
import {
  createTaskSignatureMap,
  getTaskSyncSignature,
  isGitHubIssueTask,
  reconcileTaskSnapshots,
  sanitizeTaskList
} from "./reconcile";

const task = (id, title, updatedAt, extra = {}) => ({ id, title, updatedAt, createdAt: 1, ...extra });
const baseline = (items) => createTaskSignatureMap(items);
const githubTask = (extra = {}) => ({
  id: "github-issue-1001",
  title: "Canonical title",
  completed: false,
  priority: 1,
  description: "",
  updatedAt: 10,
  createdAt: 1,
  sourceType: "github-issue",
  githubIssueId: 1001,
  githubRepositoryId: 1223499763,
  githubRepositoryFullName: "NeoLorenzo/Ariadne",
  githubIssueNumber: 22,
  githubIssueUrl: "https://github.com/NeoLorenzo/Ariadne/issues/22",
  githubIssueState: "open",
  githubIssueUpdatedAt: 100,
  ...extra
});

describe("task synchronization reconciliation", () => {
  it("keeps independent local and remote edits", () => {
    const b = [task("a", "A", 1), task("b", "B", 1)];
    expect(reconcileTaskSnapshots([task("a", "local", 2), b[1]], [b[0], task("b", "remote", 3)], baseline(b)).map((x) => [x.id, x.title])).toEqual([["a", "local"], ["b", "remote"]]);
  });
  it("accepts one-sided edits", () => {
    const b = [task("a", "A", 1)];
    expect(reconcileTaskSnapshots(b, [task("a", "remote", 2)], baseline(b))[0].title).toBe("remote");
    expect(reconcileTaskSnapshots([task("a", "local", 2)], b, baseline(b))[0].title).toBe("local");
  });
  it("uses updatedAt and remote on an exact tie", () => {
    const b = [task("a", "A", 1)];
    expect(reconcileTaskSnapshots([task("a", "local", 3)], [task("a", "remote", 2)], baseline(b))[0].title).toBe("local");
    expect(reconcileTaskSnapshots([task("a", "local", 3)], [task("a", "remote", 3)], baseline(b))[0].title).toBe("remote");
  });
  it("preserves tombstones and additions", () => {
    const b = [task("a", "A", 1)];
    const tombstone = task("a", "A", 2, { deleted: true, deletedAt: 2 });
    expect(reconcileTaskSnapshots([tombstone], b, baseline(b))[0].deleted).toBe(true);
    expect(reconcileTaskSnapshots([task("l", "L", 2)], [task("r", "R", 2)], {} ).map((x) => x.id)).toEqual(["l", "r"]);
  });
  it("derives directional status without persisting the legacy P1 coercion", () => {
    const [directional] = sanitizeTaskList([
      task("directional-goal-task-goal-1", "Direction-linked", 2, {
        priority: 1,
        sourceGoalId: "goal-1"
      })
    ]);

    expect(directional.priority).toBe(0);
    expect(directional.sourceGoalId).toBe("goal-1");
    expect(directional.sourceType).toBe("directional-goal");
    expect(directional.tags).toEqual(["directional-goal"]);

    const reconciled = reconcileTaskSnapshots([directional], [directional], baseline([directional]));
    expect(reconciled[0].priority).toBe(0);
    expect(reconciled[0].sourceGoalId).toBe("goal-1");
  });
  it("retains rich task data and invalid input is safe", () => {
    const rich = task("a", "A", 2, { priority: 3, dueDate: "2026-08-31", dueTime: "09:30", subtasks: [{ id: "s2", title: "Two" }, { id: "s1", title: "One" }] });
    const result = reconcileTaskSnapshots([rich], [task("a", "A", 1)], baseline([task("a", "A", 1)]))[0];
    expect(result.subtasks.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(result.priority).toBe(3);
    expect(sanitizeTaskList(null)).toEqual([]);
    expect(getTaskSyncSignature(result)).toBe(getTaskSyncSignature(result));
  });

  it("preserves bounded GitHub issue provenance through sanitization", () => {
    const [result] = sanitizeTaskList([githubTask({ tags: ["keep-me"], deleted: true, deletedAt: 999 })]);
    expect(isGitHubIssueTask(result)).toBe(true);
    expect(result).toMatchObject({
      id: "github-issue-1001",
      sourceType: "github-issue",
      sourceGoalId: "",
      githubIssueId: 1001,
      githubRepositoryId: 1223499763,
      githubRepositoryFullName: "NeoLorenzo/Ariadne",
      githubIssueNumber: 22,
      githubIssueUrl: "https://github.com/NeoLorenzo/Ariadne/issues/22",
      githubIssueState: "open",
      githubIssueUpdatedAt: 100,
      deleted: false,
      deletedAt: 0,
      tags: ["keep-me"]
    });
  });

  it("accepts newer GitHub title/state while preserving newer Ariadne execution metadata", () => {
    const base = githubTask({
      title: "Old GitHub title",
      priority: 1,
      description: "Old note",
      updatedAt: 10,
      githubIssueUpdatedAt: 100
    });
    const local = githubTask({
      title: "Old GitHub title",
      priority: 4,
      description: "New Ariadne note",
      dueDate: "2026-09-10",
      updatedAt: 300,
      githubIssueUpdatedAt: 100
    });
    const remote = githubTask({
      title: "Renamed on GitHub",
      completed: true,
      githubIssueState: "closed",
      priority: 1,
      description: "Old note",
      updatedAt: 10,
      githubIssueUpdatedAt: 400
    });

    const [result] = reconcileTaskSnapshots([local], [remote], baseline([base]));
    expect(result).toMatchObject({
      title: "Renamed on GitHub",
      completed: true,
      githubIssueState: "closed",
      githubIssueUpdatedAt: 400,
      priority: 4,
      description: "New Ariadne note",
      dueDate: "2026-09-10",
      updatedAt: 300
    });
  });

  it("rejects a local GitHub-title/completion divergence when GitHub revision is unchanged", () => {
    const base = githubTask();
    const local = githubTask({
      title: "Locally renamed incorrectly",
      completed: true,
      githubIssueState: "closed",
      priority: 3,
      updatedAt: 500,
      githubIssueUpdatedAt: 100
    });
    const remote = githubTask({
      title: "Canonical title",
      completed: false,
      githubIssueState: "open",
      priority: 1,
      updatedAt: 10,
      githubIssueUpdatedAt: 100
    });

    const [result] = reconcileTaskSnapshots([local], [remote], baseline([base]));
    expect(result).toMatchObject({
      title: "Canonical title",
      completed: false,
      githubIssueState: "open",
      priority: 3,
      updatedAt: 500
    });
  });
});
