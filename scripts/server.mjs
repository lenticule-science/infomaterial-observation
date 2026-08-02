#!/usr/bin/env node
import { dirname, resolve } from "node:path"; import { fileURLToPath } from "node:url"; import { serveContractedAgent } from "@red-cup-engineering/a2a-contracted-agent-service";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
serveContractedAgent({ port: Number(process.env.PORT ?? "8794"), host: process.env.HOST ?? "127.0.0.1", baseUrl: process.env.BASE_URL, agentCard: resolve(ROOT, "content/agent-cards/infomaterial-observation.json"), executor: process.execPath, executorArgs: [resolve(ROOT, "scripts/execute-a2a-task.mjs")] }).then(({ baseUrl }) => process.stdout.write(`${baseUrl}\n`)).catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
