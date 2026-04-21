import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_DATABASE_PATH,
  loadKbaasConfig,
  resolveDatabasePath,
} from "./kbaas";

const createdDirs: string[] = [];

const makeProjectDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "kbaas-config-test-"));
  createdDirs.push(dir);
  return dir;
};

const writeConfig = (cwd: string, contents: string): void => {
  const configDir = join(cwd, ".kbaas");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "kbaas.json"), contents);
};

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("kbaas config", () => {
  test("returns empty config when file does not exist", () => {
    const cwd = makeProjectDir();
    expect(loadKbaasConfig({ cwd })).toEqual({});
  });

  test("loads and trims databasePath", () => {
    const cwd = makeProjectDir();
    writeConfig(cwd, JSON.stringify({ databasePath: "  custom/db.sqlite  " }));

    expect(loadKbaasConfig({ cwd })).toEqual({ databasePath: "custom/db.sqlite" });
    expect(resolveDatabasePath({ cwd })).toBe("custom/db.sqlite");
  });

  test("uses default database path when databasePath is omitted", () => {
    const cwd = makeProjectDir();
    writeConfig(cwd, JSON.stringify({}));

    expect(resolveDatabasePath({ cwd })).toBe(DEFAULT_DATABASE_PATH);
  });

  test("throws for invalid json", () => {
    const cwd = makeProjectDir();
    writeConfig(cwd, "{");

    expect(() => loadKbaasConfig({ cwd })).toThrow(
      "Invalid JSON in .kbaas/kbaas.json.",
    );
  });

  test("throws when databasePath is not a string", () => {
    const cwd = makeProjectDir();
    writeConfig(cwd, JSON.stringify({ databasePath: 123 }));

    expect(() => loadKbaasConfig({ cwd })).toThrow(
      "Invalid .kbaas/kbaas.json: Invalid input: expected string, received number.",
    );
  });

  test("throws when databasePath is empty", () => {
    const cwd = makeProjectDir();
    writeConfig(cwd, JSON.stringify({ databasePath: "   " }));

    expect(() => loadKbaasConfig({ cwd })).toThrow(
      "Invalid .kbaas/kbaas.json: Too small: expected string to have >=1 characters.",
    );
  });
});
