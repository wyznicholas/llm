import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const armEnv =
  process.env.OMBL_ARM_ENV_UNDER_TEST ?? join(import.meta.dir, "arm-env.sh");
const scriptsDir = "/Users/nicholas/.claude/skills/om-bug-loop/scripts";
const decoder = new TextDecoder();

type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runShell(
  shell: "bash" | "zsh",
  script: string,
  args: string[],
): ShellResult {
  const shellPath = Bun.which(shell);
  if (!shellPath) throw new Error(`${shell} is required for this test`);

  const result = Bun.spawnSync(
    [shellPath, "-c", script, "arm-env-tripwire-test", armEnv, scriptsDir, ...args],
    {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function lastLine(output: string): string {
  return output.trimEnd().split("\n").at(-1) ?? "";
}

function markedStatus(stderr: string, marker: string): number {
  const match = stderr.match(new RegExp(`^${marker}=(\\d+)$`, "m"));
  if (!match) throw new Error(`missing ${marker} marker in stderr:\n${stderr}`);
  return Number(match[1]);
}

for (const shell of ["zsh", "bash"] as const) {
  describe(`${shell} assert_clone_inert verdict`, () => {
    test("pipe without pipefail refuses before the selftest", () => {
      const workDir = mkdtempSync(join(tmpdir(), `ombl-T280-${shell}-pipe-`));
      const missing = join(workDir, "missing-clone");
      const functionStatus =
        shell === "bash" ? "${PIPESTATUS[0]}" : "${pipestatus[1]}";
      try {
        const result = runShell(
          shell,
          `
export OMBL_SCRIPTS="$2"
. "$1"
set +o pipefail
assert_clone_inert 1 "$3" | tail -25
tripwire_rc=${functionStatus}
printf '__FUNCTION_RC__=%s\\n' "$tripwire_rc" >&2
`,
          [missing],
        );

        expect(result.exitCode).toBe(0);
        expect(markedStatus(result.stderr, "__FUNCTION_RC__")).toBe(2);
        expect(lastLine(result.stdout)).toBe(
          "assert_clone_inert: FAIL rc=2 — clone is NOT inert: NOT RUN: stdout is a pipe and pipefail is off",
        );
        expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/\bPASS\b/);
        expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/selftest/i);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    test("pipe with pipefail preserves a failing verdict", () => {
      const workDir = mkdtempSync(join(tmpdir(), `ombl-T280-${shell}-pipefail-`));
      const missing = join(workDir, "missing-clone");
      try {
        const result = runShell(
          shell,
          `
export OMBL_SCRIPTS="$2"
. "$1"
set -o pipefail
assert_clone_inert 1 "$3" | tail -25
pipeline_rc=$?
printf '__PIPELINE_RC__=%s\\n' "$pipeline_rc" >&2
`,
          [missing],
        );

        expect(result.exitCode).toBe(0);
        expect(markedStatus(result.stderr, "__PIPELINE_RC__")).toBe(1);
        expect(lastLine(result.stdout)).toMatch(
          /^assert_clone_inert: FAIL rc=1 — clone is NOT inert: .+$/,
        );
        expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/\bPASS\b/);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    test("redirected output ends with the failing verdict", () => {
      const workDir = mkdtempSync(join(tmpdir(), `ombl-T280-${shell}-redirect-`));
      const missing = join(workDir, "missing-clone");
      const stdoutFile = join(workDir, "tripwire.stdout");
      const stderrFile = join(workDir, "tripwire.stderr");

      try {
        const result = runShell(
          shell,
          `
export OMBL_SCRIPTS="$2"
. "$1"
assert_clone_inert 1 "$3" >"$4" 2>"$5"
tripwire_rc=$?
printf '__TRIPWIRE_RC__=%s\\n' "$tripwire_rc" >&2
`,
          [missing, stdoutFile, stderrFile],
        );
        const stdout = readFileSync(stdoutFile, "utf8");
        const stderr = readFileSync(stderrFile, "utf8");

        expect(result.exitCode).toBe(0);
        expect(markedStatus(result.stderr, "__TRIPWIRE_RC__")).toBe(1);
        expect(lastLine(stdout)).toMatch(
          /^assert_clone_inert: FAIL rc=1 — clone is NOT inert: .+$/,
        );
        expect(`${stdout}\n${stderr}`).not.toMatch(/\bPASS\b/);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    test("missing arguments return a usage verdict", () => {
      const workDir = mkdtempSync(join(tmpdir(), `ombl-T280-${shell}-usage-`));
      const stdoutFile = join(workDir, "tripwire.stdout");
      const stderrFile = join(workDir, "tripwire.stderr");

      try {
        const result = runShell(
          shell,
          `
export OMBL_SCRIPTS="$2"
. "$1"
assert_clone_inert >"$3" 2>"$4"
tripwire_rc=$?
printf '__TRIPWIRE_RC__=%s\\n' "$tripwire_rc" >&2
`,
          [stdoutFile, stderrFile],
        );
        const stdout = readFileSync(stdoutFile, "utf8");
        const stderr = readFileSync(stderrFile, "utf8");

        expect(result.exitCode).toBe(0);
        expect(markedStatus(result.stderr, "__TRIPWIRE_RC__")).toBe(2);
        expect(lastLine(stdout)).toBe(
          "assert_clone_inert: FAIL rc=2 — clone is NOT inert: need <daemon-pid> <dest>",
        );
        expect(stderr).toContain("assert_clone_inert: need <daemon-pid> <dest>");
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
}
