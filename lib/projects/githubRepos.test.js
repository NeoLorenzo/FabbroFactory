import { describe, expect, it } from "vitest";
import { getVisibleGitHubRepos } from "./githubRepos";

const repo = (overrides = {}) => ({
  id: "github-repo-1",
  category: "NeoLorenzo Coding",
  title: "Repo",
  completionStatus: "active",
  repoStatusTag: "active",
  isArchived: false,
  stargazersCount: 1,
  updatedAt: 1,
  ...overrides
});

describe("getVisibleGitHubRepos", () => {
  it("keeps only active, non-archived GitHub projects with at least one star", () => {
    const visible = getVisibleGitHubRepos([
      repo({ id: "visible", title: "Visible" }),
      repo({ id: "completed", completionStatus: "completed" }),
      repo({ id: "archived", isArchived: true }),
      repo({ id: "zero-stars", stargazersCount: 0 }),
      repo({ id: "other-category", category: "Elsewhere" })
    ]);

    expect(visible.map((project) => project.id)).toEqual(["visible"]);
  });

  it("sorts by last commit, falls back to update time, and breaks ties by title", () => {
    const visible = getVisibleGitHubRepos([
      repo({ id: "update-fallback", title: "Update fallback", updatedAt: 400 }),
      repo({ id: "old", title: "Old", lastCommitAt: 100, updatedAt: 1000 }),
      repo({ id: "new", title: "New", lastCommitAt: 900, updatedAt: 1 }),
      repo({ id: "z-tie", title: "Zeta", lastCommitAt: 500 }),
      repo({ id: "a-tie", title: "Alpha", lastCommitAt: 500 })
    ]);

    expect(visible.map((project) => project.id)).toEqual([
      "new",
      "a-tie",
      "z-tie",
      "update-fallback",
      "old"
    ]);
  });
});
