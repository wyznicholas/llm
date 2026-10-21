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
//   kudos-fetch sentry <path> [key=value ...]   path: organizations/trontal-group/issues|projects, issues/<id>
//   kudos-fetch grafana <datasource> <path> [key=value ...]
//       datasource: loki|loki-ore|loki-blk|loki-cme|prom|prom-ore|prom-blk|prom-cme
//       path: as for loki/prom

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
const CONFIG_DIR = `${homedir()}/.config/kudos`;
const POSTHOG_ENV = process.env.KUDOS_POSTHOG_ENV ?? `${CONFIG_DIR}/posthog.env`;
const SENTRY_ENV = process.env.KUDOS_SENTRY_ENV ?? `${CONFIG_DIR}/sentry.env`;
const GRAFANA_ENV = process.env.KUDOS_GRAFANA_ENV ?? `${CONFIG_DIR}/grafana.env`;

// Sentry: issue lists and single issues only. Their event counts, user counts and
// first/last seen are the numbers a fix is measured by. Event bodies
// (issues/<id>/events) are left out: they carry request data and user details.
export const SENTRY_PATH = /^(organizations\/trontal-group\/(issues|projects)|issues\/\d+)\/?$/;

// Grafana proxies Loki and Prometheus for every cluster, including the main one
// (tharamine) that has no direct endpoint from here. Datasources by name so the
// writer never handles uids; the token stays in this process.
export const GRAFANA_DATASOURCES: Record<string, { uid: string; kind: "loki" | "prom" }> = {
  loki: { uid: "P8E80F9AEF21F6940", kind: "loki" },
  "loki-ore": { uid: "PFA1DA24BC3872100", kind: "loki" },
  "loki-blk": { uid: "PD6C5C1BEA67CB5A7", kind: "loki" },
  "loki-cme": { uid: "P0908B6EF4974B1BA", kind: "loki" },
  prom: { uid: "prometheus", kind: "prom" },
  "prom-ore": { uid: "PACDA894871293EDF", kind: "prom" },
  "prom-blk": { uid: "PFA27BB598DF82C50", kind: "prom" },
  "prom-cme": { uid: "P936145AD0657F27E", kind: "prom" },
};

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

/** KEY=value lines from one of the operator's chmod-600 config files. */
function readEnv(file: string, what: string): Record<string, string> {
  if (!existsSync(file)) fail(`${what} is not configured`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z_]*)\s*=\s*(.*?)\s*$/);
    if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function posthog(): { host: string; project: string; key: string } {
  const env = readEnv(POSTHOG_ENV, "PostHog");
  // The Kiyotaka project lives on the US cloud; eu stays allowed for other projects.
  const host = env.POSTHOG_HOST ?? "https://us.posthog.com";
  if (!/^https:\/\/(eu|us|app)\.posthog\.com$/.test(host)) fail("unexpected POSTHOG_HOST");
  if (!env.POSTHOG_PROJECT_ID || !env.POSTHOG_PERSONAL_API_KEY) fail("PostHog env incomplete");
  return { host, project: env.POSTHOG_PROJECT_ID, key: env.POSTHOG_PERSONAL_API_KEY };
}

async function getWithToken(url: string, token: string) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  print(`HTTP ${res.status}\n${await res.text()}`);
}

async function main() {
  const [source, target, ...rest] = process.argv.slice(2);
  if (!source || !target)
    fail("usage: kudos-fetch <loki|prom|gitlab|hogql|sentry|grafana> <path|query> [key=value ...]");
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
    case "sentry": {
      if (!SENTRY_PATH.test(target)) fail(`path not allowed: ${target}`);
      const env = readEnv(SENTRY_ENV, "Sentry");
      const host = env.SENTRY_HOST ?? "https://de.sentry.io";
      if (!/^https:\/\/([a-z0-9-]+\.)?sentry\.io$/.test(host)) fail("unexpected SENTRY_HOST");
      if (!env.SENTRY_TOKEN) fail("Sentry env incomplete");
      const qs = parseParams(rest).toString();
      const path = target.endsWith("/") ? target : `${target}/`;
      await getWithToken(`${host}/api/0/${path}${qs ? `?${qs}` : ""}`, env.SENTRY_TOKEN);
      return;
    }
    case "grafana": {
      const ds = GRAFANA_DATASOURCES[target];
      const [path, ...params] = rest;
      if (!ds) fail(`unknown datasource ${target}`);
      if (!path || !OBS_PATH.test(path)) fail(`path not allowed: ${path}`);
      const env = readEnv(GRAFANA_ENV, "Grafana");
      const host = env.GRAFANA_HOST ?? "https://grafana.occ.kiyotaka.dev";
      if (host !== "https://grafana.occ.kiyotaka.dev") fail("unexpected GRAFANA_HOST");
      if (!env.GRAFANA_TOKEN) fail("Grafana env incomplete");
      const api = ds.kind === "loki" ? "loki/api/v1" : "api/v1";
      await getWithToken(
        `${host}/api/datasources/proxy/uid/${ds.uid}/${api}/${path}?${parseParams(params)}`,
        env.GRAFANA_TOKEN,
      );
      return;
    }
    default:
      fail(`unknown source ${source}`);
  }
}

if (import.meta.main) await main();
