import { showBootError } from "./lib/bootError";
import { createRoot } from "react-dom/client";
import "./index.css";

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
void import("./main")
  .then(({ startup }) => startup)
  .then((app) => {
    if (app === null) {
      return;
    }
    createRoot(document.getElementById("root") as HTMLElement).render(app);
  })
  .catch(showBootError);
