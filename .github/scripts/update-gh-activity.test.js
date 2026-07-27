const assert = require("node:assert/strict");
const test = require("node:test");

process.env.GH_ACTIVITY_TOKEN = "test-token";
process.env.GH_ACTIVITY_USER = "tmustier";
process.env.GH_ACTIVITY_ORG = "Nexcade";

const {
  buildEntries,
  buildSection,
  fetchContributedRepos,
} = require("./update-gh-activity");

function row(fullName, count, options = {}) {
  const [owner, name] = fullName.split("/");
  return {
    repo: {
      fullName,
      owner,
      name,
      htmlUrl: `https://github.com/${fullName}`,
      isFork: false,
      isPrivate: options.isPrivate || false,
    },
    count,
    latestAt: new Date(options.latestAt || "2026-07-27T12:00:00Z"),
    latestUrl: null,
  };
}

test("fetchContributedRepos paginates through the complete contribution history", async (t) => {
  const originalFetch = global.fetch;
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    nameWithOwner: `owner/repo-${index}`,
    name: `repo-${index}`,
    url: `https://github.com/owner/repo-${index}`,
    isFork: false,
    isPrivate: false,
    owner: { login: "owner" },
  }));
  const secondPage = [{
    nameWithOwner: "earendil-works/pi",
    name: "pi",
    url: "https://github.com/earendil-works/pi",
    isFork: false,
    isPrivate: false,
    owner: { login: "earendil-works" },
  }];
  const cursors = [];

  global.fetch = async (_url, options) => {
    const { variables } = JSON.parse(options.body);
    cursors.push(variables.after);
    const isFirstPage = variables.after === null;
    return {
      ok: true,
      json: async () => ({
        data: {
          user: {
            repositoriesContributedTo: {
              nodes: isFirstPage ? firstPage : secondPage,
              pageInfo: isFirstPage
                ? { hasNextPage: true, endCursor: "page-2" }
                : { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const repos = await fetchContributedRepos();
  assert.equal(repos.length, 101);
  assert.deepEqual(cursors, [null, "page-2"]);
  assert.equal(repos.at(-1).fullName, "earendil-works/pi");
});

test("buildEntries keeps every public row and anonymously aggregates private rows", () => {
  const publicRows = Array.from({ length: 13 }, (_, index) =>
    row(`owner/repo-${index + 1}`, 20 - index)
  );
  const entries = buildEntries([
    ...publicRows,
    row("earendil-works/pi", 2),
    row("Nexcade/private-product", 50, { isPrivate: true }),
    row("another-org/secret", 4, { isPrivate: true }),
  ]);

  assert.equal(entries.length, 16);
  assert.ok(entries.some((entry) => entry.displayName === "earendil-works/pi"));
  assert.ok(entries.some((entry) => entry.displayName === "owner/repo-13"));
  assert.deepEqual(
    entries.find((entry) => entry.displayName === "Private repositories"),
    {
      count: 4,
      htmlUrl: null,
      displayName: "Private repositories",
      latestAt: new Date("2026-07-27T12:00:00Z"),
      isOrg: false,
    }
  );
  assert.ok(!entries.some((entry) => entry.displayName.includes("secret")));

  const section = buildSection(
    entries,
    new Date("2026-06-28T00:00:00Z"),
    new Date("2026-07-27T23:59:59Z")
  );
  assert.match(section, /earendil-works\/pi/);
  assert.match(section, /\| Private repositories \| 4 \|/);
  assert.doesNotMatch(section, /another-org\/secret/);
});
