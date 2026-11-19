import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Secrets from "alchemy/Secrets";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { WriterSecrets } from "./src/deploymentConfig.ts";
import { Observability } from "./src/observability.ts";
import * as Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "T3TaskCache",
  {
    providers: Axiom.providers().pipe(Layer.provideMerge(Cloudflare.providers())),
    state: Cloudflare.state(),
    secrets: [Secrets.DotEnv(), Secrets.ProcessEnv(), WriterSecrets],
  },
  Effect.gen(function* () {
    const worker = yield* Worker.Worker;
    const observability = yield* Observability;
    return {
      url: worker.url,
      workerName: worker.workerName,
      dashboard: observability.dashboard.uid,
    };
  }).pipe(Effect.provide(Worker.layer), adopt(true)),
);
