#!/usr/bin/env bun
// The kudos writer's ONLY tool: read-only lookups against a fixed set of hosts.
//
// The writer model reads MR titles/descriptions and announcement text that any
// teammate (or anyone who can open an MR) wrote, so it must be assumed
// promptable. Raw curl or `glab api` would let a crafted MR description make it
// POST/DELETE as the operator's GitLab account or send data anywhere. This
// wrapper only ever issues GETs (plus PostHog's read-only HogQL query
// endpoint), takes no flags, and holds the PostHog key itself so the model's
// environment never contains it.
//
// Usage (one of):
//   kudos-fetch loki <path> [key=value ...]     path: query_range|query|labels|series|label/<name>/values
//   kudos-fetch prom <path> [key=value ...]     path: query|query_range|series|labels|label/<name>/values
//   kudos-fetch gitlab <path> [key=value ...]   path: projects/... or groups/... (GET only)
//   kudos-fetch hogql "<SELECT ...>"

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const MAX_OUTPUT = 20_000;
const TIMEOUT_MS = 30_000;
const LOKI = "https://logs.int.ore.kiyotaka.ai/loki/api/v1";
const PROM = "https://prometheus.int.ore.kiyotaka.ai/api/v1";
const OBS_PATH = /^(query|query_range|labels|series|label\/[A-Za-z0-9_]+\/values)$/;
// The exact reads the writer needs: MRs, their notes/commits/changes and closed
// issues, and issues. An explicit list rather than a pattern, because plenty of
// GitLab GETs return secrets (projects/:id/variables, deploy tokens, hooks, job
// logs), and anything the writer can read it could be talked into quoting in the
// post body. Numeric ids only and no %-escapes, so nothing can be encoded past it.
export const GITLAB_PATH =
  /^(projects\/\d+(\/(merge_requests(\/\d+(\/(notes|commits|changes|closes_issues))?)?|issues(\/\d+)?))?|groups\/openmarketxyz\/(merge_requests|issues))$/;
const POSTHOG_ENV = process.env.KUDOS_POSTHOG_ENV ?? `${homedir()}/.config/kudos/posthog.env`;

function fail(msg: string): never {
  console.error(`kudos-fetch: ${msg}`);
  process.exit(2);
}

/** key=value pairs only; anything flag-shaped is refused outright. */
export function parseParams(args: string[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const a of args) {
    if (a.startsWith("-")) fail(`flags are not allowed (${a})`);
    const eq = a.indexOf("=");
    if (eq <= 0) fail(`expected key=value, got ${a}`);
    params.append(a.slice(0, eq), a.slice(eq + 1));
  }
  return params;
}

function print(text: string) {
  console.log(text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…(truncated)` : text);
}

async function get(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  print(`HTTP ${res.status}\n${await res.text()}`);
}

function posthog(): { host: string; project: string; key: string } {
  if (!existsSync(POSTHOG_ENV)) fail("PostHog is not configured");
  const env: Record<string, string> = {};
  for (const line of readFileSync(POSTHOG_ENV, "utf8").split("\n")) {
    const m = line.match(/^\s*(POSTHOG_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const host = env.POSTHOG_HOST ?? "https://eu.posthog.com";
  if (!/^https:\/\/(eu|us|app)\.posthog\.com$/.test(host)) fail("unexpected POSTHOG_HOST");
  if (!env.POSTHOG_PROJECT_ID || !env.POSTHOG_PERSONAL_API_KEY) fail("PostHog env incomplete");
  return { host, project: env.POSTHOG_PROJECT_ID, key: env.POSTHOG_PERSONAL_API_KEY };
}

async function main() {
  const [source, target, ...rest] = process.argv.slice(2);
  if (!source || !target)
    fail("usage: kudos-fetch <loki|prom|gitlab|hogql> <path|query> [key=value ...]");
  switch (source) {
    case "loki":
    case "prom": {
      if (!OBS_PATH.test(target)) fail(`path not allowed: ${target}`);
      await get(`${source === "loki" ? LOKI : PROM}/${target}?${parseParams(rest)}`);
      return;
    }
    case "gitlab": {
      if (!GITLAB_PATH.test(target)) fail(`path not allowed: ${target}`);
      const qs = parseParams(rest).toString();
      // No -X/-f/-F/--input is ever passed, so glab sends a GET.
      const proc = Bun.spawn(["glab", "api", qs ? `${target}?${qs}` : target], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      print(`${(await proc.exited) === 0 ? "" : `exit ${proc.exitCode}: ${err}\n`}${out}`);
      return;
    }
    case "hogql": {
      if (rest.length) fail("hogql takes exactly one quoted query");
      if (!/^\s*(select|with)\b/i.test(target)) fail("only SELECT/WITH HogQL queries are allowed");
      const ph = posthog();
      const res = await fetch(`${ph.host}/api/projects/${encodeURIComponent(ph.project)}/query/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ph.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: target } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      print(`HTTP ${res.status}\n${await res.text()}`);
      return;
    }
    default:
      fail(`unknown source ${source}`);
  }
}

if (import.meta.main) await main();
