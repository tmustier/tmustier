const fs = require("fs");
const path = require("path");

const {
  getZonedDateParts,
  getZonedEndOfDay,
  getZonedStartOfDay,
} = require("./lib/date-utils");

function loadEnvFiles() {
  const initialKeys = new Set(Object.keys(process.env));

  for (const [file, allowOverride] of [[".env", false], [".env.local", true]]) {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
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

const config = {
  token: process.env.GH_ACTIVITY_TOKEN || process.env.GITHUB_TOKEN,
  login: process.env.GH_ACTIVITY_USER || process.env.GITHUB_REPOSITORY_OWNER || "",
  days: Number.parseInt(process.env.GH_ACTIVITY_DAYS || "30", 10),
  timeZone: process.env.GH_ACTIVITY_TIMEZONE || "UTC",
  orgLogin: process.env.GH_ACTIVITY_ORG || "Nexcade",
  requireOrgPrivateAccess: ["1", "true", "yes"].includes(
    (process.env.GH_ACTIVITY_REQUIRE_ORG_PRIVATE_ACCESS || "").toLowerCase()
  ),
  maxEntries: Number.parseInt(process.env.GH_ACTIVITY_MAX_ENTRIES || "12", 10),
  includePrivateRepoRows: ["1", "true", "yes"].includes(
    (process.env.GH_ACTIVITY_INCLUDE_PRIVATE_REPOS || "").toLowerCase()
  ),
  excludedRepos: new Set(
    (process.env.GH_ACTIVITY_EXCLUDE || "")
      .split(/[\n,]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  ),
};

if (!config.token) {
  console.error("GH_ACTIVITY_TOKEN or GITHUB_TOKEN is required.");
  process.exit(1);
}
if (!config.login) {
  console.error("GH_ACTIVITY_USER or GITHUB_REPOSITORY_OWNER is required.");
  process.exit(1);
}
if (!Number.isFinite(config.days) || config.days <= 0) {
  console.error("GH_ACTIVITY_DAYS must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(config.maxEntries) || config.maxEntries <= 0) {
  console.error("GH_ACTIVITY_MAX_ENTRIES must be a positive integer.");
  process.exit(1);
}

async function restGet(endpoint, params = {}) {
  const url = new URL(endpoint, "https://api.github.com");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tmustier-profile-spending-time",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${endpoint}: ${body}`);
  }

  return { data: await response.json(), headers: response.headers };
}

async function restGetPaginated(endpoint, params = {}) {
  const results = [];

  for (let page = 1; ; page++) {
    const { data, headers } = await restGet(endpoint, {
      ...params,
      per_page: 100,
      page,
    });

    if (!Array.isArray(data)) {
      results.push(data);
      break;
    }

    results.push(...data);
    if (data.length < 100) {
      break;
    }

    const link = headers.get("link") || "";
    if (!link.includes('rel="next"')) {
      break;
    }
  }

  return results;
}

function buildTimeWindow(now, timeZone, days) {
  const todayEnd = getZonedEndOfDay(now, timeZone);
  const { year, month, day } = getZonedDateParts(now, timeZone);
  const probe = new Date(Date.UTC(year, month - 1, day - (days - 1), 12));
  return {
    from: getZonedStartOfDay(probe, timeZone),
    to: todayEnd,
  };
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatZonedDate(date, timeZone) {
  const { year, month, day } = getZonedDateParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseLastPage(linkHeader) {
  const link = linkHeader || "";
  const match = link.match(/[?&]page=(\d+)>; rel="last"/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function normalizeRepo(repo) {
  return {
    fullName: repo.full_name,
    owner: repo.owner?.login || repo.full_name?.split("/")[0] || "",
    name: repo.name,
    htmlUrl: repo.html_url || `https://github.com/${repo.full_name}`,
    isFork: repo.fork === true,
    isPrivate: repo.private === true,
  };
}

function isExcluded(repo) {
  return config.excludedRepos.has(repo.fullName.toLowerCase());
}

async function fetchCandidateRepos() {
  const byName = new Map();
  const orgAccess = {
    listed: false,
    repoCount: 0,
    privateRepoCount: 0,
    nonForkPrivateRepoCount: 0,
    error: null,
  };

  const userRepos = await restGetPaginated("/user/repos", {
    affiliation: "owner,collaborator,organization_member",
    sort: "pushed",
    direction: "desc",
  });
  for (const repo of userRepos) {
    const normalized = normalizeRepo(repo);
    if (normalized.fullName) {
      byName.set(normalized.fullName.toLowerCase(), normalized);
    }
  }

  try {
    const orgRepos = await restGetPaginated(`/orgs/${config.orgLogin}/repos`, {
      type: "all",
      sort: "pushed",
      direction: "desc",
    });
    orgAccess.listed = true;
    orgAccess.repoCount = orgRepos.length;
    for (const repo of orgRepos) {
      const normalized = normalizeRepo(repo);
      if (normalized.isPrivate) {
        orgAccess.privateRepoCount += 1;
        if (!normalized.isFork) {
          orgAccess.nonForkPrivateRepoCount += 1;
        }
      }
      if (normalized.fullName) {
        byName.set(normalized.fullName.toLowerCase(), normalized);
      }
    }
  } catch (error) {
    orgAccess.error = error.message || String(error);
    console.warn(`Could not list ${config.orgLogin} repos: ${orgAccess.error}`);
  }

  const repos = Array.from(byName.values()).filter(
    (repo) => !repo.isFork && !isExcluded(repo)
  );

  return { repos, orgAccess };
}

async function countMainCommits(repo, from, to) {
  try {
    const { data, headers } = await restGet(`/repos/${repo.fullName}/commits`, {
      sha: "main",
      author: config.login,
      since: from.toISOString(),
      until: to.toISOString(),
      per_page: 1,
    });

    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const totalFromLink = parseLastPage(headers.get("link"));
    const firstCommit = data[0];
    const latestAt = new Date(
      firstCommit.commit?.author?.date || firstCommit.commit?.committer?.date
    );

    return {
      count: totalFromLink || data.length,
      latestAt,
      latestUrl: firstCommit.html_url || null,
    };
  } catch (error) {
    const message = String(error.message || error);
    if (
      message.includes("Git Repository is empty") ||
      message.includes("No commit found for SHA: main") ||
      message.includes("409") ||
      message.includes("422") ||
      message.includes("404")
    ) {
      return null;
    }
    console.warn(`Could not count ${repo.fullName}: ${message}`);
    return null;
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }
  );

  await Promise.all(runners);
  return results;
}

function buildBar(count, maxCount) {
  const maxBarWidth = 18;
  const scaled = Math.sqrt(count / maxCount);
  const filled = Math.max(1, Math.round(scaled * maxBarWidth));
  return "█".repeat(filled);
}

function buildSection(entries, from, to) {
  const lines = [
    "**Where I'm spending my time**",
    "",
    `*Authored commits on main in the past ${config.days} days:*`,
    "",
  ];

  if (entries.length === 0) {
    lines.push("No matching commits found.");
    return lines.join("\n");
  }

  const maxCount = entries[0].count;
  lines.push("| Repo | Commits | Activity |", "| --- | ---: | --- |");

  for (const entry of entries) {
    const label = `[${entry.displayName}](${entry.htmlUrl})${entry.isOrg ? " org" : ""}`;
    lines.push(`| ${label} | ${entry.count} | \`${buildBar(entry.count, maxCount)}\` |`);
  }

  lines.push("");

  return lines.join("\n");
}

function updateReadme(section) {
  const readmePath = path.join(process.cwd(), "README.md");
  const readme = fs.readFileSync(readmePath, "utf8");
  const startMarker = "<!-- SPENDING-TIME-START -->";
  const endMarker = "<!-- SPENDING-TIME-END -->";
  const replacement = `${startMarker}\n${section}\n${endMarker}`;
  const startIndex = readme.indexOf(startMarker);
  const endIndex = readme.indexOf(endMarker);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const updated =
      readme.slice(0, startIndex) +
      replacement +
      readme.slice(endIndex + endMarker.length);
    fs.writeFileSync(readmePath, updated);
    return;
  }

  const trimmed = readme.trimEnd();
  fs.writeFileSync(readmePath, `${trimmed}\n\n${replacement}\n`);
}

async function main() {
  const { from, to } = buildTimeWindow(new Date(), config.timeZone, config.days);
  console.log(
    `Counting main-branch commits authored by ${config.login} from ${formatZonedDate(from, config.timeZone)} to ${formatZonedDate(to, config.timeZone)} (${config.timeZone})`
  );

  const { repos, orgAccess } = await fetchCandidateRepos();
  if (config.requireOrgPrivateAccess) {
    if (!orgAccess.listed) {
      throw new Error(
        `GH_ACTIVITY_REQUIRE_ORG_PRIVATE_ACCESS is set, but ${config.orgLogin} repos could not be listed: ${orgAccess.error || "unknown error"}`
      );
    }
    if (orgAccess.nonForkPrivateRepoCount === 0) {
      throw new Error(
        `GH_ACTIVITY_REQUIRE_ORG_PRIVATE_ACCESS is set, but GH_ACTIVITY_TOKEN cannot see any private non-fork repos in ${config.orgLogin}. Refusing to publish a misleading activity table.`
      );
    }
  }
  console.log(
    `Checking ${repos.length} accessible non-fork repos (${orgAccess.nonForkPrivateRepoCount} private non-fork ${config.orgLogin} repos visible).`
  );

  const counted = await mapWithConcurrency(repos, 6, async (repo) => {
    const result = await countMainCommits(repo, from, to);
    if (!result) {
      return null;
    }
    return { repo, ...result };
  });

  const rows = counted.filter(Boolean);
  const orgLoginLower = config.orgLogin.toLowerCase();
  const ownerLoginLower = config.login.toLowerCase();
  const orgCount = rows
    .filter((entry) => entry.repo.owner.toLowerCase() === orgLoginLower)
    .reduce((sum, entry) => sum + entry.count, 0);

  const repoEntries = rows
    .filter((entry) => entry.repo.owner.toLowerCase() !== orgLoginLower)
    .filter((entry) => config.includePrivateRepoRows || !entry.repo.isPrivate)
    .map((entry) => ({
      count: entry.count,
      htmlUrl: entry.repo.htmlUrl,
      displayName: entry.repo.owner.toLowerCase() === ownerLoginLower
        ? entry.repo.name
        : entry.repo.fullName,
      latestAt: entry.latestAt,
      isOrg: false,
    }));

  const entries = [
    ...(orgCount > 0
      ? [{
          count: orgCount,
          htmlUrl: `https://github.com/${config.orgLogin}`,
          displayName: config.orgLogin,
          latestAt: new Date(0),
          isOrg: true,
        }]
      : []),
    ...repoEntries,
  ]
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      const timeDiff = b.latestAt.getTime() - a.latestAt.getTime();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return a.displayName.localeCompare(b.displayName);
    })
    .slice(0, config.maxEntries);

  const section = buildSection(entries, from, to);
  updateReadme(section);
  console.log(
    `README updated with ${entries.length} visual rows and ${orgCount} ${config.orgLogin} org commits.`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
