import {spawn} from "bun";
import {mkdir, writeFile} from "fs/promises";
import {join, resolve} from "path";
import {cpus} from "os";
import packageJson from "../../package.json";

const ENGINE_SOURCE = resolve("../../engines/jewkiebot");
const BUILD_ROOT = resolve("./builds");
const BACKEND_ENTRY = "../../server.js";
const EXECUTABLE_NAME = "jewkiebot";

async function run(cmd, cwd) {
    console.log(`> ${cmd.join(" ")}`);
    const proc = spawn({
        cmd,
        cwd,
        stdout: "inherit",
        stderr: "inherit",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        throw new Error(`Command failed with exit code ${exitCode}: ${cmd[0]}`);
    }
}

async function build() {
    const args = process.argv.slice(2);
    let finalVersion = packageJson.version;
    let description = "";

    const descIndex = args.indexOf("--desc");
    if (descIndex !== -1 && args[descIndex + 1]) {
        description = args[descIndex + 1];
        args.splice(descIndex, 2);
    }

    const versionRegex = /^\d+\.\d+\.\d+(-[\w\.]+)?$/;
    if (args[0] && versionRegex.test(args[0])) {
        finalVersion = args[0];
        console.log(`📌 Manual version override: ${finalVersion}`);
    } else {
        const parts = finalVersion.split(".").map(Number);
        if (parts.length === 3) {
            parts[2] += 1;
            finalVersion = parts.join(".");
            console.log(`🔄 Auto-incrementing to: ${finalVersion}`);
        } else {
            finalVersion = `${finalVersion}.1`;
        }
    }

    let folderSuffix = "";
    if (description) {
        const safeDesc = description
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
        folderSuffix = `-${safeDesc}`;
    }

    const versionFolderName = `build-${finalVersion}${folderSuffix}`;
    const versionDir = join(BUILD_ROOT, versionFolderName);
    const cmakeBuildDir = join(versionDir, "cmake-tmp");

    console.log(`🚀 Orchestrating Build: ${versionFolderName}`);

    await mkdir(cmakeBuildDir, {recursive: true});

    try {
        await run([
            "cmake",
            "-S", ENGINE_SOURCE,
            "-B", cmakeBuildDir,
            "-DCMAKE_BUILD_TYPE=Release",
        ], process.cwd());

        const coreCount = cpus().length.toString();
        await run([
            "cmake",
            "--build", cmakeBuildDir,
            "--config", "Release",
            "-j", coreCount,
        ], process.cwd());

        console.log("🍞 Bundling Bun Backend...");
        const bunBuild = await Bun.build({
            entrypoints: [BACKEND_ENTRY],
            outdir: versionDir,
            target: "bun",
        });

        if (!bunBuild.success) {
            throw new Error("Bun build failed: " + JSON.stringify(bunBuild.logs));
        }

        const builtEnginePath = join(cmakeBuildDir, EXECUTABLE_NAME);
        const finalEnginePath = join(versionDir, EXECUTABLE_NAME);

        await Bun.write(finalEnginePath, Bun.file(builtEnginePath));
        await run(["chmod", "+x", finalEnginePath], process.cwd());

        const metaData = {
            version: finalVersion,
            description: description || "None",
            buildDate: new Date().toISOString(),
            folder: versionFolderName,
            cmakeType: "Release",
        };
        await writeFile(join(versionDir, "meta.json"), JSON.stringify(metaData, null, 2));

        packageJson.version = finalVersion;
        await writeFile("package.json", JSON.stringify(packageJson, null, 2));

        console.log(`\n✅ Build Complete!`);
        console.log(`📂 Location: ${versionDir}`);

    } catch (error) {
        console.error("\n❌ Build Failed:", error.message);
        process.exit(1);
    }
}

build();