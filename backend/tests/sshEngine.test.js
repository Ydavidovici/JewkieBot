import { describe, it, expect, mock, beforeEach } from "bun:test";
import { SshUciEngine } from "../src/engineManager.js";
import { CutechessManager } from "../src/cutechessManager.js";

describe("SSH Execution Wrappers", () => {
    describe("SshUciEngine", () => {
        it("constructs the correct SSH command array when all config parameters are provided", () => {
            const sshConfig = {
                user: "testuser",
                host: "olddesktop",
                keyPath: "/path/to/key.pem",
                stockfishPath: "/home/testuser/stockfish"
            };

            const engine = new SshUciEngine(sshConfig);
            
            expect(engine.cmd[0]).toBe("ssh");
            expect(engine.cmd).toContain("-i");
            expect(engine.cmd).toContain("/path/to/key.pem");
            expect(engine.cmd).toContain("testuser@olddesktop");
            expect(engine.cmd).toContain("/home/testuser/stockfish");
        });

        it("constructs the correct SSH command array when keyPath and user are omitted (using ~/.ssh/config aliases)", () => {
            const sshConfig = {
                host: "olddesktop_alias",
                stockfishPath: "stockfish"
            };

            const engine = new SshUciEngine(sshConfig);
            
            expect(engine.cmd[0]).toBe("ssh");
            expect(engine.cmd).not.toContain("-i");
            expect(engine.cmd).toContain("olddesktop_alias");
            expect(engine.cmd).toContain("stockfish");
        });
    });

    describe("CutechessManager SSH Arguments", () => {
        let manager;
        
        beforeEach(() => {
            manager = new CutechessManager("cutechess-cli");
        });

        it("builds the correct engine args for cutechess when SSH config is fully provided", () => {
            const engineInfo = {
                name: "TestEngine",
                sshConfig: {
                    user: "admin",
                    host: "192.168.1.100",
                    keyPath: "~/.ssh/id_rsa",
                    stockfishPath: "engines/test.exe"
                }
            };

            const args = manager._buildEngineArgs(engineInfo);

            expect(args).toContain("-engine");
            expect(args).toContain("name=TestEngine");
            expect(args).toContain("cmd=ssh");
            expect(args).toContain("arg=-i");
            expect(args).toContain("arg=~/.ssh/id_rsa");
            expect(args).toContain("arg=admin@192.168.1.100");
            expect(args).toContain("arg=engines/test.exe");
        });

        it("builds the correct engine args when relying entirely on SSH config alias", () => {
            const engineInfo = {
                name: "TestEngine",
                sshConfig: {
                    host: "my-desktop",
                    stockfishPath: "/bin/test.exe"
                }
            };

            const args = manager._buildEngineArgs(engineInfo);

            expect(args).toContain("cmd=ssh");
            expect(args).not.toContain("arg=-i");
            expect(args).toContain("arg=my-desktop");
            expect(args).toContain("arg=/bin/test.exe");
        });
    });
});
