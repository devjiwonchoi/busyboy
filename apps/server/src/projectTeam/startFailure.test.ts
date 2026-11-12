import { assert, describe, it } from "@effect/vitest";
import { requestMessageProblems } from "@t3tools/shared/requestMessage";

import {
  classifyStartFailure,
  redactTokens,
  startFailureAction,
  startFailureCard,
} from "./startFailure.ts";

const NO_TOKEN = "Cloud lead could not start: claude_oauth_token is not saved for the cloud.";

describe("start failures", () => {
  it("names a missing cloud token as something only a person can fix", () => {
    const failure = classifyStartFailure(NO_TOKEN, "cloud");
    assert.strictEqual(failure.kind, "cloud_credentials");
    assert.isTrue(failure.humanOnly);
    assert.strictEqual(failure.summary, "클라우드 로그인 토큰 없음");
  });

  it("retries on this Mac only when the setting allows it and the PM did not pin the cloud", () => {
    const failure = classifyStartFailure(NO_TOKEN, "cloud");
    const action = (policy: "local_only" | "local_first" | "cloud_first", pinned = false) =>
      startFailureAction({ failure, location: "cloud", policy, pinnedToCloud: pinned });
    assert.strictEqual(action("local_first"), "retry_local");
    assert.strictEqual(action("cloud_first"), "retry_local");
    assert.strictEqual(action("local_first", true), "notify");
    assert.strictEqual(action("local_only"), "notify");
    const local = classifyStartFailure("401 Unauthorized", "local");
    assert.strictEqual(local.kind, "provider_auth");
    assert.strictEqual(
      startFailureAction({
        failure: local,
        location: "local",
        policy: "local_first",
        pinnedToCloud: false,
      }),
      "notify",
    );
  });

  it("writes the card as one messenger message with the raw error folded away", () => {
    const card = startFailureCard({
      title: "빌드 속도",
      failure: classifyStartFailure(NO_TOKEN, "cloud"),
      location: "cloud",
      pinnedToCloud: true,
      error: NO_TOKEN,
    });
    assert.strictEqual(
      card.question.split("\n")[0],
      "클라우드 로그인 토큰이 없어 빌드 속도 리드를 시작하지 못했어요",
    );
    assert.deepStrictEqual(requestMessageProblems(card.question), []);
    assert.deepStrictEqual(card.details[1], { label: "오류", text: NO_TOKEN });
  });

  it("hides token-like strings in errors", () => {
    assert.strictEqual(redactTokens("bad token sk-ant-oat01-abcdefghijk"), "bad token [가림]");
  });
});
