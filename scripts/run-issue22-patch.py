from pathlib import Path

script_path = Path("scripts/apply-issue22-github-task-sync.py")
script = script_path.read_text()

old = '''index = replace_once(
    index,
    '      return jsonResponse({ integration: result.integration, repoCount: result.repoCount });\\n',
    '      return jsonResponse({ integration: result.integration, repoCount: result.repoCount, issueCount: result.issueCount });\\n',
    "link response issue count",
)
index = replace_once(
    index,
    '      return jsonResponse({ integration: result.integration, repoCount: result.repoCount });\\n',
    '      return jsonResponse({ integration: result.integration, repoCount: result.repoCount, issueCount: result.issueCount });\\n',
    "reconcile response issue count",
)
'''

new = '''response_line = '      return jsonResponse({ integration: result.integration, repoCount: result.repoCount });\\n'
response_with_issues = '      return jsonResponse({ integration: result.integration, repoCount: result.repoCount, issueCount: result.issueCount });\\n'
response_count = index.count(response_line)
if response_count != 2:
    raise RuntimeError(f"link/reconcile response issue count: expected exactly two matches, found {response_count}")
index = index.replace(response_line, response_with_issues, 2)
'''

if script.count(old) != 1:
    raise RuntimeError("Could not locate the original duplicate-response assertion block.")
script = script.replace(old, new, 1)
exec(compile(script, str(script_path), "exec"), {"__name__": "__main__"})
