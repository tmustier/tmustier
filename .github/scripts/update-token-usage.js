const fs = require("fs");
const os = require("os");
const path = require("path");

const { getZonedDateParts, getZonedStartOfDay } = require("./lib/date-utils");

function loadEnvFiles() {
  const initialKeys = new Set(Object.keys(process.env));

  for (const [file, allowOverride] of [[".env", false], [".env.local", true]]) {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) {
      continue;
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
      if (!process.env[key] || (allowOverride && !initialKeys.has(key))) {
        process.env[key] = value;
      }
    }
  }
}

loadEnvFiles();

const token = process.env.GH_ACTIVITY_TOKEN;
const login =
  process.env.GH_ACTIVITY_USER ||
  process.env.GITHUB_REPOSITORY_OWNER ||
  "";
if (!token || !login) {
  console.error("GH_ACTIVITY_TOKEN and GH_ACTIVITY_USER are required.");
  process.exit(1);
}

const timeZone = process.env.GH_ACTIVITY_TIMEZONE || "UTC";
const privateCommitConcurrency = (() => {
  const value = Number.parseInt(
    process.env.TOKEN_USAGE_PRIVATE_CONCURRENCY || "4",
    10
  );
  return Number.isFinite(value) && value > 0 ? value : 4;
})();

const snapshotPath =
  process.env.CODEXBAR_SNAPSHOT_PATH ||
  path.join(
    os.homedir(),
    "Library",
    "Group Containers",
    "group.com.steipete.codexbar",
    "widget-snapshot.json"
  );

const readmePath = path.join(process.cwd(), "README.md");
const startMarker = "<!-- TOKEN-USAGE-START -->";
const endMarker = "<!-- TOKEN-USAGE-END -->";

function formatNumber(value, fractionDigits = 0) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

function formatMillions(tokens) {
  return `${formatNumber(Math.round(tokens / 1_000_000))}M`;
}

function formatMillions2dp(tokens) {
  return `${formatNumber(tokens / 1_000_000, 2)}M`;
}

function formatBillions(tokens) {
  return `${formatNumber(tokens / 1_000_000_000, 1)}B`;
}

async function graphql(queryText, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
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

function startOfYearUtc(now, zone) {
  const { year } = getZonedDateParts(now, zone);
  const probe = new Date(Date.UTC(year, 0, 1, 12, 0, 0));
  return getZonedStartOfDay(probe, zone);
}

function rollingWindowStart(now, days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const current = index++;
        if (current >= items.length) {
          return;
        }
        results[current] = await worker(items[current], current);
      }
    }
  );

  await Promise.all(runners);
  return results;
}

async function fetchViewer() {
  const data = await graphql("query { viewer { id login } }");
  return data.viewer;
}

async function fetchPublicCommitCount(fromIso, toIso) {
  const data = await graphql(
    `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          commitContributionsByRepository(maxRepositories: 100) {
            repository { isFork }
            contributions(last: 100) {
              nodes { commitCount }
            }
          }
        }
      }
    }`,
    { login, from: fromIso, to: toIso }
  );

  const repos = data.user?.contributionsCollection?.commitContributionsByRepository || [];
  let total = 0;
  for (const repo of repos) {
    if (repo.repository?.isFork) {
      continue;
    }
    const nodes = repo.contributions?.nodes || [];
    for (const node of nodes) {
      total += Number(node.commitCount || 0);
    }
  }
  return total;
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
      if (!repo?.nameWithOwner || repo.isFork) {
        continue;
      }
      repos.push(repo.nameWithOwner);
    }

    if (!connection.pageInfo?.hasNextPage) {
      break;
    }
    cursor = connection.pageInfo.endCursor;
  }

  return repos;
}

async function fetchPrivateCommitCount(repoName, viewerId, fromIso, toIso) {
  const [owner, name] = repoName.split("/");
  if (!owner || !name) {
    return 0;
  }

  const data = await graphql(
    `query($owner: String!, $name: String!, $from: GitTimestamp!, $to: GitTimestamp!, $authorId: ID!) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef {
          target {
            ... on Commit {
              history(since: $from, until: $to, author: { id: $authorId }) {
                totalCount
              }
            }
          }
        }
      }
    }`,
    { owner, name, from: fromIso, to: toIso, authorId: viewerId }
  );

  return data.repository?.defaultBranchRef?.target?.history?.totalCount || 0;
}

async function countCommits(fromDate, toDate, viewer, privateRepos) {
  const fromIso = fromDate.toISOString();
  const toIso = toDate.toISOString();

  const publicCount = await fetchPublicCommitCount(fromIso, toIso);

  if (!privateRepos.length) {
    return publicCount;
  }

  const privateCounts = await mapWithConcurrency(
    privateRepos,
    privateCommitConcurrency,
    (repoName) => fetchPrivateCommitCount(repoName, viewer.id, fromIso, toIso)
  );
  const privateCount = privateCounts.reduce(
    (sum, value) => sum + (Number(value) || 0),
    0
  );

  return publicCount + privateCount;
}

function loadSnapshot(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CodexBar snapshot not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function extractTokens(snapshot, year) {
  const entries = snapshot.entries || [];
  const result = {
    codex: { last30: 0, ytd: 0 },
    claude: { last30: 0, ytd: 0 },
  };

  for (const entry of entries) {
    if (!entry || !entry.provider || !entry.tokenUsage) {
      continue;
    }
    const provider = String(entry.provider).toLowerCase();
    if (!result[provider]) {
      continue;
    }

    const last30 = Number(entry.tokenUsage.last30DaysTokens || 0);
    if (Number.isFinite(last30)) {
      result[provider].last30 = Math.round(last30);
    }

    const daily = entry.dailyUsage || [];
    for (const day of daily) {
      if (!day || !day.dayKey || !day.totalTokens) {
        continue;
      }
      if (!String(day.dayKey).startsWith(`${year}-`)) {
        continue;
      }
      const tokens = Number(day.totalTokens);
      if (Number.isFinite(tokens)) {
        result[provider].ytd += Math.round(tokens);
      }
    }
  }

  return result;
}

function updateReadme(block) {
  if (!fs.existsSync(readmePath)) {
    throw new Error("README.md not found.");
  }
  const readme = fs.readFileSync(readmePath, "utf8");
  const startIndex = readme.indexOf(startMarker);
  const endIndex = readme.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    console.warn("Token usage markers not found in README.md; skipping update.");
    return;
  }

  const updated =
    readme.slice(0, startIndex) +
    `${startMarker}\n${block}\n${endMarker}` +
    readme.slice(endIndex + endMarker.length);

  fs.writeFileSync(readmePath, updated);
}

async function main() {
  const snapshot = loadSnapshot(snapshotPath);
  const year = new Date().getFullYear();
  const tokens = extractTokens(snapshot, year);

  const totalLast30 = tokens.codex.last30 + tokens.claude.last30;
  const totalYtd = tokens.codex.ytd + tokens.claude.ytd;

  const now = new Date();
  const viewer = await fetchViewer();
  const privateRepos = await fetchPrivateRepos();
  const last30Start = rollingWindowStart(now, 30);
  const ytdStart = startOfYearUtc(now, timeZone);
  const commitLast30 = await countCommits(
    last30Start,
    now,
    viewer,
    privateRepos
  );
  const commitYtd = await countCommits(ytdStart, now, viewer, privateRepos);

  const perCommitLast30 = commitLast30
    ? `${formatMillions2dp(totalLast30 / commitLast30)} / commit`
    : "n/a";
  const perCommitYtd = commitYtd
    ? `${formatMillions2dp(totalYtd / commitYtd)} / commit`
    : "n/a";

  const block = [
    `Past month: ${formatMillions(totalLast30)} (${perCommitLast30})`,
    `- Codex: ${formatMillions(tokens.codex.last30)}`,
    `- Claude: ${formatMillions(tokens.claude.last30)}`,
    "",
    `Year to date: ${formatBillions(totalYtd)} (${perCommitYtd})`,
    `- Codex: ${formatBillions(tokens.codex.ytd)}`,
    `- Claude: ${formatBillions(tokens.claude.ytd)}`,
  ].join("\n");

  updateReadme(block);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
