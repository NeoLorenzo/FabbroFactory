export const GITHUB_COMPANY_CATEGORIES = ["NeoLorenzo Coding"];
export const LEGACY_CATEGORY_TO_COMPANY = {
  Programming: "NeoLorenzo Coding",
  NeoLorenzo: "NeoLorenzo Coding"
};

export function getVisibleGitHubRepos(projectList) {
  const githubCategorySet = new Set(GITHUB_COMPANY_CATEGORIES);
  return (Array.isArray(projectList) ? projectList : [])
    .filter((project) => {
      const rawCategory = String(project?.category || "").trim();
      const category = LEGACY_CATEGORY_TO_COMPANY[rawCategory] || rawCategory;
      if (!githubCategorySet.has(category)) return false;
      if (project?.isArchived) return false;
      if (String(project?.completionStatus || "").trim().toLowerCase() === "completed") return false;

      const stars = Number(project?.stargazersCount);
      return !Number.isFinite(stars) || stars >= 1;
    })
    .sort((left, right) => {
      const leftLastCommitAt = Number(left?.lastCommitAt);
      const rightLastCommitAt = Number(right?.lastCommitAt);
      const leftPrimary = Number.isFinite(leftLastCommitAt) ? leftLastCommitAt : Number(left?.updatedAt || 0);
      const rightPrimary = Number.isFinite(rightLastCommitAt) ? rightLastCommitAt : Number(right?.updatedAt || 0);

      if (rightPrimary !== leftPrimary) return rightPrimary - leftPrimary;
      return String(left?.title || "").localeCompare(String(right?.title || ""));
    });
}
