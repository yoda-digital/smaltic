#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";
import { createDb, migrate } from "./db/index.js";
import { RepositoryService, UserService, type TokenKind } from "./domain/repositories.js";

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else pos.push(a);
  }
  return { pos, flags };
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);
  const sql = createDb(loadConfig().databaseUrl);
  try {
    await migrate(sql);
    const repos = new RepositoryService(sql);
    if (cmd === "create-repo" && pos[0]) {
      const code = flags.locale ?? "en-us";
      const repo = await repos.create({ name: pos[0], masterLocale: { code, name: flags["locale-name"] ?? code } });
      console.log(`Created repository ${repo.name} (master locale ${code})`);
    } else if (cmd === "create-token" && pos[0]) {
      const kind = (flags.kind ?? "write") as TokenKind;
      if (kind !== "write" && kind !== "access") throw new Error("--kind must be write or access");
      const repo = await repos.getByName(pos[0]);
      if (!repo) throw new Error(`Repository not found: ${pos[0]}`);
      const { token } = await repos.createToken(repo.id, kind, flags.name ?? "cli");
      console.log(token);
    } else if (cmd === "create-user" && pos[0]) {
      const password = flags.password ?? randomBytes(12).toString("base64url");
      await new UserService(sql).create({ email: pos[0], password, name: flags.name });
      console.log(`Created user ${pos[0]}${flags.password ? "" : ` with password ${password}`}`);
    } else {
      console.error("Usage: smaltic create-repo <name> [--locale en-us] | create-token <repo> --kind write|access | create-user <email> [--password p]");
      return 1;
    }
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  } finally {
    await sql.end();
  }
}

process.exitCode = await main();
