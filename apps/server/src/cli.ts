#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";
import { createDb, migrate } from "./db/index.js";
import { RepositoryService, UserService, type TokenKind, type TokenScope, type Visibility } from "./domain/repositories.js";

const VISIBILITIES: Visibility[] = ["public", "private", "open"];
const SCOPES: TokenScope[] = ["master", "master+releases"];
const USAGE = [
  "Usage:",
  "  smaltic create-repo <name> [--locale en-us] [--locale-name English] [--visibility public|private|open]",
  "  smaltic add-locale <repo> <code> [--name Name]",
  "  smaltic create-token <repo> [--kind write|access] [--scope master|master+releases] [--name label]",
  "  smaltic create-user <email> [--password p] [--name Name]",
].join("\n");

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
      const visibility = (flags.visibility ?? "public") as Visibility;
      if (!VISIBILITIES.includes(visibility)) throw new Error(`--visibility must be one of ${VISIBILITIES.join(", ")}`);
      const repo = await repos.create({ name: pos[0], masterLocale: { code, name: flags["locale-name"] ?? code }, visibility });
      console.log(`Created repository ${repo.name} (master locale ${code}, ${visibility})`);
    } else if (cmd === "add-locale" && pos[0] && pos[1]) {
      const repo = await repos.getByName(pos[0]);
      if (!repo) throw new Error(`Repository not found: ${pos[0]}`);
      await repos.addLocale(repo.id, { code: pos[1], name: flags.name ?? pos[1] });
      console.log(`Added locale ${pos[1]} to ${repo.name}`);
    } else if (cmd === "create-token" && pos[0]) {
      const kind = (flags.kind ?? "write") as TokenKind;
      if (kind !== "write" && kind !== "access") throw new Error("--kind must be write or access");
      const scope = (flags.scope ?? "master") as TokenScope;
      if (!SCOPES.includes(scope)) throw new Error(`--scope must be one of ${SCOPES.join(", ")}`);
      const repo = await repos.getByName(pos[0]);
      if (!repo) throw new Error(`Repository not found: ${pos[0]}`);
      const { token } = await repos.createToken(repo.id, kind, flags.name ?? "cli", scope);
      console.log(token);
    } else if (cmd === "create-user" && pos[0]) {
      const password = flags.password ?? randomBytes(12).toString("base64url");
      await new UserService(sql).create({ email: pos[0], password, name: flags.name });
      console.log(`Created user ${pos[0]}${flags.password ? "" : ` with password ${password}`}`);
    } else {
      console.error(USAGE);
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
