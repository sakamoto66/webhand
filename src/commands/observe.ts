import { render } from "../output.ts";
import { OK, print } from "./context.ts";
import { idOption } from "./options.ts";
import { openPage, requireSession } from "./shared.ts";
import type { CommandDef } from "./types.ts";

async function commandObserve(): Promise<number> {
  const state = requireSession();
  await openPage(state);
  print(render(state.page));
  return OK;
}

export const observeCommand: CommandDef = {
  name: "observe",
  session: "required",
  spec: () => ({
    help: "Print the current page",
    options: [idOption()],
  }),
  run: commandObserve,
};
