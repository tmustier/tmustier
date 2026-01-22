const fs = require("fs");
const path = require("path");

// ============ Configuration ============

function loadEnvFiles() {
  const initialKeys = new Set(Object.keys(process.env));
  
  for (const [file, allowOverride] of [[".env", false], [".env.local", true]]) {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) continue;
    
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (!key) continue;
      
      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
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
  token: process.env.GH_ACTIVITY_TOKEN,
  login: process.env.GH_ACTIVITY_USER || process.env.GITHUB_REPOSITORY_OWNER || "",
  days: Number.parseInt(process.env.GH_ACTIVITY_DAYS || "30", 10),
  timeZone: process.env.GH_ACTIVITY_TIMEZONE || "UTC",
  useCalendarMonth: ["1", "true", "yes"].includes(
    (process.env.GH_ACTIVITY_CALENDAR_MONTH || "").toLowerCase()
  ),
  excludedRepos: new Set(
    (process.env.GH_ACTIVITY_EXCLUDE || "")
      .split(/[\n,]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  ),
  quickCloseMs: (() => {
    const mins = Number.parseInt(process.env.GH_ACTIVITY_PR_QUICK_CLOSE_MINUTES || "30", 10);
    return Number.isFinite(mins) && mins >= 0 ? mins * 60 * 1000 : 30 * 60 * 1000;
  })(),
};

// Validate required config
if (!config.token) {
  console.error("GH_ACTIVITY_TOKEN is required.");
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

// ============ REST API Client ============

async function restGet(endpoint, params = {}) {
  const url = new URL(endpoint, "https://api.github.com");
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tmustier-profile-activity",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body}`);
  }

  return { data: await response.json(), headers: response.headers };
}

async function restGetPaginated(endpoint, params = {}, maxPages = 10) {
  const results = [];
  
  for (let page = 1; page <= maxPages; page++) {
    const { data, headers } = await restGet(endpoint, { ...params, per_page: 100, page });
    
    if (!Array.isArray(data)) {
      results.push(data);
      break;
    }
    
    results.push(...data);
    if (data.length < 100) break;
    
    const link = headers.get("link");
    if (!link?.includes('rel="next"')) break;
  }

  return results;
}

async function searchPaginated(endpoint, query, maxPages = 10) {
  const results = [];
  
  for (let page = 1; page <= maxPages; page++) {
    try {
      const { data } = await restGet(endpoint, { q: query, per_page: 100, page });
      if (!data.items?.length) break;
      results.push(...data.items);
      if (data.items.length < 100) break;
    } catch {
      break; // Search may fail due to rate limits
    }
  }

  return results;
}

// ============ Date Utilities ============

function getZonedDateParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const get = (type) => Number.parseInt(parts.find((p) => p.type === type).value, 10);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function getOffsetMinutes(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, timeZoneName: "shortOffset", hour: "2-digit", hour12: false
  }).formatToParts(date);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "";
  const match = tzPart.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1].startsWith("-") ? -1 : 1;
  return sign * (Math.abs(parseInt(match[1], 10)) * 60 + (parseInt(match[2], 10) || 0));
}

function getZonedStartOfDay(date, tz) {
  const { year, month, day } = getZonedDateParts(date, tz);
  const baseUtc = Date.UTC(year, month - 1, day);
  let utcMs = baseUtc;
  for (let i = 0; i < 2; i++) {
    const adjusted = baseUtc - getOffsetMinutes(new Date(utcMs), tz) * 60000;
    if (adjusted === utcMs) break;
    utcMs = adjusted;
  }
  return new Date(utcMs);
}

function getZonedEndOfDay(date, tz) {
  const { year, month, day } = getZonedDateParts(date, tz);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1, 12));
  return new Date(getZonedStartOfDay(nextDay, tz).getTime() - 1);
}

function buildTimeWindow(now, tz, windowDays, useMonth) {
  const todayEnd = getZonedEndOfDay(now, tz);
  const { year, month, day } = getZonedDateParts(now, tz);

  if (useMonth) {
    let [tYear, tMonth] = [year, month - 1];
    if (tMonth < 1) { tMonth = 12; tYear--; }
    const maxDay = new Date(Date.UTC(tYear, tMonth, 0)).getUTCDate();
    const probe = new Date(Date.UTC(tYear, tMonth - 1, Math.min(day, maxDay), 12));
    return { from: getZonedStartOfDay(probe, tz), to: todayEnd, windowLabel: "last month" };
  }

  const probe = new Date(Date.UTC(year, month - 1, day - (windowDays - 1), 12));
  return { from: getZonedStartOfDay(probe, tz), to: todayEnd, windowLabel: `last ${windowDays} days` };
}

const formatDate = (d) => d.toISOString().split("T")[0];

// ============ Data Fetchers ============

async function fetchUserLogin() {
  const { data } = await restGet("/user");
  return data.login;
}

async function fetchUserRepos() {
  const repos = await restGetPaginated("/user/repos", {
    affiliation: "owner,collaborator,organization_member",
    sort: "pushed",
    direction: "desc",
  });

  return repos
    .filter((r) => !r.fork && !config.excludedRepos.has(r.full_name.toLowerCase()))
    .map((r) => ({ name: r.full_name, isPrivate: r.private }));
}

async function fetchSearchItems(userLogin, from, to, type) {
  const query = type === "commit"
    ? `author:${userLogin} committer-date:${formatDate(from)}..${formatDate(to)}`
    : `author:${userLogin} type:${type} created:${formatDate(from)}..${formatDate(to)}`;

  const endpoint = type === "commit" ? "/search/commits" : "/search/issues";
  const items = await searchPaginated(endpoint, query);

  // Group by repo
  const seenShas = new Set();
  const byRepo = new Map();

  for (const item of items) {
    // Extract repo name
    let repoName, isFork;
    if (type === "commit") {
      repoName = item.repository?.full_name;
      isFork = item.repository?.fork;
    } else {
      const match = item.repository_url?.match(/\/repos\/([^/]+\/[^/]+)$/);
      repoName = match?.[1];
      isFork = false; // Issues/PRs don't have fork info, filtered later
    }
    if (!repoName || isFork) continue;

    // Dedupe commits by SHA
    if (type === "commit") {
      if (seenShas.has(item.sha)) continue;
      seenShas.add(item.sha);
    }

    // Skip quick-closed PRs
    if (type === "pr" && isQuickClosed(item)) continue;

    // Add to repo group
    if (!byRepo.has(repoName)) {
      byRepo.set(repoName, { count: 0, lastAt: null, lastUrl: null });
    }
    const entry = byRepo.get(repoName);
    entry.count++;

    const date = new Date(
      type === "commit" 
        ? (item.commit?.author?.date || item.commit?.committer?.date)
        : item.created_at
    );
    if (!entry.lastAt || date > entry.lastAt) {
      entry.lastAt = date;
      entry.lastUrl = item.html_url;
    }
  }

  return byRepo;
}

async function fetchRepoCommits(repoName, userLogin, from, to) {
  try {
    const commits = await restGetPaginated(`/repos/${repoName}/commits`, {
      author: userLogin,
      since: from.toISOString(),
      until: to.toISOString(),
    });

    if (!commits.length) return null;

    let lastAt = null, lastUrl = null;
    for (const c of commits) {
      const date = new Date(c.commit?.author?.date || c.commit?.committer?.date);
      if (!lastAt || date > lastAt) {
        lastAt = date;
        lastUrl = c.html_url;
      }
    }
    return { count: commits.length, lastAt, lastUrl };
  } catch {
    return null;
  }
}

async function fetchRepoMeta(repoName) {
  try {
    const { data: repo } = await restGet(`/repos/${repoName}`);
    const branch = repo.default_branch || "main";
    
    const { data: commits, headers } = await restGet(
      `/repos/${repoName}/commits`,
      { sha: branch, per_page: 1 }
    );

    const latestUrl = commits[0]?.html_url || null;
    
    // Parse total from Link header
    const link = headers.get("link");
    const lastMatch = link?.match(/page=(\d+)>; rel="last"/);
    const totalCount = lastMatch ? parseInt(lastMatch[1], 10) : 1;

    return { totalCount, latestUrl, isFork: repo.fork === true };
  } catch {
    return { totalCount: null, latestUrl: null, isFork: false };
  }
}

async function findUserCommitUrl(repoName, userLogin, since) {
  try {
    const commits = await restGetPaginated(
      `/repos/${repoName}/commits`,
      { since: since.toISOString() },
      5
    );

    for (const c of commits) {
      if (c.author?.login === userLogin || c.committer?.login === userLogin) {
        return c.html_url;
      }
      // Check co-author
      const msg = (c.commit?.message || "").toLowerCase();
      if (msg.includes("co-authored-by:") && msg.includes(userLogin.toLowerCase())) {
        return c.html_url;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ============ Helpers ============

function isQuickClosed(pr) {
  if (!pr.created_at || !pr.closed_at || pr.merged_at) return false;
  const duration = new Date(pr.closed_at) - new Date(pr.created_at);
  return Number.isFinite(duration) && duration <= config.quickCloseMs;
}

function isExcluded(repoName) {
  return config.excludedRepos.has(repoName.toLowerCase());
}

// ============ Contribution Aggregation ============

function createRepoMap() {
  const map = new Map();

  return {
    add(repoName, count, lastAt, lastUrl, kind) {
      if (!repoName || count <= 0 || isExcluded(repoName)) return;

      let entry = map.get(repoName);
      if (!entry) {
        entry = {
          name: repoName,
          total: 0,
          lastAt: null,
          lastUrl: null,
          lastKind: null,
          commitMeta: null,
        };
        map.set(repoName, entry);
      }

      entry.total += count;

      const date = lastAt instanceof Date ? lastAt : new Date(lastAt);
      if (!entry.lastAt || date > entry.lastAt) {
        entry.lastAt = date;
        entry.lastUrl = lastUrl;
        entry.lastKind = kind;
      }
    },

    entries() {
      return Array.from(map.values()).filter((e) => e.total > 0);
    },

    get(name) {
      return map.get(name);
    },
  };
}

async function splitAndEnrich(repoMap, ownerLogin, from) {
  const entries = repoMap.entries();
  const own = [];
  const other = [];
  const prefix = `${ownerLogin.toLowerCase()}/`;

  for (const entry of entries) {
    if (entry.name.toLowerCase().startsWith(prefix)) {
      own.push(entry);
    } else {
      other.push(entry);
    }
  }

  // Fetch metadata in parallel
  const allReposNeedingMeta = entries.filter((e) => e.lastKind === "commit");
  const metaResults = await Promise.all(
    allReposNeedingMeta.map(async (e) => ({ name: e.name, meta: await fetchRepoMeta(e.name) }))
  );

  for (const { name, meta } of metaResults) {
    const entry = repoMap.get(name);
    if (entry && meta.totalCount != null) {
      entry.commitMeta = meta;
    }
  }

  // Filter forks from other repos (using meta we already fetched)
  const filteredOther = other.filter((e) => !e.commitMeta?.isFork);

  // For remaining other repos without commit meta, check if they're forks
  const needForkCheck = filteredOther.filter((e) => e.lastKind !== "commit");
  const forkResults = await Promise.all(
    needForkCheck.map(async (e) => {
      try {
        const { data } = await restGet(`/repos/${e.name}`);
        return { name: e.name, isFork: data.fork === true };
      } catch {
        return { name: e.name, isFork: false };
      }
    })
  );
  const forkSet = new Set(forkResults.filter((r) => r.isFork).map((r) => r.name));
  const finalOther = filteredOther.filter((e) => !forkSet.has(e.name));

  // Find user commit URLs for other repos (in parallel)
  const otherCommitRepos = finalOther.filter((e) => e.lastKind === "commit");
  const urlResults = await Promise.all(
    otherCommitRepos.map(async (e) => ({
      name: e.name,
      url: await findUserCommitUrl(e.name, ownerLogin, from),
    }))
  );
  for (const { name, url } of urlResults) {
    const entry = repoMap.get(name);
    if (entry && url) entry.userCommitUrl = url;
  }

  // Sort by recency, then total, then name
  const sort = (arr) => arr.sort((a, b) => {
    const timeDiff = (b.lastAt?.getTime() || 0) - (a.lastAt?.getTime() || 0);
    if (timeDiff !== 0) return timeDiff;
    if (b.total !== a.total) return b.total - a.total;
    return a.name.localeCompare(b.name);
  });

  return { own: sort(own), other: sort(finalOther) };
}

// ============ Table Generation ============

function buildTable(own, other, windowLabel, ownerLogin) {
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
      lines.push(`| **${section.label}** | _No contributions in the ${windowLabel}._ | |`);
      continue;
    }

    lines.push(`| **${section.label}** |  |  |`);

    for (const item of section.items) {
      const isOwn = item.name.toLowerCase().startsWith(`${ownerLogin.toLowerCase()}/`);
      const displayName = isOwn ? item.name.split("/")[1] : item.name;
      const repoLink = `[${displayName}](https://github.com/${item.name})`;

      let linkText, url;
      if (item.lastKind === "commit") {
        const total = item.commitMeta?.totalCount;
        linkText = total != null ? `commit #${total}` : "commits";
        url = isOwn
          ? `https://github.com/${item.name}/commits`
          : item.userCommitUrl || item.commitMeta?.latestUrl || `https://github.com/${item.name}/commits`;
      } else if (item.lastKind === "issue") {
        const num = item.lastUrl?.match(/\/issues\/(\d+)/)?.[1];
        linkText = num ? `issue #${num}` : "issue";
        url = item.lastUrl;
      } else if (item.lastKind === "pr") {
        const num = item.lastUrl?.match(/\/pull\/(\d+)/)?.[1];
        linkText = num ? `PR #${num}` : "PR";
        url = item.lastUrl;
      } else {
        linkText = "activity";
        url = item.lastUrl;
      }

      const latest = url ? `[${linkText}](${url})` : linkText;
      lines.push(`| ${repoLink} | ${item.total} | ${latest} |`);
    }
  }

  return lines.join("\n");
}

// ============ README Update ============

function updateReadme(content) {
  const readmePath = path.join(process.cwd(), "README.md");
  const readme = fs.readFileSync(readmePath, "utf8");
  
  const startMarker = "<!-- GH-ACTIVITY-START -->";
  const endMarker = "<!-- GH-ACTIVITY-END -->";
  const startIdx = readme.indexOf(startMarker);
  const endIdx = readme.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error("README markers not found.");
  }

  const updated = readme.slice(0, startIdx) +
    `${startMarker}\n\n${content}\n\n${endMarker}` +
    readme.slice(endIdx + endMarker.length);

  fs.writeFileSync(readmePath, updated);
}

// ============ Main ============

async function main() {
  const { from, to, windowLabel } = buildTimeWindow(
    new Date(),
    config.timeZone,
    config.days,
    config.useCalendarMonth
  );

  console.log(`Fetching activity for ${config.login} (${formatDate(from)} to ${formatDate(to)})`);

  // Fetch user login and repos in parallel
  const [userLogin, userRepos] = await Promise.all([
    fetchUserLogin(),
    fetchUserRepos(),
  ]);
  
  const privateRepos = new Set(userRepos.filter((r) => r.isPrivate).map((r) => r.name));
  console.log(`Found ${userRepos.length} repos (${privateRepos.size} private)`);

  // Fetch all contributions via search in parallel
  console.log("Searching contributions...");
  const [commitsByRepo, issuesByRepo, prsByRepo] = await Promise.all([
    fetchSearchItems(userLogin, from, to, "commit"),
    fetchSearchItems(userLogin, from, to, "issue"),
    fetchSearchItems(userLogin, from, to, "pr"),
  ]);

  console.log(`Found: ${commitsByRepo.size} repos with commits, ${issuesByRepo.size} with issues, ${prsByRepo.size} with PRs`);

  // Aggregate contributions
  const repoMap = createRepoMap();
  
  for (const [name, data] of commitsByRepo) {
    repoMap.add(name, data.count, data.lastAt, data.lastUrl, "commit");
  }
  for (const [name, data] of issuesByRepo) {
    repoMap.add(name, data.count, data.lastAt, data.lastUrl, "issue");
  }
  for (const [name, data] of prsByRepo) {
    repoMap.add(name, data.count, data.lastAt, data.lastUrl, "pr");
  }

  // Check private repos not caught by search
  console.log("Checking private repos...");
  const uncheckedPrivate = [...privateRepos].filter(
    (name) => !repoMap.get(name) || repoMap.get(name).lastKind !== "commit"
  );
  
  const privateResults = await Promise.all(
    uncheckedPrivate.map(async (name) => ({
      name,
      data: await fetchRepoCommits(name, userLogin, from, to),
    }))
  );
  
  for (const { name, data } of privateResults) {
    if (data) repoMap.add(name, data.count, data.lastAt, data.lastUrl, "commit");
  }

  // Split, enrich with metadata, and filter forks
  console.log("Enriching metadata...");
  const { own, other } = await splitAndEnrich(repoMap, config.login, from);
  console.log(`Results: ${own.length} own repos, ${other.length} other repos`);

  // Generate and update
  const table = buildTable(own, other, windowLabel, config.login);
  updateReadme(table);
  console.log("README updated.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
