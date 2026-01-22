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
  console.error("GH_ACTIVITY_TOKEN is required to read private contributions.");
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

const query = `
query($login: String!, $from: DateTime!, $to: DateTime!, $maxRepos: Int!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: $maxRepos) {
        repository { nameWithOwner isPrivate isFork }
        contributions(last: 100) {
          nodes { occurredAt commitCount url }
        }
      }
      issueContributionsByRepository(maxRepositories: $maxRepos) {
        repository { nameWithOwner isPrivate isFork }
        contributions(last: 100) {
          nodes { occurredAt issue { url } }
        }
      }
      pullRequestContributionsByRepository(maxRepositories: $maxRepos) {
        repository { nameWithOwner isPrivate isFork }
        contributions(last: 100) {
          nodes { occurredAt pullRequest { url createdAt closedAt mergedAt } }
        }
      }
      pullRequestReviewContributionsByRepository(maxRepositories: $maxRepos) {
        repository { nameWithOwner isPrivate isFork }
        contributions(last: 100) {
          nodes { occurredAt pullRequestReview { url } pullRequest { url } }
        }
      }
    }
  }
}
`;

async function graphql(queryText, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "tmustier-profile-activity",
    },
    body: JSON.stringify({ query: queryText, variables }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${body}`);
  }

  const payload = await response.json();
  if (payload.errors && payload.errors.length) {
    throw new Error(JSON.stringify(payload.errors));
  }

  return payload.data;
}

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

function labelFromIssueUrl(url) {
  if (!url) {
    return "issue";
  }
  const match = url.match(/\/issues\/(\d+)/);
  if (!match) {
    return "issue";
  }
  return `issue #${match[1]}`;
}

function labelFromPullUrl(url) {
  if (!url) {
    return "PR";
  }
  const match = url.match(/\/pull\/(\d+)/);
  if (!match) {
    return "PR";
  }
  return `PR #${match[1]}`;
}

function labelFromReviewUrl(url) {
  if (!url) {
    return "review";
  }
  const match = url.match(/\/pull\/(\d+)/);
  if (!match) {
    return "review";
  }
  return `review PR #${match[1]}`;
}

function labelFromKind(kind, url) {
  switch (kind) {
    case "issue":
      return labelFromIssueUrl(url);
    case "pr":
      return labelFromPullUrl(url);
    case "review":
      return labelFromReviewUrl(url);
    default:
      return "activity";
  }
}

function formatDateInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

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

function mergeContribution(map, repo, count, occurredAt, url, kind) {
  if (!repo?.nameWithOwner || count <= 0) {
    return;
  }

  const name = repo.nameWithOwner;
  if (excludedRepos.has(name.toLowerCase())) {
    return;
  }

  let entry = map.get(name);
  if (!entry) {
    entry = {
      name,
      total: 0,
      lastAt: null,
      lastUrl: null,
      lastKind: null,
      repoCommitTotal: null,
      repoLatestCommitUrl: null,
      userLatestCommitUrl: null,
    };
    map.set(name, entry);
  }

  entry.total += count;

  if (occurredAt) {
    const date = new Date(occurredAt);
    if (!entry.lastAt || date > entry.lastAt) {
      entry.lastAt = date;
      entry.lastUrl = url || entry.lastUrl;
      entry.lastKind = kind || entry.lastKind;
    }
  }
}

function addCommitContributions(map, items) {
  for (const item of items || []) {
    if (item.repository?.isPrivate || item.repository?.isFork) {
      continue;
    }
    const nodes = (item.contributions && item.contributions.nodes) || [];
    let count = 0;
    let lastAt = null;
    let lastUrl = null;

    for (const node of nodes) {
      count += node.commitCount || 0;
      if (node.occurredAt) {
        const date = getZonedEndOfDayUtc(new Date(node.occurredAt), timeZone);
        if (!lastAt || date > lastAt) {
          lastAt = date;
          lastUrl = node.url || lastUrl;
        }
      }
    }

    mergeContribution(map, item.repository, count, lastAt, lastUrl, "commit");
  }
}

function addIssueContributions(map, items) {
  for (const item of items || []) {
    if (item.repository?.isPrivate || item.repository?.isFork) {
      continue;
    }
    const nodes = (item.contributions && item.contributions.nodes) || [];
    let count = 0;
    let lastAt = null;
    let lastUrl = null;

    for (const node of nodes) {
      if (!node.issue || !node.issue.url) {
        continue;
      }
      count += 1;
      if (node.occurredAt) {
        const date = new Date(node.occurredAt);
        if (!lastAt || date > lastAt) {
          lastAt = date;
          lastUrl = node.issue.url;
        }
      }
    }

    mergeContribution(map, item.repository, count, lastAt, lastUrl, "issue");
  }
}

function isQuickClosedPullRequest(pr) {
  if (!pr || !pr.createdAt || !pr.closedAt) {
    return false;
  }
  if (pr.mergedAt) {
    return false;
  }
  const created = new Date(pr.createdAt).getTime();
  const closed = new Date(pr.closedAt).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(closed)) {
    return false;
  }
  return closed - created <= quickCloseMs;
}

function addPullRequestContributions(map, items) {
  for (const item of items || []) {
    if (item.repository?.isPrivate || item.repository?.isFork) {
      continue;
    }
    const nodes = (item.contributions && item.contributions.nodes) || [];
    let count = 0;
    let lastAt = null;
    let lastUrl = null;

    for (const node of nodes) {
      const pr = node.pullRequest;
      if (!pr || !pr.url) {
        continue;
      }
      if (isQuickClosedPullRequest(pr)) {
        continue;
      }
      count += 1;
      if (node.occurredAt) {
        const date = new Date(node.occurredAt);
        if (!lastAt || date > lastAt) {
          lastAt = date;
          lastUrl = pr.url;
        }
      }
    }

    mergeContribution(map, item.repository, count, lastAt, lastUrl, "pr");
  }
}

function addReviewContributions(map, items) {
  for (const item of items || []) {
    if (item.repository?.isPrivate || item.repository?.isFork) {
      continue;
    }
    const nodes = (item.contributions && item.contributions.nodes) || [];
    let count = 0;
    let lastAt = null;
    let lastUrl = null;

    for (const node of nodes) {
      const url =
        (node.pullRequestReview && node.pullRequestReview.url) ||
        (node.pullRequest && node.pullRequest.url) ||
        null;
      if (!url) {
        continue;
      }
      count += 1;
      if (node.occurredAt) {
        const date = new Date(node.occurredAt);
        if (!lastAt || date > lastAt) {
          lastAt = date;
          lastUrl = url;
        }
      }
    }

    mergeContribution(map, item.repository, count, lastAt, lastUrl, "review");
  }
}

function splitSections(map, ownerLogin) {
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
  other.sort(sorter);

  return { own, other };
}

async function fetchViewer() {
  const data = await graphql("query { viewer { id login name } }");
  return data.viewer;
}

async function fetchPrivateRepos() {
  const repos = [];
  let cursor = null;

  while (true) {
    const data = await graphql(
      `query($after: String) {
        viewer {
          repositories(
            first: 100,
            after: $after,
            privacy: PRIVATE,
            orderBy: { field: PUSHED_AT, direction: DESC }
          ) {
            nodes { nameWithOwner isFork }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { after: cursor }
    );

    const connection = data.viewer.repositories;
    for (const repo of connection.nodes || []) {
      if (!repo || !repo.nameWithOwner) {
        continue;
      }
      if (repo.isFork) {
        continue;
      }
      if (excludedRepos.has(repo.nameWithOwner.toLowerCase())) {
        continue;
      }
      repos.push(repo.nameWithOwner);
    }

    if (!connection.pageInfo || !connection.pageInfo.hasNextPage) {
      break;
    }
    cursor = connection.pageInfo.endCursor;
  }

  return repos;
}

function chunkArray(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

async function fetchRepoCommitMeta(repoNames) {
  const meta = new Map();
  const unique = Array.from(new Set(repoNames));

  for (const chunk of chunkArray(unique, 20)) {
    const selections = [];
    const aliasMap = new Map();

    chunk.forEach((fullName, index) => {
      const [owner, name] = fullName.split("/");
      if (!owner || !name) {
        return;
      }
      const alias = `repo${index}`;
      aliasMap.set(alias, fullName);
      selections.push(
        `${alias}: repository(owner: "${owner}", name: "${name}") { defaultBranchRef { target { ... on Commit { history(first: 1) { totalCount nodes { url } } } } } }`
      );
    });

    if (!selections.length) {
      continue;
    }

    const data = await graphql(`query { ${selections.join("\n")} }`);
    for (const [alias, fullName] of aliasMap.entries()) {
      const history = data[alias]?.defaultBranchRef?.target?.history;
      const totalCount = history?.totalCount;
      if (!Number.isFinite(totalCount)) {
        continue;
      }
      const latestUrl = history?.nodes?.[0]?.url || null;
      meta.set(fullName, { totalCount, latestUrl });
    }
  }

  return meta;
}

function matchesCoAuthor(message, loginName, displayName) {
  if (!message) {
    return false;
  }
  const lower = message.toLowerCase();
  if (!lower.includes("co-authored-by:")) {
    return false;
  }
  const login = loginName.toLowerCase();
  if (lower.includes(login)) {
    return true;
  }
  if (displayName) {
    const nameLower = displayName.toLowerCase();
    if (lower.includes(nameLower)) {
      return true;
    }
  }
  const noreply = `${login}@users.noreply.github.com`;
  return lower.includes(noreply);
}

async function findLatestUserCommit(repoName, loginName, displayName, sinceIso) {
  const [owner, name] = repoName.split("/");
  if (!owner || !name) {
    return null;
  }

  const params = new URLSearchParams({
    since: sinceIso,
    per_page: "100",
  });

  for (let page = 1; page <= 10; page += 1) {
    params.set("page", String(page));
    const url = `https://api.github.com/repos/${owner}/${name}/commits?${params}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const commits = await response.json();
    if (!Array.isArray(commits) || commits.length === 0) {
      break;
    }

    for (const commit of commits) {
      const authorLogin = commit.author?.login;
      const committerLogin = commit.committer?.login;
      if (authorLogin === loginName || committerLogin === loginName) {
        return commit.html_url || null;
      }
      const message = commit.commit?.message || "";
      if (matchesCoAuthor(message, loginName, displayName)) {
        return commit.html_url || null;
      }
    }
  }

  return null;
}

async function searchRepoItems(owner, name, loginName, startDate, endDate, type) {
  const nodes = [];
  let cursor = null;
  const typeClause = type === "pr" ? "type:pr" : "type:issue";
  const queryText = `repo:${owner}/${name} ${typeClause} author:${loginName} created:${startDate}..${endDate}`;

  while (true) {
    const data = await graphql(
      `query($query: String!, $after: String) {
        search(query: $query, type: ISSUE, first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ... on Issue { createdAt url }
            ... on PullRequest { createdAt closedAt mergedAt url }
          }
        }
      }`,
      { query: queryText, after: cursor }
    );

    const result = data.search;
    for (const node of result.nodes || []) {
      nodes.push(node);
    }

    if (!result.pageInfo.hasNextPage) {
      break;
    }
    cursor = result.pageInfo.endCursor;
  }

  return nodes;
}

async function fetchPrivateRepoActivity(
  repoName,
  viewerId,
  loginName,
  startDate,
  endDate
) {
  const [owner, name] = repoName.split("/");
  if (!owner || !name) {
    return null;
  }

  const repoData = await graphql(
    `query($owner: String!, $name: String!, $from: GitTimestamp!, $to: GitTimestamp!, $authorId: ID!) {
      repository(owner: $owner, name: $name) {
        nameWithOwner
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: 1, since: $from, until: $to, author: { id: $authorId }) {
                totalCount
                nodes { committedDate url }
              }
            }
          }
        }
      }
    }`,
    {
      owner,
      name,
      from: from.toISOString(),
      to: to.toISOString(),
      authorId: viewerId,
    }
  );

  const history = repoData.repository?.defaultBranchRef?.target?.history;

  const commitCount = history ? history.totalCount || 0 : 0;
  const commitNode = history && history.nodes && history.nodes[0];
  const commitLastAt = commitNode ? new Date(commitNode.committedDate) : null;
  const commitLastUrl = commitNode ? commitNode.url : null;

  const issueNodes = await searchRepoItems(
    owner,
    name,
    loginName,
    startDate,
    endDate,
    "issue"
  );
  let issueCount = 0;
  let issueLastAt = null;
  let issueLastUrl = null;

  for (const node of issueNodes) {
    if (!node || !node.url || !node.createdAt) {
      continue;
    }
    issueCount += 1;
    const date = new Date(node.createdAt);
    if (!issueLastAt || date > issueLastAt) {
      issueLastAt = date;
      issueLastUrl = node.url;
    }
  }

  const prNodes = await searchRepoItems(
    owner,
    name,
    loginName,
    startDate,
    endDate,
    "pr"
  );
  let prCount = 0;
  let prLastAt = null;
  let prLastUrl = null;

  for (const node of prNodes) {
    if (!node || !node.url || !node.createdAt) {
      continue;
    }
    if (isQuickClosedPullRequest(node)) {
      continue;
    }
    prCount += 1;
    const date = new Date(node.createdAt);
    if (!prLastAt || date > prLastAt) {
      prLastAt = date;
      prLastUrl = node.url;
    }
  }

  return {
    repository: { nameWithOwner: repoName },
    commit: { total: commitCount, lastAt: commitLastAt, lastUrl: commitLastUrl },
    issue: { total: issueCount, lastAt: issueLastAt, lastUrl: issueLastUrl },
    pr: { total: prCount, lastAt: prLastAt, lastUrl: prLastUrl },
  };
}

async function main() {
  const viewer = await fetchViewer();
  const data = await graphql(query, {
    login,
    from: from.toISOString(),
    to: to.toISOString(),
    maxRepos: 100,
  });

  const collection = data?.user?.contributionsCollection;
  if (!collection) {
    throw new Error("No contributions data returned by GitHub.");
  }

  const repoMap = new Map();

  addCommitContributions(repoMap, collection.commitContributionsByRepository);
  addIssueContributions(repoMap, collection.issueContributionsByRepository);
  addPullRequestContributions(repoMap, collection.pullRequestContributionsByRepository);
  addReviewContributions(
    repoMap,
    collection.pullRequestReviewContributionsByRepository
  );

  const privateRepos = await fetchPrivateRepos();
  const startDate = formatDateInZone(from, timeZone);
  const endDate = formatDateInZone(to, timeZone);

  for (const repoName of privateRepos) {
    const activity = await fetchPrivateRepoActivity(
      repoName,
      viewer.id,
      viewer.login,
      startDate,
      endDate
    );
    if (!activity) {
      continue;
    }

    if (activity.commit.total > 0) {
      mergeContribution(
        repoMap,
        activity.repository,
        activity.commit.total,
        activity.commit.lastAt,
        activity.commit.lastUrl,
        "commit"
      );
    }
    if (activity.issue.total > 0) {
      mergeContribution(
        repoMap,
        activity.repository,
        activity.issue.total,
        activity.issue.lastAt,
        activity.issue.lastUrl,
        "issue"
      );
    }
    if (activity.pr.total > 0) {
      mergeContribution(
        repoMap,
        activity.repository,
        activity.pr.total,
        activity.pr.lastAt,
        activity.pr.lastUrl,
        "pr"
      );
    }
  }

  const commitEntries = Array.from(repoMap.values()).filter(
    (entry) => entry.lastKind === "commit"
  );
  const commitRepos = commitEntries.map((entry) => entry.name);
  const commitMeta = await fetchRepoCommitMeta(commitRepos);
  for (const [name, data] of commitMeta.entries()) {
    const entry = repoMap.get(name);
    if (entry) {
      entry.repoCommitTotal = data.totalCount;
      entry.repoLatestCommitUrl = data.latestUrl;
    }
  }

  const otherCommitRepos = commitEntries
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(`${login}/`));
  const sinceIso = from.toISOString();
  for (const repoName of otherCommitRepos) {
    const entry = repoMap.get(repoName);
    if (!entry) {
      continue;
    }
    const latestUrl = await findLatestUserCommit(
      repoName,
      viewer.login,
      viewer.name,
      sinceIso
    );
    if (latestUrl) {
      entry.userLatestCommitUrl = latestUrl;
    }
  }

  const { own, other } = splitSections(repoMap, login);

  const generated = buildTable(other, own, windowLabel, login);

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
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
