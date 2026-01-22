const fs = require("fs");
const path = require("path");

const initialEnvKeys = new Set(Object.keys(process.env));

function applyEnvFile(fileName, allowOverride) {
  const filePath = path.join(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (!key) {
      continue;
    }
    const quoted =
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    }
    if (!process.env[key] || (allowOverride && !initialEnvKeys.has(key))) {
      process.env[key] = value;
    }
  }
}

applyEnvFile(".env", false);
applyEnvFile(".env.local", true);

const token = process.env.GH_ACTIVITY_TOKEN;
if (!token) {
  console.error("GH_ACTIVITY_TOKEN is required to read contributions.");
  process.exit(1);
}

const login =
  process.env.GH_ACTIVITY_USER ||
  process.env.GITHUB_REPOSITORY_OWNER ||
  "";
if (!login) {
  console.error("GH_ACTIVITY_USER or GITHUB_REPOSITORY_OWNER is required.");
  process.exit(1);
}

const days = Number.parseInt(process.env.GH_ACTIVITY_DAYS || "30", 10);
if (!Number.isFinite(days) || days <= 0) {
  console.error("GH_ACTIVITY_DAYS must be a positive integer.");
  process.exit(1);
}

const excludedRepos = new Set(
  (process.env.GH_ACTIVITY_EXCLUDE || "")
    .split(/[\n,]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);

const quickCloseMinutes = Number.parseInt(
  process.env.GH_ACTIVITY_PR_QUICK_CLOSE_MINUTES || "30",
  10
);
const quickCloseMs =
  Number.isFinite(quickCloseMinutes) && quickCloseMinutes >= 0
    ? quickCloseMinutes * 60 * 1000
    : 30 * 60 * 1000;

const timeZone = process.env.GH_ACTIVITY_TIMEZONE || "UTC";
const useCalendarMonth = ["1", "true", "yes"].includes(
  String(process.env.GH_ACTIVITY_CALENDAR_MONTH || "").toLowerCase()
);

const now = new Date();
const { from, to, windowLabel } = buildTimeWindow(
  now,
  timeZone,
  days,
  useCalendarMonth
);

// ============ REST API helpers ============

async function restGet(endpoint, params = {}) {
  const url = new URL(endpoint, "https://api.github.com");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tmustier-profile-activity",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${body}`);
  }

  return {
    data: await response.json(),
    headers: response.headers,
  };
}

async function restGetAllPages(endpoint, params = {}, maxPages = 10) {
  const results = [];
  let page = 1;

  while (page <= maxPages) {
    const { data, headers } = await restGet(endpoint, { ...params, per_page: 100, page });
    if (Array.isArray(data)) {
      results.push(...data);
      if (data.length < 100) break;
    } else {
      results.push(data);
      break;
    }

    const linkHeader = headers.get("link");
    if (!linkHeader || !linkHeader.includes('rel="next"')) {
      break;
    }
    page++;
  }

  return results;
}

async function searchAllPages(queryString, maxPages = 10) {
  const results = [];
  let page = 1;

  while (page <= maxPages) {
    const { data } = await restGet("/search/issues", { q: queryString, per_page: 100, page });
    if (data.items && Array.isArray(data.items)) {
      results.push(...data.items);
      if (data.items.length < 100) break;
    } else {
      break;
    }
    page++;
  }

  return results;
}

async function searchCommitsAllPages(queryString, maxPages = 10) {
  const results = [];
  let page = 1;

  while (page <= maxPages) {
    const response = await fetch(
      `https://api.github.com/search/commits?q=${encodeURIComponent(queryString)}&per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "tmustier-profile-activity",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!response.ok) {
      // Search may fail for rate limits or other reasons, just return what we have
      break;
    }

    const data = await response.json();
    if (data.items && Array.isArray(data.items)) {
      results.push(...data.items);
      if (data.items.length < 100) break;
    } else {
      break;
    }
    page++;
  }

  return results;
}

// ============ Date helpers (unchanged) ============

function getZonedDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number.parseInt(lookup.year, 10),
    month: Number.parseInt(lookup.month, 10),
    day: Number.parseInt(lookup.day, 10),
  };
}

function getOffsetMinutes(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const tzPart = parts.find((part) => part.type === "timeZoneName");
  if (!tzPart || !tzPart.value) {
    return 0;
  }
  const match = tzPart.value.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
  if (!match) {
    return 0;
  }
  const sign = match[1].startsWith("-") ? -1 : 1;
  const hours = Math.abs(Number.parseInt(match[1], 10));
  const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
  return sign * (hours * 60 + minutes);
}

function getZonedStartOfDayUtc(date, timeZone) {
  const { year, month, day } = getZonedDateParts(date, timeZone);
  const baseUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let utcMs = baseUtc;
  for (let i = 0; i < 2; i += 1) {
    const offsetMinutes = getOffsetMinutes(new Date(utcMs), timeZone);
    const adjusted = baseUtc - offsetMinutes * 60 * 1000;
    if (adjusted === utcMs) {
      break;
    }
    utcMs = adjusted;
  }
  return new Date(utcMs);
}

function getZonedStartOfNextDayUtc(date, timeZone) {
  const { year, month, day } = getZonedDateParts(date, timeZone);
  const probe = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
  return getZonedStartOfDayUtc(probe, timeZone);
}

function getZonedEndOfDayUtc(date, timeZone) {
  const nextStart = getZonedStartOfNextDayUtc(date, timeZone);
  return new Date(nextStart.getTime() - 1);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildTimeWindow(now, timeZone, windowDays, useMonth) {
  const todayEnd = getZonedEndOfDayUtc(now, timeZone);
  const { year, month, day } = getZonedDateParts(now, timeZone);

  if (useMonth) {
    let targetYear = year;
    let targetMonth = month - 1;
    if (targetMonth < 1) {
      targetMonth = 12;
      targetYear -= 1;
    }
    const maxDay = daysInMonth(targetYear, targetMonth);
    const targetDay = Math.min(day, maxDay);
    const probe = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay, 12, 0, 0));
    return {
      from: getZonedStartOfDayUtc(probe, timeZone),
      to: todayEnd,
      windowLabel: "last month",
    };
  }

  const probe = new Date(Date.UTC(year, month - 1, day - (windowDays - 1), 12, 0, 0));
  return {
    from: getZonedStartOfDayUtc(probe, timeZone),
    to: todayEnd,
    windowLabel: `last ${windowDays} days`,
  };
}

function formatDateForSearch(date) {
  return date.toISOString().split("T")[0];
}

// ============ Label helpers (unchanged) ============

function labelFromIssueUrl(url) {
  if (!url) return "issue";
  const match = url.match(/\/issues\/(\d+)/);
  return match ? `issue #${match[1]}` : "issue";
}

function labelFromPullUrl(url) {
  if (!url) return "PR";
  const match = url.match(/\/pull\/(\d+)/);
  return match ? `PR #${match[1]}` : "PR";
}

function labelFromKind(kind, url) {
  switch (kind) {
    case "issue":
      return labelFromIssueUrl(url);
    case "pr":
      return labelFromPullUrl(url);
    default:
      return "activity";
  }
}

// ============ Table builder (unchanged) ============

function buildTable(other, own, windowLabel, ownerLogin) {
  const lines = [
    "| Repo | Past month | Latest |",
    "| --- | ---: | --- |",
  ];

  const sections = [
    { label: "Other people's repos", items: other },
    { label: "My repos", items: own },
  ];

  for (const section of sections) {
    if (!section.items.length) {
      lines.push(
        `| **${section.label}** | _No contributions in the ${windowLabel}._ | |`
      );
      continue;
    }

    lines.push(`| **${section.label}** |  |  |`);

    for (const item of section.items) {
      const isOwnRepo = item.name.startsWith(`${ownerLogin}/`);
      const displayName = isOwnRepo
        ? item.name.slice(ownerLogin.length + 1)
        : item.name;
      const repoLink = `[${displayName}](https://github.com/${item.name})`;
      let label = item.lastAt
        ? labelFromKind(item.lastKind, item.lastUrl)
        : "n/a";
      let url = item.lastUrl;

      if (item.lastKind === "commit") {
        label = item.repoCommitTotal != null ? `commit #${item.repoCommitTotal}` : "commits";
        url = isOwnRepo
          ? `https://github.com/${item.name}/commits`
          : item.userLatestCommitUrl || item.repoLatestCommitUrl || `https://github.com/${item.name}/commits`;
      }

      const last = url ? `[${label}](${url})` : label;
      lines.push(`| ${repoLink} | ${item.total} | ${last} |`);
    }
  }

  return lines.join("\n");
}

// ============ Contribution tracking ============

function isQuickClosedPullRequest(pr) {
  if (!pr || !pr.created_at || !pr.closed_at) {
    return false;
  }
  if (pr.merged_at) {
    return false;
  }
  const created = new Date(pr.created_at).getTime();
  const closed = new Date(pr.closed_at).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(closed)) {
    return false;
  }
  return closed - created <= quickCloseMs;
}

function mergeContribution(map, repoName, count, occurredAt, url, kind) {
  if (!repoName || count <= 0) {
    return;
  }

  if (excludedRepos.has(repoName.toLowerCase())) {
    return;
  }

  let entry = map.get(repoName);
  if (!entry) {
    entry = {
      name: repoName,
      total: 0,
      lastAt: null,
      lastUrl: null,
      lastKind: null,
      repoCommitTotal: null,
      repoLatestCommitUrl: null,
      userLatestCommitUrl: null,
    };
    map.set(repoName, entry);
  }

  entry.total += count;

  if (occurredAt) {
    const date = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
    if (!entry.lastAt || date > entry.lastAt) {
      entry.lastAt = date;
      entry.lastUrl = url || entry.lastUrl;
      entry.lastKind = kind || entry.lastKind;
    }
  }
}

async function isRepoFork(repoName) {
  try {
    const { data } = await restGet(`/repos/${repoName}`);
    return data.fork === true;
  } catch (e) {
    return false;
  }
}

async function splitSections(map, ownerLogin) {
  const own = [];
  const other = [];
  const prefix = `${ownerLogin.toLowerCase()}/`;

  for (const item of map.values()) {
    if (item.total <= 0) {
      continue;
    }

    if (item.name.toLowerCase().startsWith(prefix)) {
      own.push(item);
    } else {
      other.push(item);
    }
  }

  // Filter out forks from "other people's repos" section
  const filteredOther = [];
  for (const item of other) {
    const isFork = await isRepoFork(item.name);
    if (!isFork) {
      filteredOther.push(item);
    }
  }

  const sorter = (a, b) => {
    const aTime = a.lastAt ? a.lastAt.getTime() : 0;
    const bTime = b.lastAt ? b.lastAt.getTime() : 0;
    if (bTime !== aTime) {
      return bTime - aTime;
    }
    if (b.total !== a.total) {
      return b.total - a.total;
    }
    return a.name.localeCompare(b.name);
  };

  own.sort(sorter);
  filteredOther.sort(sorter);

  return { own, other: filteredOther };
}

// ============ REST API data fetchers ============

async function fetchViewer() {
  const { data } = await restGet("/user");
  return { id: data.id, login: data.login, name: data.name };
}

async function fetchUserRepos() {
  // Get all repos user has push access to (owner, collaborator, org member)
  const repos = await restGetAllPages("/user/repos", {
    affiliation: "owner,collaborator,organization_member",
    sort: "pushed",
    direction: "desc",
  });

  return repos
    .filter((repo) => !repo.fork)
    .filter((repo) => !excludedRepos.has(repo.full_name.toLowerCase()))
    .map((repo) => ({
      nameWithOwner: repo.full_name,
      isPrivate: repo.private,
    }));
}

async function fetchCommitsViaSearch(userLogin, fromDate, toDate) {
  // Search commits by author in the date range
  // Note: Search only covers repos the token has access to
  const fromStr = formatDateForSearch(fromDate);
  const toStr = formatDateForSearch(toDate);
  const query = `author:${userLogin} committer-date:${fromStr}..${toStr}`;

  const commits = await searchCommitsAllPages(query);

  // Group by repo, tracking which commit SHAs we've seen to dedupe across forks
  const seenShas = new Set();
  const byRepo = new Map();

  for (const commit of commits) {
    const repoName = commit.repository?.full_name;
    if (!repoName) continue;

    // Skip forks - commits in forks are duplicates from upstream
    if (commit.repository?.fork) continue;

    // Skip if we've already counted this commit SHA (can appear in multiple forks)
    const sha = commit.sha;
    if (seenShas.has(sha)) continue;
    seenShas.add(sha);

    if (!byRepo.has(repoName)) {
      byRepo.set(repoName, { count: 0, lastAt: null, lastUrl: null });
    }
    const entry = byRepo.get(repoName);
    entry.count += 1;

    const date = new Date(commit.commit?.author?.date || commit.commit?.committer?.date);
    if (!entry.lastAt || date > entry.lastAt) {
      entry.lastAt = date;
      entry.lastUrl = commit.html_url;
    }
  }

  return byRepo;
}

async function fetchIssuesViaSearch(userLogin, fromDate, toDate) {
  const fromStr = formatDateForSearch(fromDate);
  const toStr = formatDateForSearch(toDate);
  const query = `author:${userLogin} type:issue created:${fromStr}..${toStr}`;

  const issues = await searchAllPages(query);

  // Group by repo
  const byRepo = new Map();
  for (const issue of issues) {
    const repoUrl = issue.repository_url;
    if (!repoUrl) continue;

    // Extract repo name from URL: https://api.github.com/repos/owner/name
    const match = repoUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
    if (!match) continue;
    const repoName = match[1];

    if (!byRepo.has(repoName)) {
      byRepo.set(repoName, { count: 0, lastAt: null, lastUrl: null });
    }
    const entry = byRepo.get(repoName);
    entry.count += 1;

    const date = new Date(issue.created_at);
    if (!entry.lastAt || date > entry.lastAt) {
      entry.lastAt = date;
      entry.lastUrl = issue.html_url;
    }
  }

  return byRepo;
}

async function fetchPRsViaSearch(userLogin, fromDate, toDate) {
  const fromStr = formatDateForSearch(fromDate);
  const toStr = formatDateForSearch(toDate);
  const query = `author:${userLogin} type:pr created:${fromStr}..${toStr}`;

  const prs = await searchAllPages(query);

  // Group by repo
  const byRepo = new Map();
  for (const pr of prs) {
    // Skip quick-closed PRs
    if (isQuickClosedPullRequest(pr)) continue;

    const repoUrl = pr.repository_url;
    if (!repoUrl) continue;

    const match = repoUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
    if (!match) continue;
    const repoName = match[1];

    if (!byRepo.has(repoName)) {
      byRepo.set(repoName, { count: 0, lastAt: null, lastUrl: null });
    }
    const entry = byRepo.get(repoName);
    entry.count += 1;

    const date = new Date(pr.created_at);
    if (!entry.lastAt || date > entry.lastAt) {
      entry.lastAt = date;
      entry.lastUrl = pr.html_url;
    }
  }

  return byRepo;
}

async function fetchRepoCommits(repoName, userLogin, fromDate, toDate) {
  const [owner, repo] = repoName.split("/");
  if (!owner || !repo) return { count: 0, lastAt: null, lastUrl: null };

  try {
    const commits = await restGetAllPages(`/repos/${owner}/${repo}/commits`, {
      author: userLogin,
      since: fromDate.toISOString(),
      until: toDate.toISOString(),
    });

    if (!commits.length) {
      return { count: 0, lastAt: null, lastUrl: null };
    }

    let lastAt = null;
    let lastUrl = null;

    for (const commit of commits) {
      const date = new Date(commit.commit?.author?.date || commit.commit?.committer?.date);
      if (!lastAt || date > lastAt) {
        lastAt = date;
        lastUrl = commit.html_url;
      }
    }

    return { count: commits.length, lastAt, lastUrl };
  } catch (e) {
    // Repo might not be accessible
    return { count: 0, lastAt: null, lastUrl: null };
  }
}

async function fetchRepoCommitTotal(repoName) {
  const [owner, repo] = repoName.split("/");
  if (!owner || !repo) return { totalCount: null, latestUrl: null };

  try {
    // Get the default branch first
    const { data: repoData } = await restGet(`/repos/${owner}/${repo}`);
    const defaultBranch = repoData.default_branch || "main";

    // Get commit count using the commits endpoint with per_page=1
    // We'll use the Link header to find the last page
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits?sha=${defaultBranch}&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "tmustier-profile-activity",
        },
      }
    );

    if (!response.ok) {
      return { totalCount: null, latestUrl: null };
    }

    const commits = await response.json();
    const latestUrl = commits[0]?.html_url || null;

    // Parse Link header for total count
    const linkHeader = response.headers.get("link");
    let totalCount = 1;

    if (linkHeader) {
      const lastMatch = linkHeader.match(/page=(\d+)>; rel="last"/);
      if (lastMatch) {
        totalCount = parseInt(lastMatch[1], 10);
      }
    }

    return { totalCount, latestUrl };
  } catch (e) {
    return { totalCount: null, latestUrl: null };
  }
}

async function findLatestUserCommit(repoName, userLogin, sinceDate) {
  const [owner, repo] = repoName.split("/");
  if (!owner || !repo) return null;

  try {
    const commits = await restGetAllPages(`/repos/${owner}/${repo}/commits`, {
      since: sinceDate.toISOString(),
    }, 5);

    for (const commit of commits) {
      const authorLogin = commit.author?.login;
      const committerLogin = commit.committer?.login;
      if (authorLogin === userLogin || committerLogin === userLogin) {
        return commit.html_url;
      }

      // Check co-author
      const message = commit.commit?.message || "";
      if (message.toLowerCase().includes("co-authored-by:") &&
          message.toLowerCase().includes(userLogin.toLowerCase())) {
        return commit.html_url;
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

// ============ Main ============

async function main() {
  console.log("Fetching user info...");
  const viewer = await fetchViewer();
  console.log(`User: ${viewer.login}`);

  const fromStr = formatDateForSearch(from);
  const toStr = formatDateForSearch(to);
  console.log(`Date range: ${fromStr} to ${toStr}`);

  const repoMap = new Map();

  // Fetch all user repos (for private repo detection)
  console.log("Fetching user repos...");
  const userRepos = await fetchUserRepos();
  const privateRepoNames = new Set(
    userRepos.filter((r) => r.isPrivate).map((r) => r.nameWithOwner)
  );
  console.log(`Found ${userRepos.length} repos (${privateRepoNames.size} private)`);

  // Fetch commits via search (covers public repos and private repos token has access to)
  console.log("Searching commits...");
  const commitsByRepo = await fetchCommitsViaSearch(viewer.login, from, to);
  for (const [repoName, data] of commitsByRepo) {
    mergeContribution(repoMap, repoName, data.count, data.lastAt, data.lastUrl, "commit");
  }
  console.log(`Found commits in ${commitsByRepo.size} repos`);

  // Fetch issues via search
  console.log("Searching issues...");
  const issuesByRepo = await fetchIssuesViaSearch(viewer.login, from, to);
  for (const [repoName, data] of issuesByRepo) {
    mergeContribution(repoMap, repoName, data.count, data.lastAt, data.lastUrl, "issue");
  }
  console.log(`Found issues in ${issuesByRepo.size} repos`);

  // Fetch PRs via search
  console.log("Searching PRs...");
  const prsByRepo = await fetchPRsViaSearch(viewer.login, from, to);
  for (const [repoName, data] of prsByRepo) {
    mergeContribution(repoMap, repoName, data.count, data.lastAt, data.lastUrl, "pr");
  }
  console.log(`Found PRs in ${prsByRepo.size} repos`);

  // For private repos not caught by search, fetch commits directly
  console.log("Checking private repos for additional commits...");
  for (const repoName of privateRepoNames) {
    if (!repoMap.has(repoName) || repoMap.get(repoName).lastKind !== "commit") {
      const data = await fetchRepoCommits(repoName, viewer.login, from, to);
      if (data.count > 0) {
        mergeContribution(repoMap, repoName, data.count, data.lastAt, data.lastUrl, "commit");
      }
    }
  }

  // Get commit totals for repos with commit activity
  console.log("Fetching commit totals...");
  const commitEntries = Array.from(repoMap.values()).filter(
    (entry) => entry.lastKind === "commit"
  );

  for (const entry of commitEntries) {
    const meta = await fetchRepoCommitTotal(entry.name);
    if (meta.totalCount != null) {
      entry.repoCommitTotal = meta.totalCount;
      entry.repoLatestCommitUrl = meta.latestUrl;
    }
  }

  // For other people's repos, find the user's latest commit URL
  console.log("Finding user commit URLs for other repos...");
  const otherCommitRepos = commitEntries
    .map((entry) => entry.name)
    .filter((name) => !name.toLowerCase().startsWith(`${login.toLowerCase()}/`));

  for (const repoName of otherCommitRepos) {
    const entry = repoMap.get(repoName);
    if (!entry) continue;
    const latestUrl = await findLatestUserCommit(repoName, viewer.login, from);
    if (latestUrl) {
      entry.userLatestCommitUrl = latestUrl;
    }
  }

  // Split and sort (filters forks from other repos)
  console.log("Filtering forks from other repos...");
  const { own, other } = await splitSections(repoMap, login);
  console.log(`Results: ${own.length} own repos, ${other.length} other repos`);

  // Generate table
  const generated = buildTable(other, own, windowLabel, login);

  // Update README
  const readmePath = path.join(process.cwd(), "README.md");
  const readme = fs.readFileSync(readmePath, "utf8");
  const startMarker = "<!-- GH-ACTIVITY-START -->";
  const endMarker = "<!-- GH-ACTIVITY-END -->";
  const startIndex = readme.indexOf(startMarker);
  const endIndex = readme.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error("README markers not found.");
  }

  const block = `${startMarker}\n\n${generated}\n\n${endMarker}`;
  const updated =
    readme.slice(0, startIndex) +
    block +
    readme.slice(endIndex + endMarker.length);

  fs.writeFileSync(readmePath, updated);
  console.log("README updated.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
