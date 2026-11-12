import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [tag, output] = process.argv.slice(2);
const repo = process.env.GH_REPO;
const versionTag = /^v\d+\.\d+\.\d+$/;
if (!versionTag.test(tag ?? "") || !output || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
  throw new Error("Usage: GH_REPO=owner/repo node scripts/release-notes.mjs vX.Y.Z OUTPUT");
}

const web = "https://github.com/" + repo;
function github(path) {
  return JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", "repos/" + repo + path], {
    encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
  }));
}

const tagRef = "refs/tags/" + tag;
const releaseCommit = execFileSync("git", ["rev-parse", tagRef + "^{commit}"], { encoding: "utf8" }).trim();
function isEarlierAncestor(candidate) {
  const result = spawnSync("git", ["rev-parse", "refs/tags/" + candidate + "^{commit}"], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const base = result.stdout.trim();
  return base !== releaseCommit && spawnSync("git", ["merge-base", "--is-ancestor", base, tagRef]).status === 0;
}

const previous = github("/releases?per_page=100").flat().find((release) =>
  !release.draft && !release.prerelease && release.tag_name !== tag &&
  versionTag.test(release.tag_name) && isEarlierAncestor(release.tag_name),
)?.tag_name;
const commits = previous
  ? github(`/compare/${previous}...${tag}?per_page=100`).flatMap((page) => page.commits)
  : github(`/commits?sha=${tag}&per_page=100`).flat().reverse();
const escape = (value) => value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char])
  .replace(/@/g, "&#64;").replace(/[\\`*_[\]~]/g, "\\$&");

const groups = new Map([["Features", []], ["Bug fixes", []], ["Documentation", []], ["Dependencies", []], ["Maintenance", []]]);
const categories = new Map([["feat", "Features"], ["fix", "Bug fixes"], ["docs", "Documentation"]]);
const contributors = new Map();
const changes = commits.map(({ sha, commit, author }) => {
  const [subject, ...body] = commit.message.split("\n");
  const merged = subject.match(/^Merge pull request #(\d+) from /);
  const squash = subject.match(/\s+\(#(\d+)\)$/);
  const pull = merged?.[1] ?? squash?.[1];
  const title = merged ? (body.find((line) => line.trim())?.trim() ?? subject) : subject.replace(/\s+\(#\d+\)$/, "");
  const conventional = title.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*/);
  const type = conventional?.[1];
  const category = /^deps(?:-dev)?$/.test(conventional?.[2] ?? "") ? "Dependencies"
    : (categories.get(type) ?? "Maintenance");
  const login = author?.login;
  const person = login ? `[@${login}](https://github.com/${login})` : escape(commit.author?.name ?? "Unknown author");
  contributors.set(login ? "account:" + login : "name:" + person, person);
  const links = [
    ...(pull ? [`[#${pull}](${web}/pull/${pull})`] : []),
    `[${sha.slice(0, 7)}](${web}/commit/${sha})`,
  ];
  const change = `- ${escape(title.replace(conventional?.[0] ?? /^$/, ""))} (${links.join(", ")}) by ${person}`;
  groups.get(category).push(change);
  return change;
});
const noteworthy = [...groups.get("Features"), ...groups.get("Bug fixes")];
const highlights = (noteworthy.length ? noteworthy : changes).slice(0, 3);
const count = (n, label) => `**${n} ${label}${n === 1 ? "" : "s"}**`;
const comparison = previous
  ? `[View the full changelog](${web}/compare/${previous}...${tag}).`
  : `[Browse the commit history](${web}/commits/${tag}).`;

writeFileSync(output, [
  "## Release summary", "",
  `${tag} includes ${count(changes.length, "commit")}${previous ? ` since ${previous}` : ""} from ${count(contributors.size, "contributor")}.`, "",
  ...(highlights.length ? ["## Highlights", "", ...highlights, ""] : []),
  ...[...groups].flatMap(([category, items]) => items.length ? [`## ${category}`, "", ...items, ""] : []),
  ...(contributors.size ? ["## Contributors", "", ...[...contributors.values()].map((person) => "- " + person), ""] : []),
  "## Compare changes", "", comparison, "",
  "This description was generated from the repository's commit history.", "",
].join("\n"));
