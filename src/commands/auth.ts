/** The `auth` command. */

import type { Args } from "../args.ts";
import * as auth from "../auth.ts";
import * as session from "../session.ts";

import { CliExit, FAILED, OK, print } from "./context.ts";
import { attach, browserView, requireSession } from "./shared.ts";

export async function commandAuth(args: Args): Promise<number> {
  try {
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
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
}
