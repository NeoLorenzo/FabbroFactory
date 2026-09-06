import { describe, expect, it } from "vitest";
import {
  buildReconciledIssueTasks,
  getTaskGitHubIssueId
} from "./githubIssueTasks";

const issue = (overrides: Record<string, unknown> = {}) => ({
  id: 1001,
  number: 22,
  title: "Sync GitHub issues",
  state: "open",
  html_url: "https://github.com/NeoLorenzo/Ariadne/issues/22",
  created_at: "2026-09-06T13:35:37Z",
  updated_at: "2026-09-06T13:35:37Z",
  repository: {
    id: 1223499763,
    full_name: "NeoLorenzo/Ariadne"
  },
  ...overrides
});

describe("GitHub issue task reconciliation", () => {
  it("creates one GitHub-backed task for an open issue without changing native tasks", () => {
    const native = { id: "native-1", title: "Native task", priority: 2 };
    const result = buildReconciledIssueTasks([native], [issue()]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(native);
    expect(result[1]).toMatchObject({
      id: "github-issue-1001",
      sourceType: "github-issue",
      title: "Sync GitHub issues",
      completed: false,
      githubIssueId: 1001,
      githubRepositoryId: 1223499763,
      githubRepositoryFullName: "NeoLorenzo/Ariadne",
      githubIssueNumber: 22,
      githubIssueUrl: "https://github.com/NeoLorenzo/Ariadne/issues/22",
      githubIssueState: "open"
    });
  });

  it("is idempotent and does not duplicate repeated deliveries", () => {
    const first = buildReconciledIssueTasks([], [issue()]);
    const second = buildReconciledIssueTasks(first, [issue(), issue()]);

    expect(second).toHaveLength(1);
    expect(getTaskGitHubIssueId(second[0])).toBe(1001);
  });

  it("updates title, close, and reopen on the same task while preserving Ariadne-owned metadata", () => {
    const [created] = buildReconciledIssueTasks([], [issue()]);
    const customized = {
      ...created,
      priority: 3,
      description: "Ariadne notes",
      dueDate: "2026-09-10",
      estimatedHours: "2.5",
      subtasks: [{ id: "s1", title: "Local subtask", completed: false }],
      updatedAt: 123456789
    };

    const [closed] = buildReconciledIssueTasks([customized], [
      issue({
        title: "Renamed on GitHub",
        state: "closed",
        updated_at: "2026-09-06T15:00:00Z"
      })
    ]);

    expect(closed).toMatchObject({
      id: "github-issue-1001",
      title: "Renamed on GitHub",
      completed: true,
      githubIssueState: "closed",
      priority: 3,
      description: "Ariadne notes",
      dueDate: "2026-09-10",
      estimatedHours: "2.5",
      updatedAt: 123456789
    });
    expect((closed as any).subtasks).toEqual(customized.subtasks);

    const [reopened] = buildReconciledIssueTasks([closed], [
      issue({
        title: "Renamed on GitHub",
        state: "open",
        updated_at: "2026-09-06T16:00:00Z"
      })
    ]);
    expect(reopened).toMatchObject({
      id: "github-issue-1001",
      completed: false,
      githubIssueState: "open",
      priority: 3,
      description: "Ariadne notes"
    });
  });

  it("does not import historical closed issues that were never represented in Ariadne", () => {
    const result = buildReconciledIssueTasks([], [
      issue({ state: "closed", updated_at: "2026-09-06T17:00:00Z" })
    ]);
    expect(result).toEqual([]);
  });

  it("collapses accidental duplicate task records for the same GitHub issue", () => {
    const duplicateA = {
      id: "github-issue-1001",
      sourceType: "github-issue",
      githubIssueId: 1001,
      title: "Old A"
    };
    const duplicateB = {
      id: "legacy-copy",
      sourceType: "github-issue",
      githubIssueId: 1001,
      title: "Old B"
    };

    const result = buildReconciledIssueTasks([duplicateA, duplicateB], [issue()]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "github-issue-1001",
      title: "Sync GitHub issues"
    });
  });

  it("repairs stale GitHub-owned fields during a later full reconciliation", () => {
    const stale = {
      id: "github-issue-1001",
      sourceType: "github-issue",
      githubIssueId: 1001,
      githubRepositoryId: 1223499763,
      githubRepositoryFullName: "NeoLorenzo/Ariadne",
      githubIssueNumber: 22,
      githubIssueUrl: "https://github.com/NeoLorenzo/Ariadne/issues/22",
      githubIssueState: "open",
      githubIssueUpdatedAt: 1,
      title: "Stale title",
      completed: false,
      priority: 4,
      description: "Keep this"
    };

    const [repaired] = buildReconciledIssueTasks([stale], [
      issue({
        title: "Authoritative title",
        state: "closed",
        updated_at: "2026-09-06T18:00:00Z"
      })
    ]);

    expect(repaired).toMatchObject({
      title: "Authoritative title",
      completed: true,
      githubIssueState: "closed",
      priority: 4,
      description: "Keep this"
    });
  });
});
