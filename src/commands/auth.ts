/** The `auth` command. */

import type { Args } from "../args.ts";
import * as auth from "../storage/auth.ts";
import { CliExit, FAILED, OK, print } from "./context.ts";
import { idOption } from "./options.ts";
import { attach, browserView, requireSession } from "./shared.ts";
import type { CommandDef } from "./types.ts";

async function commandAuth(args: Args): Promise<number> {
  if (args.action === "list") {
    const names = auth.names();
    print(`SAVED LOGINS: ${names.length ? names.join(", ") : "(none)"}`);
    return OK;
  }
  if (!args.name) throw new CliExit(`auth ${args.action} needs a NAME`);
  auth.checkName(args.name);
  if (args.action === "delete") {
    if (!auth.remove(args.name)) {
      print(`No saved login ${args.name}`);
      return FAILED;
    }
    print(`DELETED login ${args.name}`);
    return OK;
  }
  const state = requireSession();
  const replaced = auth.exists(args.name);
  const browser = await attach(state, null, browserView(state));
  let storage: auth.StorageState;
  try {
    storage = await browser.storageState();
  } finally {
    await browser.close();
  }
  auth.save(args.name, storage);
  print(
    `${replaced ? "REPLACED" : "SAVED"} login ${args.name} (${auth.summary(auth.load(args.name))}). Use it with: start --auth ${args.name}`,
  );
  return OK;
}

export const authCommand: CommandDef = {
  name: "auth",
  session: (args) => args.action === "save",
  spec: () => ({
    help: "Saved logins: list, save NAME (from a session), delete NAME",
    options: [idOption()],
    positionals: [
      { name: "action", choices: ["list", "save", "delete"] },
      { name: "name", optional: true },
    ],
  }),
  run: commandAuth,
};
