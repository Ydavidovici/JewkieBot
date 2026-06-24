import {describe, it, expect} from "bun:test";
import {
    sshTargetFromEnv,
    sshArgs,
    remoteEnginePath,
    buildVersionScript,
    cutechessCommand,
    splitCompletedGames,
    countFinishedGames,
    parseLatestElo,
    parseGhReleases,
    defaultRemoteConfig,
    type RemoteConfig,
} from "../../src/controllers/selfPlayController.ts";

const cfg: RemoteConfig = {repoDir: "/home/bot/jb", cutechess: "cutechess-cli", openingBook: "/home/bot/jb/tools/book.epd"};

describe("sshTargetFromEnv", () => {
    it("returns null when remote execution is disabled", () => {
        expect(sshTargetFromEnv({REMOTE_ENGINE_ENABLED: "false", REMOTE_SSH_HOST: "h"} as any)).toBeNull();
        expect(sshTargetFromEnv({REMOTE_ENGINE_ENABLED: "true"} as any)).toBeNull();
    });

    it("reads host/user/key from env when enabled", () => {
        const t = sshTargetFromEnv({REMOTE_ENGINE_ENABLED: "true", REMOTE_SSH_HOST: "host", REMOTE_SSH_USER: "u", REMOTE_SSH_KEY_PATH: "/k"} as any);
        expect(t).toEqual({host: "host", user: "u", keyPath: "/k"});
    });
});

describe("sshArgs", () => {
    it("includes key, host-key policy, keepalive, target and command", () => {
        const args = sshArgs({host: "host", user: "u", keyPath: "/k"}, "echo hi");
        expect(args).toEqual(["ssh", "-i", "/k", "-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=30", "u@host", "echo hi"]);
    });

    it("omits the key flag and user prefix when not provided", () => {
        const args = sshArgs({host: "host"}, "ls");
        expect(args).not.toContain("-i");
        expect(args).toContain("host");
        expect(args[args.length - 1]).toBe("ls");
    });
});

describe("remoteEnginePath", () => {
    it("resolves current to the live build and a tag to its cached binary", () => {
        expect(remoteEnginePath("current", cfg)).toBe("/home/bot/jb/engines/jewkiebot/build/jewkiebot");
        expect(remoteEnginePath("", cfg)).toBe("/home/bot/jb/engines/jewkiebot/build/jewkiebot");
        expect(remoteEnginePath("v2.1.0", cfg)).toBe("/home/bot/jb/engines/jewkiebot/build/jewkiebot-v2.1.0");
    });
});

describe("buildVersionScript", () => {
    it("is a no-op for current", () => {
        expect(buildVersionScript("current", cfg)).toBe(`echo "current build"`);
    });

    it("short-circuits when cached and otherwise archives + cmake-builds the tag", () => {
        const s = buildVersionScript("v2.0.0", cfg);
        expect(s).toContain(`if [ -x "/home/bot/jb/engines/jewkiebot/build/jewkiebot-v2.0.0" ]; then echo "cached v2.0.0"; exit 0; fi`);
        expect(s).toContain(`git -C "/home/bot/jb" archive "v2.0.0" engines/jewkiebot`);
        expect(s).toContain(`-DENGINE_VERSION="v2.0.0"`);
        expect(s).toContain(`--target jewkiebot`);
    });
});

describe("cutechessCommand", () => {
    it("builds a two-games-per-round match with both engines, opening book, and pgnout", () => {
        const cmd = cutechessCommand({v1: "current", v2: "v2.0.0", games: 10, tc: "10+0.1", pgnOut: "/out/m.pgn"}, cfg);
        expect(cmd).toContain(`-engine name="Jewkiebot-current" cmd="/home/bot/jb/engines/jewkiebot/build/jewkiebot"`);
        expect(cmd).toContain(`-engine name="Jewkiebot-v2.0.0" cmd="/home/bot/jb/engines/jewkiebot/build/jewkiebot-v2.0.0"`);
        expect(cmd).toContain(`-rounds 5`); // ceil(10/2)
        expect(cmd).toContain(`-pgnout "/out/m.pgn"`);
        expect(cmd).toContain(`-openings file="/home/bot/jb/tools/book.epd"`);
        expect(cmd).toContain(`mkdir -p "$(dirname "/out/m.pgn")"`);
    });

    it("adds depth/nodes limits when given and omits the book when null", () => {
        const cmd = cutechessCommand({v1: "a", v2: "b", games: 2, depth: 8, pgnOut: "/p"}, {...cfg, openingBook: null});
        expect(cmd).toContain("depth=8");
        expect(cmd).not.toContain("-openings");
    });
});

describe("splitCompletedGames", () => {
    const g1 = `[Event "x"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 1-0`;
    const g2 = `[Event "x"]\n[Result "0-1"]\n\n1. d4 d5 0-1`;

    it("returns only games that have a result token", () => {
        const partial = `[Event "x"]\n[Result "*"]\n\n1. e4`;
        expect(splitCompletedGames(`${g1}\n\n${partial}`)).toEqual([g1]);
    });

    it("splits multiple completed games", () => {
        expect(splitCompletedGames(`${g1}\n\n${g2}`)).toEqual([g1, g2]);
    });

    it("handles empty input", () => {
        expect(splitCompletedGames("")).toEqual([]);
    });
});

describe("countFinishedGames / parseLatestElo", () => {
    it("counts finished-game lines", () => {
        expect(countFinishedGames("Finished game 1 (a vs b)\nFinished game 2 (b vs a)")).toBe(2);
        expect(countFinishedGames("nothing yet")).toBe(0);
    });

    it("returns the latest Elo difference", () => {
        const out = "Elo difference: 10.0 +/- 80.0\nElo difference: 25.5 +/- 60.2";
        expect(parseLatestElo(out)).toEqual({elo: 25.5, error: 60.2});
        expect(parseLatestElo("none")).toBeNull();
    });
});

describe("parseGhReleases", () => {
    it("prepends current and extracts version tags from gh output", () => {
        const out = "Release v2.1.0\tLatest\tv2.1.0\t2026-05-29\nv2.0.0\t\tv2.0.0\t2026-05-20";
        const versions = parseGhReleases(out);
        expect(versions[0]).toEqual({version: "current", label: "Current build", isCurrent: true});
        expect(versions.map(v => v.version)).toEqual(["current", "v2.1.0", "v2.0.0"]);
    });
});

describe("defaultRemoteConfig", () => {
    it("derives the opening book path from the repo dir", () => {
        const c = defaultRemoteConfig({REMOTE_REPO_DIR: "/srv/jb"} as any);
        expect(c.repoDir).toBe("/srv/jb");
        expect(c.openingBook).toBe("/srv/jb/tools/UHO_4060_v1.epd");
    });
});
