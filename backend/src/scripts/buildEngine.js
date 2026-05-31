// Build the C++ engine into the location the backend expects.
//
//   bun run build:engine            -> Release build at engines/jewkiebot/build/<exe>
//   bun run build:engine --debug    -> Debug build
//   bun run build:engine --prod     -> also copy the binary to backend/src/<exe>
//                                      (the path server.js auto-detects in prod mode)
//
// Cross-platform: lets CMake pick its default generator (override with the
// standard CMAKE_GENERATOR env var if you need MinGW/Ninja/etc).

import {spawn} from "bun";
import {cpus} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(__dirname, "../../../engines/jewkiebot");
const BUILD_DIR = path.join(ENGINE_ROOT, "build");
const EXE = process.platform === "win32" ? "jewkiebot.exe" : "jewkiebot";
const BUILT_BINARY = path.join(BUILD_DIR, EXE);
const PROD_DEST = path.resolve(__dirname, "..", EXE); // backend/src/<exe>

async function run(cmd) {
    console.log(`> ${cmd.join(" ")}`);
    const proc = spawn({cmd, stdout: "inherit", stderr: "inherit"});
    const code = await proc.exited;
    if (code !== 0) throw new Error(`Command failed (exit ${code}): ${cmd[0]}`);
}

async function main() {
    const args = process.argv.slice(2);
    const buildType = args.includes("--debug") ? "Debug" : "Release";
    const install = args.includes("--prod") || args.includes("--install");
    const jobs = String(cpus().length || 4);

    console.log(`Building engine (${buildType}) with ${jobs} jobs...`);

    const cmakeArgs = ["cmake", "-S", ENGINE_ROOT, "-B", BUILD_DIR, `-DCMAKE_BUILD_TYPE=${buildType}`];
    
    // Read version from package.json
    try {
        const pkgJson = await Bun.file(path.resolve(__dirname, "../../package.json")).json();
        if (pkgJson.version) {
            cmakeArgs.push(`-DENGINE_VERSION=${pkgJson.version}`);
        }
    } catch (err) {
        console.warn("Could not read package.json version, defaulting to dev.", err);
    }

    // Explicitly select the MinGW generator on Windows so it doesn't default to MSVC/NMake
    if (process.platform === "win32" && !process.env.CMAKE_GENERATOR) {
        cmakeArgs.push("-G", "MinGW Makefiles");
    }

    await run(cmakeArgs);
    await run(["cmake", "--build", BUILD_DIR, "--target", "jewkiebot", "-j", jobs]);

    if (!(await Bun.file(BUILT_BINARY).exists())) {
        throw new Error(`Build succeeded but binary missing at ${BUILT_BINARY}`);
    }
    console.log(`\n✅ Engine built: ${BUILT_BINARY}`);

    let enginePath = BUILT_BINARY;
    if (install) {
        await Bun.write(PROD_DEST, Bun.file(BUILT_BINARY));
        if (process.platform !== "win32") await run(["chmod", "+x", PROD_DEST]);
        enginePath = PROD_DEST;
        console.log(`📦 Installed to ${PROD_DEST}`);
    }

    console.log(`\nSet ENGINE_PATH for your systemd unit:\n  ENGINE_PATH=${enginePath}`);
}

main().catch((err) => {
    console.error(`\n❌ Engine build failed: ${err.message}`);
    process.exit(1);
});
