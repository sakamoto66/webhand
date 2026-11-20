import { render } from "../output.ts";

import { OK, print } from "./context.ts";
import { openPage, requireSession } from "./shared.ts";

export async function commandObserve(): Promise<number> {
  const state = requireSession();
  await openPage(state);
  print(render(state.page));
  return OK;
}
